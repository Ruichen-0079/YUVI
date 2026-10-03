"""Opt-in real CPU model gate. Never writes the daily acoustic profile store."""
import base64
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
import wave


@unittest.skipUnless(os.environ.get("YUVI_STT_MODEL_DIR"), "set YUVI_STT_MODEL_DIR for real model validation")
class LiveSpeechTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from server import SttEngine, _read_wav_bytes
        cls.temp = tempfile.TemporaryDirectory(prefix="yuvi-acoustic-gate-")
        cls.models = Path(os.environ["YUVI_STT_MODEL_DIR"])
        cls.engine = SttEngine(cls.models, 4, Path(cls.temp.name), 0.55)
        cls.read_wav = staticmethod(_read_wav_bytes)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def body(self, samples, rate=16000):
        import numpy as np
        raw = io.BytesIO()
        with wave.open(raw, "wb") as wav:
            wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
            wav.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())
        return {"audioBase64": base64.b64encode(raw.getvalue()).decode(), "mimeType": "audio/wav"}

    def command(self, operation, voice_profile_id, *, audio=None, label="Test profile", handle=None):
        key = handle or f"real:{operation}:{voice_profile_id}"
        command = {
            "commandHandle": key, "intentId": f"intent:{key}", "attemptId": f"attempt:{key}",
            "fence": "1", "payloadDigest": "e" * 64, "operation": operation,
            "voiceProfileId": voice_profile_id, "expectedRevision": self.engine.store.revision,
            "causalRefs": [{"kind": "JOURNAL_EVENT", "namespace": "real-test", "eventId": "control"}],
        }
        if operation == "ENROLL": command["label"] = label
        self.engine.fence_native_speaker_command({"command": command})
        return self.engine.handle_native_speaker_command({"command": command, **(audio or {})})

    def test_real_transcript_enrollment_later_match_restart_and_no_match(self):
        import numpy as np
        from speaker_store import SpeakerStore
        fixture = self.models / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/test_wavs/zh.wav"
        rate, samples = self.read_wav(fixture.read_bytes())
        result = self.engine.handle_transcribe({**self.body(samples, rate), "diarize": True, "identify": True})
        self.assertTrue(result["text"].strip())
        self.assertEqual(result["language"], "zh")
        for segment in result["segments"] or []:
            self.assertIn("text", segment)
        split = len(samples) // 2
        self.assertEqual(self.command("ENROLL", "gate-speaker", audio=self.body(samples[:split], rate))["status"], "APPLIED")
        later = self.engine.handle_identify(self.body(samples[split:], rate))
        self.assertEqual(later["voiceProfileMatch"], {"status": "MATCHED", "voiceProfileId": "gate-speaker"})
        self.engine.store = SpeakerStore(Path(self.temp.name), self.engine.extractor.dim, 0.55)
        self.assertEqual(self.engine.handle_identify(self.body(samples[split:], rate))["voiceProfileMatch"], later["voiceProfileMatch"])
        self.assertEqual(self.engine.handle_identify(self.body(np.zeros(32000)))["voiceProfileMatch"], {"status": "NO_MATCH"})
        manifest_path = Path(self.temp.name) / "speaker-manifest.json"
        manifest = __import__("json").loads(manifest_path.read_text())
        generation = Path(self.temp.name) / manifest["generation"]
        for path in (manifest_path, generation / "speakers.json", generation / "speakers.npz"):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.command("DELETE", "gate-speaker")["status"], "APPLIED")

    def test_mixed_capture_has_cluster_local_profiles_and_words(self):
        from speaker_store import collect_cluster_audio
        rate, samples = self.read_wav((self.models / "0-four-speakers-zh.wav").read_bytes())
        segments = self.engine.diarize(rate, samples)
        clips = collect_cluster_audio(samples, rate, segments)
        self.assertGreaterEqual(len(clips), 2)
        for cluster, clip in clips.items():
            with self.subTest(cluster=cluster):
                profile_id = f"gate-cluster-{cluster}"
                vector = self.engine.embed(rate, clip)
                store = self.engine.store
                command = {
                    "commandHandle": f"real:ENROLL:{profile_id}", "intentId": f"intent:{profile_id}",
                    "attemptId": f"attempt:{profile_id}", "fence": "1", "payloadDigest": "f" * 64,
                    "operation": "ENROLL", "voiceProfileId": profile_id, "expectedRevision": store.revision,
                    "label": "Test cluster", "causalRefs": [{"kind": "JOURNAL_EVENT", "namespace": "real-test", "eventId": "control"}],
                }
                store.fence_native_command(command)
                begun = store.begin_native_invocation(command)
                store.apply_native_command(command, vector)
                store.finish_native_invocation(begun["invocationKey"])
        result = self.engine.handle_transcribe({**self.body(samples, rate), "diarize": True, "identify": True})
        self.assertIsNone(result["voiceProfileMatch"])
        self.assertIsNone(result["identity"])
        matched = {}
        for segment in result["segments"]:
            self.assertIn("text", segment)
            match = segment["voiceProfileMatch"]
            self.assertEqual(match["status"], "MATCHED")
            matched.setdefault(segment["speaker"], set()).add(match["voiceProfileId"])
        self.assertTrue(all(len(ids) == 1 for ids in matched.values()))
        self.assertEqual(len({next(iter(ids)) for ids in matched.values()}), len(matched))
        self.assertEqual(self.engine.handle_identify(self.body(samples, rate))["voiceProfileMatch"], {"status": "NO_MATCH"})
        rejected = self.command("ENROLL", "mixed", audio=self.body(samples, rate), label="Invalid mixed enrollment")
        self.assertEqual(rejected["status"], "PROVEN_NOT_APPLIED")
        self.assertEqual(rejected["reason"], "MIXED_ACOUSTIC_SAMPLE")
        for cluster in clips:
            self.command("DELETE", f"gate-cluster-{cluster}")


if __name__ == "__main__":
    unittest.main()
