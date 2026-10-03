"""Acoustic voice-profile store for the local STT sidecar.

The persisted `speakerId` field is a legacy name for the durable acoustic
template identity (`voiceProfileId`). It is not a person id, not a
diarization cluster id, and not a display name.

This module owns embeddings and cosine matching only. It never stores or
returns personId, canonicalName, P8 identity, relationship, or trust.
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import stat
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import numpy as np

# Legacy persisted key. Mapped to provider-neutral voiceProfileId at the HTTP
# boundary. Do not migrate speakers.json/speakers.npz merely to rename this.
LEGACY_SPEAKER_ID_FIELD = "speakerId"

VOICE_PROFILE_MATCH_MATCHED = "MATCHED"
VOICE_PROFILE_MATCH_NO_MATCH = "NO_MATCH"

# Diarization min_duration_on is 0.3s; shorter cluster audio cannot be matched.
MIN_CLUSTER_DURATION_SEC = 0.3


class SpeakerStore:
    """Acoustic templates activated through a checksummed generation manifest."""

    def __init__(self, directory: Path, dim: int, threshold: float) -> None:
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)
        self.manifest_path = self.directory / "speaker-manifest.json"
        self.legacy_meta_path = self.directory / "speakers.json"
        self.legacy_vec_path = self.directory / "speakers.npz"
        self.dim = dim
        self.threshold = threshold
        self._condition = threading.Condition(threading.RLock())
        self.meta: dict[str, dict[str, str]] = {}
        self.vectors: dict[str, np.ndarray] = {}
        self.revision: str | None = None
        self.generation: str | None = None
        self.command_receipts: list[dict[str, Any]] = []
        self.command_fences: dict[str, dict[str, Any]] = {}
        self._in_flight: dict[str, int] = {}
        self.cleanup_errors: list[str] = []
        self._activation_uncertain = False
        self._load_or_migrate()

    @staticmethod
    def _json_bytes(value: Any) -> bytes:
        return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")

    @staticmethod
    def _file_digest(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _fsync_directory(path: Path) -> None:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    @staticmethod
    def _write_fsynced(path: Path, data: bytes) -> None:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "wb", closefd=False) as target:
                target.write(data)
                target.flush()
            os.fchmod(descriptor, 0o600)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _read_legacy(self) -> tuple[dict[str, dict[str, str]], dict[str, np.ndarray]]:
        metadata: dict[str, dict[str, str]] = {}
        vectors: dict[str, np.ndarray] = {}
        if self.legacy_meta_path.is_file():
            raw = json.loads(self.legacy_meta_path.read_text(encoding="utf-8"))
            speakers = raw.get("speakers") if isinstance(raw, dict) else []
            if not isinstance(speakers, list):
                raise ValueError("invalid legacy SpeakerStore metadata")
            for item in speakers:
                if isinstance(item, dict) and isinstance(item.get(LEGACY_SPEAKER_ID_FIELD), str):
                    speaker_id = item[LEGACY_SPEAKER_ID_FIELD]
                    metadata[speaker_id] = {
                        LEGACY_SPEAKER_ID_FIELD: speaker_id,
                        "label": str(item.get("label") or speaker_id),
                        "enrolledAt": str(item.get("enrolledAt") or ""),
                    }
        if self.legacy_vec_path.is_file():
            with np.load(self.legacy_vec_path, allow_pickle=False) as data:
                for key in data.files:
                    vectors[key] = np.asarray(data[key], dtype=np.float32)
        if set(metadata) != set(vectors):
            raise ValueError("legacy SpeakerStore metadata and vectors are incomplete")
        return metadata, vectors

    def _load_or_migrate(self) -> None:
        with self._condition:
            root_info = self.directory.lstat()
            if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode) or root_info.st_mode & 0o077:
                raise ValueError("SpeakerStore directory must be private and non-symlinked")
            if self.manifest_path.is_file():
                self._load_manifest(json.loads(self._read_private_file(self.manifest_path)))
                self._cleanup_orphan_generations()
                return
            metadata, vectors = self._read_legacy()
            revision = uuid.uuid4().hex
            self._activate_generation(metadata, vectors, revision, [], {}, activate_state=True)
            # Old files are migration inputs only. The manifest is the first
            # authoritative activation and is already durable before cleanup.
            for legacy in (self.legacy_meta_path, self.legacy_vec_path):
                try:
                    legacy.unlink(missing_ok=True)
                except OSError as error:
                    self.cleanup_errors.append(f"legacy cleanup: {error}")
            self._fsync_directory(self.directory)
            self._cleanup_orphan_generations()

    @staticmethod
    def _read_private_file(path: Path) -> str:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
                raise ValueError("SpeakerStore files must be private regular files")
            with os.fdopen(descriptor, "r", encoding="utf-8", closefd=False) as source:
                return source.read()
        finally:
            os.close(descriptor)

    def _cleanup_orphan_generations(self) -> None:
        self.cleanup_errors = []
        for legacy in (self.legacy_meta_path, self.legacy_vec_path):
            try:
                legacy.unlink(missing_ok=True)
            except OSError as error:
                self.cleanup_errors.append(f"legacy cleanup: {error}")
        for entry in self.directory.iterdir():
            if entry.name.startswith("generation-") and entry.name != self.generation:
                try:
                    if entry.is_dir() and not entry.is_symlink():
                        shutil.rmtree(entry)
                    else:
                        entry.unlink(missing_ok=True)
                    self._fsync_directory(self.directory)
                except OSError as error:
                    self.cleanup_errors.append(f"orphan generation cleanup: {error}")
            elif entry.name.startswith(".speaker-manifest-") and entry.name.endswith(".tmp"):
                try:
                    entry.unlink(missing_ok=True)
                except OSError as error:
                    self.cleanup_errors.append(f"manifest temporary cleanup: {error}")

    def _load_manifest(self, manifest: Any) -> None:
        if not isinstance(manifest, dict) or manifest.get("version") != 1:
            raise ValueError("invalid SpeakerStore manifest")
        revision = manifest.get("revision")
        generation = manifest.get("generation")
        metadata_name = manifest.get("metadataFile")
        vectors_name = manifest.get("vectorsFile")
        if (not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{32}", revision) or
                not isinstance(generation, str) or generation != f"generation-{revision}" or
                metadata_name != "speakers.json" or vectors_name != "speakers.npz"):
            raise ValueError("incomplete SpeakerStore manifest")
        generation_dir = self.directory / generation
        metadata_path = generation_dir / metadata_name
        vectors_path = generation_dir / vectors_name
        directory_info = generation_dir.lstat()
        if not stat.S_ISDIR(directory_info.st_mode) or stat.S_ISLNK(directory_info.st_mode) or directory_info.st_mode & 0o077:
            raise ValueError("SpeakerStore generation must be a private directory")
        for path in (metadata_path, vectors_path):
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_mode & 0o077:
                raise ValueError("SpeakerStore generation files must be private regular files")
        if self._file_digest(metadata_path) != manifest.get("metadataSha256") or self._file_digest(vectors_path) != manifest.get("vectorsSha256"):
            raise ValueError("SpeakerStore generation digest mismatch")
        metadata_raw = json.loads(self._read_private_file(metadata_path))
        speakers = metadata_raw.get("speakers") if isinstance(metadata_raw, dict) else None
        if not isinstance(speakers, list):
            raise ValueError("invalid SpeakerStore generation metadata")
        metadata: dict[str, dict[str, str]] = {}
        for item in speakers:
            if not isinstance(item, dict) or not isinstance(item.get(LEGACY_SPEAKER_ID_FIELD), str) or not isinstance(item.get("label"), str):
                raise ValueError("invalid SpeakerStore profile metadata")
            key = item[LEGACY_SPEAKER_ID_FIELD]
            metadata[key] = {LEGACY_SPEAKER_ID_FIELD: key, "label": item["label"], "enrolledAt": str(item.get("enrolledAt") or "")}
        with np.load(vectors_path, allow_pickle=False) as data:
            vectors = {key: np.asarray(data[key], dtype=np.float32) for key in data.files}
        if set(metadata) != set(vectors):
            raise ValueError("SpeakerStore generation is incomplete")
        receipts = manifest.get("commandReceipts", [])
        fences = manifest.get("commandFences", {})
        if not isinstance(receipts, list) or not isinstance(fences, dict):
            raise ValueError("invalid SpeakerStore command lineage")
        for receipt in receipts:
            if (not isinstance(receipt, dict) or
                    not all(isinstance(receipt.get(key), str) and receipt[key] for key in (
                        "commandHandle", "intentId", "attemptId", "fence", "payloadDigest", "operation", "voiceProfileId", "resultingRevision")) or
                    not re.fullmatch(r"[1-9][0-9]*", receipt["fence"]) or
                    not re.fullmatch(r"[a-f0-9]{64}", receipt["payloadDigest"]) or
                    receipt["operation"] not in ("ENROLL", "DELETE") or not isinstance(receipt.get("causalRefs"), list)):
                raise ValueError("invalid SpeakerStore command receipt")
        for handle, fence in fences.items():
            if (not isinstance(handle, str) or not handle or not isinstance(fence, dict) or
                    not all(isinstance(fence.get(key), str) and fence[key] for key in ("intentId", "attemptId", "fence", "payloadDigest")) or
                    not re.fullmatch(r"[1-9][0-9]*", fence["fence"]) or
                    not re.fullmatch(r"[a-f0-9]{64}", fence["payloadDigest"])):
                raise ValueError("invalid SpeakerStore command fence")
        self.meta, self.vectors = metadata, vectors
        self.revision, self.generation = revision, generation
        self.command_receipts = receipts
        self.command_fences = fences

    def _activate_generation(
        self,
        metadata: dict[str, dict[str, str]],
        vectors: dict[str, np.ndarray],
        revision: str,
        receipts: list[dict[str, Any]],
        fences: dict[str, dict[str, Any]],
        *,
        activate_state: bool,
    ) -> None:
        generation = f"generation-{revision}"
        generation_dir = self.directory / generation
        generation_dir.mkdir(mode=0o700)
        metadata_path = generation_dir / "speakers.json"
        vectors_path = generation_dir / "speakers.npz"
        self._write_fsynced(metadata_path, self._json_bytes({"speakers": [self.public(item) for item in metadata.values()]}))
        import io
        vector_buffer = io.BytesIO()
        np.savez(vector_buffer, **{key: value for key, value in vectors.items()})
        self._write_fsynced(vectors_path, vector_buffer.getvalue())
        self._fsync_directory(generation_dir)
        manifest = {
            "version": 1,
            "revision": revision,
            "generation": generation,
            "metadataFile": metadata_path.name,
            "metadataSha256": self._file_digest(metadata_path),
            "vectorsFile": vectors_path.name,
            "vectorsSha256": self._file_digest(vectors_path),
            "commandReceipts": receipts,
            "commandFences": fences,
        }
        tmp_manifest = self.directory / f".speaker-manifest-{uuid.uuid4().hex}.tmp"
        self._write_fsynced(tmp_manifest, self._json_bytes(manifest))
        os.replace(tmp_manifest, self.manifest_path)
        try:
            self._fsync_directory(self.directory)
        except OSError:
            self._activation_uncertain = True
            raise
        old_generation = self.generation
        if activate_state:
            self.meta, self.vectors = metadata, vectors
            self.revision, self.generation = revision, generation
            self.command_receipts, self.command_fences = receipts, fences
        if old_generation and old_generation != generation:
            try:
                old_dir = self.directory / old_generation
                for entry in old_dir.iterdir():
                    entry.unlink()
                old_dir.rmdir()
                self._fsync_directory(self.directory)
            except OSError as error:
                # The manifest already points at the new complete generation;
                # cleanup is diagnostic and never rolls the acoustic state back.
                self.cleanup_errors.append(f"generation cleanup: {error}")

    def _persist_manifest_only(self, receipts: list[dict[str, Any]], fences: dict[str, dict[str, Any]]) -> None:
        assert self.revision is not None and self.generation is not None
        generation_dir = self.directory / self.generation
        metadata_path = generation_dir / "speakers.json"
        vectors_path = generation_dir / "speakers.npz"
        manifest = {
            "version": 1,
            "revision": self.revision,
            "generation": self.generation,
            "metadataFile": metadata_path.name,
            "metadataSha256": self._file_digest(metadata_path),
            "vectorsFile": vectors_path.name,
            "vectorsSha256": self._file_digest(vectors_path),
            "commandReceipts": receipts,
            "commandFences": fences,
        }
        temp = self.directory / f".speaker-manifest-{uuid.uuid4().hex}.tmp"
        self._write_fsynced(temp, self._json_bytes(manifest))
        os.replace(temp, self.manifest_path)
        try:
            self._fsync_directory(self.directory)
        except OSError:
            self._activation_uncertain = True
            raise
        self.command_receipts, self.command_fences = receipts, fences

    def authority_snapshot(self) -> dict[str, Any]:
        with self._condition:
            return {
                "complete": not self._activation_uncertain,
                "revision": self.revision,
                "profiles": [self.public(item) for item in self.meta.values()],
                "cleanupPending": bool(self.cleanup_errors),
            }

    def _receipt(self, command: dict[str, Any]) -> dict[str, Any] | None:
        for receipt in self.command_receipts:
            if receipt.get("commandHandle") == command.get("commandHandle"):
                return receipt
        return None

    @staticmethod
    def _receipt_matches(receipt: dict[str, Any], command: dict[str, Any]) -> bool:
        return (
            all(receipt.get(key) == command.get(key) for key in (
                "commandHandle", "intentId", "attemptId", "payloadDigest", "operation", "voiceProfileId", "causalRefs"
            )) and int(str(receipt.get("fence", "0"))) <= int(str(command.get("fence", "0")))
        )

    def fence_native_command(self, command: dict[str, Any]) -> dict[str, str]:
        with self._condition:
            if self._activation_uncertain:
                return {"status": "UNKNOWN"}
            existing = self._receipt(command)
            if existing:
                return {"status": "APPLIED" if self._receipt_matches(existing, command) else "CONFLICT"}
            prior = self.command_fences.get(str(command.get("commandHandle")))
            if prior and prior.get("payloadDigest") != command.get("payloadDigest"):
                return {"status": "CONFLICT"}
            if prior:
                prior_fence = int(str(prior.get("fence", "0")))
                next_fence = int(str(command.get("fence", "0")))
                if prior_fence > next_fence:
                    return {"status": "UNKNOWN"}
                if prior_fence == next_fence and any(prior.get(key) != command.get(key) for key in ("intentId", "attemptId")):
                    return {"status": "CONFLICT"}
            fences = dict(self.command_fences)
            fences[str(command["commandHandle"])] = {key: command[key] for key in ("intentId", "attemptId", "fence", "payloadDigest")}
            self._persist_manifest_only(list(self.command_receipts), fences)
            return {"status": "READY"}

    def begin_native_invocation(self, command: dict[str, Any]) -> dict[str, str]:
        with self._condition:
            if self._activation_uncertain:
                return {"status": "UNKNOWN"}
            receipt = self._receipt(command)
            if receipt:
                return {"status": "ALREADY_APPLIED" if self._receipt_matches(receipt, command) else "CONFLICT"}
            fence = self.command_fences.get(str(command.get("commandHandle")))
            if not fence or any(fence.get(key) != command.get(key) for key in ("intentId", "attemptId", "fence", "payloadDigest")):
                return {"status": "CONFLICT"}
            key = f"{command['commandHandle']}:{command['attemptId']}"
            self._in_flight[key] = self._in_flight.get(key, 0) + 1
            return {"status": "STARTED", "invocationKey": key}

    def finish_native_invocation(self, invocation_key: str) -> None:
        with self._condition:
            remaining = self._in_flight.get(invocation_key, 0) - 1
            if remaining > 0:
                self._in_flight[invocation_key] = remaining
            else:
                self._in_flight.pop(invocation_key, None)
            self._condition.notify_all()

    def apply_native_command(self, command: dict[str, Any], embedding: np.ndarray | None = None) -> dict[str, Any]:
        with self._condition:
            if self._activation_uncertain:
                return {"status": "UNKNOWN"}
            existing = self._receipt(command)
            if existing:
                return {"status": "ALREADY_APPLIED", "receipt": existing} if self._receipt_matches(existing, command) else {"status": "CONFLICT"}
            fence = self.command_fences.get(str(command.get("commandHandle")))
            if not fence or any(fence.get(key) != command.get(key) for key in ("intentId", "attemptId", "fence", "payloadDigest")):
                return {"status": "CONFLICT"}
            invocation_key = f"{command['commandHandle']}:{command['attemptId']}"
            if self._in_flight.get(invocation_key, 0) == 0:
                return {"status": "CONFLICT"}
            if command.get("expectedRevision") != self.revision:
                return {"status": "CONFLICT", "reason": "REVISION_MISMATCH", "revision": self.revision}
            voice_id = str(command.get("voiceProfileId"))
            metadata, vectors = dict(self.meta), dict(self.vectors)
            if command.get("operation") == "ENROLL":
                if voice_id in metadata:
                    return {"status": "PROVEN_NOT_APPLIED", "reason": "PROFILE_EXISTS", "revision": self.revision}
                if embedding is None:
                    return {"status": "CONFLICT"}
                vector = np.asarray(embedding, dtype=np.float32).reshape(-1)
                if vector.size != self.dim:
                    return {"status": "CONFLICT"}
                metadata[voice_id] = {
                    LEGACY_SPEAKER_ID_FIELD: voice_id,
                    "label": str(command.get("label") or voice_id),
                    "enrolledAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
                vectors[voice_id] = vector.copy()
            elif command.get("operation") == "DELETE":
                if voice_id not in metadata:
                    return {"status": "PROVEN_NOT_APPLIED", "reason": "PROFILE_ABSENT", "revision": self.revision}
                metadata.pop(voice_id)
                vectors.pop(voice_id, None)
            else:
                return {"status": "CONFLICT"}
            prior_revision = self.revision
            resulting_revision = uuid.uuid4().hex
            receipt = {
                "commandHandle": command["commandHandle"],
                "intentId": command["intentId"],
                "attemptId": command["attemptId"],
                "fence": command["fence"],
                "payloadDigest": command["payloadDigest"],
                "operation": command["operation"],
                "voiceProfileId": voice_id,
                "priorRevision": prior_revision,
                "resultingRevision": resulting_revision,
                "causalRefs": command["causalRefs"],
            }
            receipts = [*self.command_receipts, receipt]
            self._activate_generation(metadata, vectors, resulting_revision, receipts, dict(self.command_fences), activate_state=True)
            self._cleanup_orphan_generations()
            return {"status": "APPLIED", "receipt": receipt, "cleanupPending": bool(self.cleanup_errors)}

    def reconcile_native_command(self, command: dict[str, Any]) -> dict[str, Any]:
        with self._condition:
            handle = str(command.get("commandHandle"))
            key_prefix = f"{handle}:"
            while any(key.startswith(key_prefix) for key in self._in_flight):
                self._condition.wait()
            if self._activation_uncertain:
                return {"status": "UNKNOWN"}
            receipt = self._receipt(command)
            if receipt:
                return {"status": "ALREADY_APPLIED", "receipt": receipt, "cleanupPending": bool(self.cleanup_errors)} if self._receipt_matches(receipt, command) else {"status": "CONFLICT"}
            fence = self.command_fences.get(handle)
            if not fence or any(fence.get(key) != command.get(key) for key in ("intentId", "attemptId", "fence", "payloadDigest")):
                return {"status": "UNKNOWN"}
            if self.revision == command.get("expectedRevision"):
                return {"status": "PROVEN_NOT_APPLIED", "reason": "EXACT_PREDECESSOR_REMAINS", "revision": self.revision}
            return {"status": "UNKNOWN"}

    def public(self, item: dict[str, str]) -> dict[str, str]:
        # Acoustic template public metadata. `label` is a sidecar presentation
        # string, never a person identity.
        return {
            LEGACY_SPEAKER_ID_FIELD: item[LEGACY_SPEAKER_ID_FIELD],
            "label": item["label"],
            "enrolledAt": item["enrolledAt"],
        }

    def list_public(self) -> list[dict[str, str]]:
        with self._condition:
            return [self.public(item) for item in self.meta.values()]

    def identify(self, embedding: np.ndarray) -> dict[str, Any]:
        vector = np.asarray(embedding, dtype=np.float32).reshape(-1)
        norm = np.linalg.norm(vector)
        if norm == 0:
            return {
                "identity": "UNKNOWN",
                LEGACY_SPEAKER_ID_FIELD: None,
                "label": None,
                "score": 0.0,
                "threshold": self.threshold,
            }
        vector = vector / norm
        best_id = None
        best_score = -1.0
        with self._condition:
            items = list(self.vectors.items())
            meta = dict(self.meta)
        for speaker_id, stored in items:
            stored_norm = np.linalg.norm(stored)
            if stored_norm == 0:
                continue
            score = float(np.dot(vector, stored / stored_norm))
            if score > best_score:
                best_score = score
                best_id = speaker_id
        if best_id is None or best_score < self.threshold:
            return {
                "identity": "UNKNOWN",
                LEGACY_SPEAKER_ID_FIELD: None,
                "label": None,
                "score": round(best_score, 4) if best_score >= 0 else None,
                "threshold": self.threshold,
            }
        return {
            "identity": "KNOWN",
            LEGACY_SPEAKER_ID_FIELD: best_id,
            "label": meta.get(best_id, {}).get("label"),
            "score": round(best_score, 4),
            "threshold": self.threshold,
        }


def voice_profile_match_from_identify(result: dict[str, Any] | None) -> dict[str, Any]:
    """Map a legacy identify() result to provider-neutral acoustic evidence.

    Numeric score/threshold stay on the legacy identify payload for sidecar
    diagnostics and are deliberately omitted here. Similarity is not person
    truth.
    """

    if not isinstance(result, dict):
        return {"status": VOICE_PROFILE_MATCH_NO_MATCH}
    speaker_id = result.get(LEGACY_SPEAKER_ID_FIELD)
    if result.get("identity") == "KNOWN" and isinstance(speaker_id, str) and speaker_id.strip():
        return {
            "status": VOICE_PROFILE_MATCH_MATCHED,
            "voiceProfileId": speaker_id.strip(),
        }
    return {"status": VOICE_PROFILE_MATCH_NO_MATCH}


def unique_cluster_ids(segments: list[dict[str, Any]] | None) -> list[str]:
    if not segments:
        return []
    seen: list[str] = []
    for item in segments:
        speaker = item.get("speaker")
        if speaker is None:
            continue
        cluster_id = str(speaker)
        if cluster_id not in seen:
            seen.append(cluster_id)
    return seen


def is_mixed_capture(segments: list[dict[str, Any]] | None) -> bool:
    return len(unique_cluster_ids(segments)) > 1


def collect_cluster_audio(
    samples: np.ndarray,
    sample_rate: int,
    segments: list[dict[str, Any]],
) -> dict[str, np.ndarray]:
    """Concatenate each capture-local cluster's time spans. No second diarization."""

    audio = np.asarray(samples, dtype=np.float32).reshape(-1)
    grouped: dict[str, list[np.ndarray]] = {}
    for item in segments:
        speaker = item.get("speaker")
        if speaker is None:
            continue
        cluster_id = str(speaker)
        start_ms = item.get("startMs")
        end_ms = item.get("endMs")
        if not isinstance(start_ms, (int, float)) or not isinstance(end_ms, (int, float)):
            continue
        start = max(0, int(float(start_ms) / 1000.0 * sample_rate))
        end = min(audio.shape[0], int(float(end_ms) / 1000.0 * sample_rate))
        if end <= start:
            continue
        grouped.setdefault(cluster_id, []).append(audio[start:end])
    return {cluster_id: np.concatenate(clips) for cluster_id, clips in grouped.items() if clips}


def cluster_audio_is_matchable(clip: np.ndarray, sample_rate: int) -> bool:
    if clip.size <= 0 or sample_rate <= 0:
        return False
    return (clip.size / float(sample_rate)) >= MIN_CLUSTER_DURATION_SEC


def attach_cluster_voice_profile_matches(
    segments: list[dict[str, Any]],
    matches_by_cluster: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    attached: list[dict[str, Any]] = []
    for item in segments:
        speaker = item.get("speaker")
        cluster_id = str(speaker) if speaker is not None else ""
        match = matches_by_cluster.get(cluster_id) or {"status": VOICE_PROFILE_MATCH_NO_MATCH}
        attached.append({**item, "voiceProfileMatch": match})
    return attached
