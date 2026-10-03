#!/usr/bin/env python3
"""YUVI local CPU STT + acoustic voice-profile sidecar (sherpa-onnx).

Process/service lifecycle only. Does not route Character or Cognition.
Never logs or returns raw speaker embeddings.

The persisted SpeakerStore `speakerId` is a legacy name for the acoustic
template identity (`voiceProfileId`). Sidecar outputs never include personId,
canonicalName, P8 identity, relationship, or trust.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("OMP_NUM_THREADS", "4")

import numpy as np
import sherpa_onnx

from speaker_store import (
    SpeakerStore,
    attach_cluster_voice_profile_matches,
    cluster_audio_is_matchable,
    collect_cluster_audio,
    is_mixed_capture,
    unique_cluster_ids,
    voice_profile_match_from_identify,
)


class VadUnavailable(RuntimeError):
    """Sidecar is up, but Silero VAD weights are not provisioned."""


def _cpu_threads(requested: int) -> int:
    cpu = os.cpu_count() or 4
    cap = max(1, cpu // 4)
    return max(1, min(requested, cap, 4))


def _read_wav_bytes(payload: bytes) -> tuple[int, np.ndarray]:
    with wave.open(io.BytesIO(payload), "rb") as handle:
        channels = handle.getnchannels()
        sample_width = handle.getsampwidth()
        sample_rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
    if sample_width == 2:
        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    elif sample_width == 4:
        audio = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError("only 16-bit or 32-bit PCM WAV is supported")
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return sample_rate, np.ascontiguousarray(audio)


def _decode_audio(audio_base64: str, mime_type: str) -> tuple[int, np.ndarray]:
    raw = base64.b64decode(audio_base64)
    mime = (mime_type or "audio/wav").lower()
    if "wav" in mime or raw[:4] == b"RIFF":
        return _read_wav_bytes(raw)
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as src:
        src.write(raw)
        src_path = src.name
    dst_path = src_path + ".wav"
    try:
        import subprocess

        completed = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                src_path,
                "-ac",
                "1",
                "-ar",
                "16000",
                "-f",
                "wav",
                dst_path,
            ],
            check=False,
            capture_output=True,
            timeout=30,
        )
        if completed.returncode != 0:
            raise ValueError("ffmpeg could not decode audio")
        return _read_wav_bytes(Path(dst_path).read_bytes())
    finally:
        for path in (src_path, dst_path):
            try:
                os.unlink(path)
            except OSError:
                pass


def _resample(samples: np.ndarray, from_rate: int, to_rate: int) -> np.ndarray:
    if from_rate == to_rate:
        return samples
    duration = samples.shape[0] / float(from_rate)
    target = int(duration * to_rate)
    if target <= 1:
        return samples.astype(np.float32)
    x_old = np.linspace(0.0, 1.0, num=samples.shape[0], endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=target, endpoint=False)
    return np.interp(x_new, x_old, samples).astype(np.float32)


class SttEngine:
    def __init__(self, model_dir: Path, threads: int, speaker_dir: Path, threshold: float) -> None:
        self.threads = _cpu_threads(threads)
        self.model_dir = model_dir
        sense_dir = self._find_dir(["sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", "sense-voice"])
        tokens = sense_dir / "tokens.txt"
        model = sense_dir / "model.int8.onnx"
        if not model.is_file():
            model = sense_dir / "model.onnx"
        embedding_model = model_dir / "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
        if not embedding_model.is_file():
            matches = list(model_dir.rglob("3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"))
            if not matches:
                raise FileNotFoundError("speaker embedding model missing")
            embedding_model = matches[0]
        seg_dir = self._find_dir(["sherpa-onnx-pyannote-segmentation-3-0", "pyannote"])
        seg_model = seg_dir / "model.onnx"
        self.asr_model = str(model)
        self.tokens = str(tokens)
        self.embedding_model = str(embedding_model)
        self.segmentation_model = str(seg_model)
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=self.asr_model,
            tokens=self.tokens,
            num_threads=self.threads,
            use_itn=True,
            debug=False,
            language="",
            provider="cpu",
        )
        self.extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=self.embedding_model,
                num_threads=self.threads,
                debug=False,
                provider="cpu",
            )
        )
        self.diarization = sherpa_onnx.OfflineSpeakerDiarization(
            sherpa_onnx.OfflineSpeakerDiarizationConfig(
                segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                    pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                        model=self.segmentation_model
                    ),
                    num_threads=self.threads,
                    debug=False,
                    provider="cpu",
                ),
                embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                    model=self.embedding_model,
                    num_threads=self.threads,
                    debug=False,
                    provider="cpu",
                ),
                clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.5),
                min_duration_on=0.3,
                min_duration_off=0.5,
            )
        )
        self.store = SpeakerStore(speaker_dir, dim=self.extractor.dim, threshold=threshold)
        self._lock = threading.Lock()
        self.vad_model = self._find_vad_model()
        self._vad_sessions: dict[str, Any] = {}
        self._vad_lock = threading.Lock()

    def _find_vad_model(self) -> Path | None:
        names = ("silero_vad.onnx", "silero_vad_v5.onnx")
        for name in names:
            candidate = self.model_dir / name
            if candidate.is_file():
                return candidate
        if not self.model_dir.is_dir():
            return None
        for name in names:
            matches = list(self.model_dir.rglob(name))
            if matches:
                return matches[0]
        return None

    def _create_vad(self) -> Any:
        if self.vad_model is None:
            raise FileNotFoundError("silero_vad.onnx missing")
        config = sherpa_onnx.VadModelConfig()
        config.silero_vad.model = str(self.vad_model)
        config.silero_vad.threshold = 0.5
        config.silero_vad.min_silence_duration = 0.25
        config.silero_vad.min_speech_duration = 0.15
        config.sample_rate = 16000
        config.num_threads = 1
        config.provider = "cpu"
        return sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=20)

    def _vad_is_active(self, vad: Any) -> bool:
        detected = getattr(vad, "is_speech_detected", None)
        if callable(detected):
            return bool(detected())
        if detected is not None:
            return bool(detected)
        empty = getattr(vad, "empty", None)
        if empty is None:
            return False
        return not bool(empty() if callable(empty) else empty)

    def handle_vad(self, body: dict[str, Any]) -> dict[str, Any]:
        if self.vad_model is None:
            raise VadUnavailable("Silero VAD model is not provisioned")
        capture_epoch = str(body.get("captureEpoch") or "").strip()
        if not capture_epoch:
            raise ValueError("captureEpoch is required")
        pcm_b64 = str(body.get("pcmBase64") or "")
        if not pcm_b64:
            raise ValueError("pcmBase64 is required")
        sample_rate = int(body.get("sampleRate") or 16000)
        raw = base64.b64decode(pcm_b64)
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        samples = _resample(samples, sample_rate, 16000)
        with self._vad_lock:
            vad = self._vad_sessions.get(capture_epoch)
            if vad is None:
                vad = self._create_vad()
                self._vad_sessions[capture_epoch] = vad
                while len(self._vad_sessions) > 8:
                    self._vad_sessions.pop(next(iter(self._vad_sessions)))
            vad.accept_waveform(samples)
            active = self._vad_is_active(vad)
            # Activity-only path: completed audio spans are owned by browser capture.
            # Drain Silero's segment queue across continuous conversations.
            if hasattr(vad, "pop") and hasattr(vad, "empty"):
                while not vad.empty():
                    vad.pop()
        return {"active": active, "captureEpoch": capture_epoch}

    def _find_dir(self, names: list[str]) -> Path:
        for name in names:
            candidate = self.model_dir / name
            if candidate.is_dir():
                return candidate
        for child in self.model_dir.iterdir() if self.model_dir.is_dir() else []:
            if child.is_dir() and any(token in child.name for token in names):
                return child
        raise FileNotFoundError(f"model directory not found for {names}")

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "service": "yuvi-local-stt",
            "provider": "cpu",
            "threads": self.threads,
            "asrModel": Path(self.asr_model).name,
            "speakerModel": Path(self.embedding_model).name,
            "diarizationModel": Path(self.segmentation_model).name,
            "speakerCount": len(self.store.list_public()),
            "gpu": False,
            "vad": self.vad_model is not None,
            "vadModel": None if self.vad_model is None else self.vad_model.name,
        }

    def embed(self, sample_rate: int, samples: np.ndarray) -> np.ndarray:
        audio = _resample(samples, sample_rate, 16000)
        stream = self.extractor.create_stream()
        stream.accept_waveform(16000, audio)
        stream.input_finished()
        if not self.extractor.is_ready(stream):
            raise ValueError("recording is too short for a speaker embedding")
        embedding = np.asarray(self.extractor.compute(stream), dtype=np.float32)
        return embedding

    def transcribe(self, sample_rate: int, samples: np.ndarray, language: str | None) -> dict[str, Any]:
        audio = _resample(samples, sample_rate, 16000)
        stream = self.recognizer.create_stream()
        stream.accept_waveform(16000, audio)
        self.recognizer.decode_stream(stream)
        result = stream.result
        text = getattr(result, "text", "") or ""
        lang = language or getattr(result, "lang", None) or getattr(result, "language", None)
        if isinstance(lang, str) and lang.startswith("<|") and lang.endswith("|>"):
            lang = lang[2:-2]
        return {"text": text, "language": lang}

    def diarize(self, sample_rate: int, samples: np.ndarray) -> list[dict[str, Any]]:
        audio = _resample(samples, sample_rate, 16000)
        result = self.diarization.process(audio)
        ordered = result.sort_by_start_time() if hasattr(result, "sort_by_start_time") else result
        segments = []
        for item in ordered:
            segments.append(
                {
                    "startMs": int(float(item.start) * 1000),
                    "endMs": int(float(item.end) * 1000),
                    "speaker": str(item.speaker),
                }
            )
        return segments

    def identify_clusters(
        self, sample_rate: int, samples: np.ndarray, segments: list[dict[str, Any]]
    ) -> dict[str, dict[str, Any]]:
        """Cluster-scoped acoustic match. Never apply one mixed-audio match to all clusters."""

        audio = _resample(samples, sample_rate, 16000)
        clips = collect_cluster_audio(audio, 16000, segments)
        matches: dict[str, dict[str, Any]] = {}
        for cluster_id in unique_cluster_ids(segments):
            clip = clips.get(cluster_id)
            if clip is None or not cluster_audio_is_matchable(clip, 16000):
                matches[cluster_id] = voice_profile_match_from_identify(None)
                continue
            matches[cluster_id] = voice_profile_match_from_identify(self.store.identify(self.embed(16000, clip)))
        return matches

    def handle_transcribe(self, body: dict[str, Any]) -> dict[str, Any]:
        sample_rate, samples = _decode_audio(str(body.get("audioBase64") or ""), str(body.get("mimeType") or "audio/wav"))
        with self._lock:
            started = time.perf_counter()
            asr = self.transcribe(sample_rate, samples, body.get("language") if isinstance(body.get("language"), str) else None)
            segments = self.diarize(sample_rate, samples) if body.get("diarize") else None
            if segments:
                # Attribute words using each diarized span's audio, never the
                # whole transcript. Overlapping spans remain explicitly timed.
                for segment in segments or []:
                    start = int(segment["startMs"] * sample_rate / 1000)
                    end = int(segment["endMs"] * sample_rate / 1000)
                    segment["text"] = (asr["text"] if len(segments) == 1 else
                                       self.transcribe(sample_rate, samples[start:end], None)["text"])
            identity = None
            voice_profile_match = None
            if body.get("identify"):
                if is_mixed_capture(segments):
                    # Mixed capture: cluster-scoped match only. Whole-audio identify
                    # would smear one template onto every speaker.
                    cluster_matches = self.identify_clusters(sample_rate, samples, segments or [])
                    segments = attach_cluster_voice_profile_matches(segments or [], cluster_matches)
                else:
                    identity = self.store.identify(self.embed(sample_rate, samples))
                    voice_profile_match = voice_profile_match_from_identify(identity)
                    if segments and unique_cluster_ids(segments):
                        cluster_id = unique_cluster_ids(segments)[0]
                        segments = attach_cluster_voice_profile_matches(segments, {cluster_id: voice_profile_match})
        return {
            "text": asr["text"],
            "language": asr["language"],
            "identity": identity,
            "voiceProfileMatch": voice_profile_match,
            "segments": segments,
            "latencyMs": int((time.perf_counter() - started) * 1000),
            "device": "cpu",
        }

    def handle_enroll(self, body: dict[str, Any]) -> dict[str, Any]:
        raise ValueError("governed acoustic command required")

    def handle_native_speaker_command(self, body: dict[str, Any]) -> dict[str, Any]:
        command = body.get("command")
        if not isinstance(command, dict):
            raise ValueError("native speaker command required")
        required = ("commandHandle", "intentId", "attemptId", "fence", "payloadDigest", "operation", "voiceProfileId", "expectedRevision", "causalRefs")
        if any(not isinstance(command.get(key), str) or not command[key] for key in required[:7]) or not isinstance(command.get("causalRefs"), list):
            raise ValueError("invalid native speaker command")
        begun = self.store.begin_native_invocation(command)
        if begun["status"] == "ALREADY_APPLIED":
            return self.store.reconcile_native_command(command)
        if begun["status"] != "STARTED":
            return {"status": begun["status"]}
        invocation_key = begun["invocationKey"]
        try:
            embedding = None
            if command["operation"] == "ENROLL":
                sample_rate, samples = _decode_audio(str(body.get("audioBase64") or ""), str(body.get("mimeType") or "audio/wav"))
                if samples.size < sample_rate or float(np.max(np.abs(samples), initial=0)) < 0.005:
                    return {"status": "PROVEN_NOT_APPLIED", "reason": "INVALID_ACOUSTIC_SAMPLE", "revision": self.store.revision}
                with self._lock:
                    if is_mixed_capture(self.diarize(sample_rate, samples)):
                        return {"status": "PROVEN_NOT_APPLIED", "reason": "MIXED_ACOUSTIC_SAMPLE", "revision": self.store.revision}
                    embedding = self.embed(sample_rate, samples)
            return self.store.apply_native_command(command, embedding)
        finally:
            self.store.finish_native_invocation(invocation_key)

    def fence_native_speaker_command(self, body: dict[str, Any]) -> dict[str, str]:
        command = body.get("command")
        if not isinstance(command, dict):
            raise ValueError("native speaker command required")
        return self.store.fence_native_command(command)

    def reconcile_native_speaker_command(self, body: dict[str, Any]) -> dict[str, Any]:
        command = body.get("command")
        if not isinstance(command, dict):
            raise ValueError("native speaker command required")
        return self.store.reconcile_native_command(command)

    def handle_identify(self, body: dict[str, Any]) -> dict[str, Any]:
        sample_rate, samples = _decode_audio(str(body.get("audioBase64") or ""), str(body.get("mimeType") or "audio/wav"))
        with self._lock:
            if samples.size < sample_rate or float(np.max(np.abs(samples), initial=0)) < 0.005:
                return {"voiceProfileMatch": {"status": "NO_MATCH"}}
            if is_mixed_capture(self.diarize(sample_rate, samples)):
                return {"voiceProfileMatch": {"status": "NO_MATCH"}}
            embedding = self.embed(sample_rate, samples)
            result = self.store.identify(embedding)
        return {**result, "voiceProfileMatch": voice_profile_match_from_identify(result)}


def _public_json(value: Any) -> Any:
    """Drop raw embedding fields before any HTTP or log serialization."""

    if isinstance(value, dict):
        return {
            key: _public_json(item)
            for key, item in value.items()
            if key not in {"embedding", "rawEmbedding", "embeddings", "vector", "waveform"}
        }
    if isinstance(value, list):
        return [_public_json(item) for item in value]
    return value


ENGINE: SttEngine | None = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(_public_json(payload), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length") or "0")
        if length > 25_000_000:
            raise ValueError("request too large")
        raw = self.rfile.read(length) if length else b"{}"
        data = json.loads(raw.decode("utf-8") or "{}")
        if not isinstance(data, dict):
            raise ValueError("JSON object required")
        return data

    def do_GET(self) -> None:  # noqa: N802
        engine = ENGINE
        if engine is None:
            self._json(503, {"ok": False, "error": "not_ready"})
            return
        if self.path == "/health":
            self._json(200, engine.health())
            return
        if self.path == "/speakers":
            snapshot = engine.store.authority_snapshot()
            self._json(200, {
                "speakers": snapshot["profiles"], "revision": snapshot["revision"],
                "complete": snapshot["complete"], "cleanupPending": snapshot["cleanupPending"]
            })
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        engine = ENGINE
        if engine is None:
            self._json(503, {"ok": False, "error": "not_ready"})
            return
        try:
            body = self._read_json()
            if self.path == "/transcribe":
                self._json(200, engine.handle_transcribe(body))
                return
            if self.path == "/vad":
                self._json(200, engine.handle_vad(body))
                return
            if self.path == "/identify":
                self._json(200, engine.handle_identify(body))
                return
            if self.path == "/speakers":
                self._json(409, {"error": "governed_acoustic_command_required"})
                return
            if self.path == "/speakers/commands/fence":
                self._json(200, engine.fence_native_speaker_command(body))
                return
            if self.path == "/speakers/commands":
                self._json(200, engine.handle_native_speaker_command(body))
                return
            if self.path == "/speakers/commands/reconcile":
                self._json(200, engine.reconcile_native_speaker_command(body))
                return
            self._json(404, {"error": "not_found"})
        except VadUnavailable as exc:
            self._json(503, {"error": "vad_unavailable", "message": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._json(400, {"error": "bad_request", "message": str(exc)})

    def do_DELETE(self) -> None:  # noqa: N802
        engine = ENGINE
        if engine is None:
            self._json(503, {"ok": False, "error": "not_ready"})
            return
        self._json(409, {"error": "governed_acoustic_command_required"})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9876)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--threshold", type=float, default=0.55)
    parser.add_argument("--yuvi-local-stt", action="store_true")
    args = parser.parse_args()
    speaker_dir = Path(os.environ.get("YUVI_STT_SPEAKER_DIR", str(Path(args.model_dir) / "speakers")))
    global ENGINE
    ENGINE = SttEngine(Path(args.model_dir), args.threads, speaker_dir, args.threshold)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    sys.stderr.write(
        "yuvi-local-stt listening on http://%s:%s threads=%s\n" % (args.host, args.port, ENGINE.threads)
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
