import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from speaker_store import (  # noqa: E402
    SpeakerStore,
    attach_cluster_voice_profile_matches,
    cluster_audio_is_matchable,
    collect_cluster_audio,
    is_mixed_capture,
    unique_cluster_ids,
    voice_profile_match_from_identify,
)


def unit(index: int, dim: int = 4) -> np.ndarray:
    vector = np.zeros(dim, dtype=np.float32)
    vector[index] = 1.0
    return vector


def native_command(store: SpeakerStore, operation: str, speaker_id: str, embedding=None, handle: str | None = None):
    key = handle or f"test:{operation}:{speaker_id}"
    command = {
        "commandHandle": key,
        "intentId": f"intent:{key}",
        "attemptId": f"attempt:{key}",
        "fence": "1",
        "payloadDigest": "a" * 64,
        "operation": operation,
        "voiceProfileId": speaker_id,
        "expectedRevision": store.revision,
        "causalRefs": [{"kind": "JOURNAL_EVENT", "namespace": "test", "eventId": "control"}],
    }
    if operation == "ENROLL": command["label"] = "test label"
    assert store.fence_native_command(command)["status"] == "READY"
    begun = store.begin_native_invocation(command)
    assert begun["status"] == "STARTED"
    try:
        return store.apply_native_command(command, embedding)
    finally:
        store.finish_native_invocation(begun["invocationKey"])


class SpeakerStoreTests(unittest.TestCase):
    def test_enrolled_profile_matches_same_vector(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = SpeakerStore(Path(tmp), dim=4, threshold=0.55)
            native_command(store, "ENROLL", "vp_7", unit(0))
            result = store.identify(unit(0))
            self.assertEqual(result["identity"], "KNOWN")
            self.assertEqual(result["speakerId"], "vp_7")
            match = voice_profile_match_from_identify(result)
            self.assertEqual(match, {"status": "MATCHED", "voiceProfileId": "vp_7"})
            self.assertNotIn("score", match)
            self.assertNotIn("personId", match)

    def test_below_threshold_is_no_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = SpeakerStore(Path(tmp), dim=4, threshold=0.95)
            native_command(store, "ENROLL", "vp_7", unit(0))
            other = unit(0) * 0.1 + unit(1) * 0.9
            result = store.identify(other)
            self.assertEqual(result["identity"], "UNKNOWN")
            self.assertIsNone(result["speakerId"])
            self.assertEqual(voice_profile_match_from_identify(result), {"status": "NO_MATCH"})

    def test_persisted_vectors_reload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            first = SpeakerStore(directory, dim=4, threshold=0.55)
            native_command(first, "ENROLL", "vp_7", unit(2))
            manifest = json.loads((directory / "speaker-manifest.json").read_text(encoding="utf-8"))
            generation = directory / manifest["generation"]
            self.assertEqual(stat.S_IMODE(os.stat(directory / "speaker-manifest.json").st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(os.stat(generation / "speakers.json").st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(os.stat(generation / "speakers.npz").st_mode), 0o600)
            payload = json.loads((generation / "speakers.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["speakers"][0]["speakerId"], "vp_7")
            self.assertNotIn("embedding", json.dumps(payload))
            self.assertEqual(manifest["commandReceipts"][0]["resultingRevision"], manifest["revision"])
            restarted = SpeakerStore(directory, dim=4, threshold=0.55)
            self.assertEqual(restarted.revision, manifest["revision"])
            result = restarted.identify(unit(2))
            self.assertEqual(result["speakerId"], "vp_7")

    def test_legacy_speaker_id_is_not_a_person_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = SpeakerStore(Path(tmp), dim=4, threshold=0.55)
            native_command(store, "ENROLL", "ruichen", unit(1))
            result = store.identify(unit(1))
            match = voice_profile_match_from_identify(result)
            self.assertEqual(match["voiceProfileId"], "ruichen")
            self.assertNotEqual(match["voiceProfileId"], "person_ruichen")
            public = store.list_public()[0]
            self.assertNotIn("personId", public)
            serialized = json.dumps({"identify": result, "match": match, "public": public})
            self.assertNotIn("personId", serialized)
            self.assertNotIn("canonicalName", serialized)

    def test_command_replay_and_incompatible_reuse_are_never_mutations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = SpeakerStore(Path(tmp), dim=4, threshold=0.55)
            result = native_command(store, "ENROLL", "vp_7", unit(0), "stable-handle")
            receipt = result["receipt"]
            before = store.revision
            exact = {**receipt, "expectedRevision": None}
            self.assertEqual(store.reconcile_native_command(exact)["status"], "ALREADY_APPLIED")
            recovered = {**exact, "fence": "2"}
            self.assertEqual(store.fence_native_command(recovered)["status"], "APPLIED")
            self.assertEqual(store.reconcile_native_command(recovered)["status"], "ALREADY_APPLIED")
            altered = {**exact, "payloadDigest": "b" * 64}
            self.assertEqual(store.reconcile_native_command(altered)["status"], "CONFLICT")
            self.assertEqual(store.revision, before)
            self.assertEqual(len(store.command_receipts), 1)

    def test_changed_owner_revision_is_not_proven_as_exact_predecessor(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = SpeakerStore(Path(tmp), dim=4, threshold=0.55)
            stale_revision = store.revision
            native_command(store, "ENROLL", "first", unit(0))
            command = {
                "commandHandle": "stale-owner-revision", "intentId": "intent", "attemptId": "attempt",
                "fence": "1", "payloadDigest": "f" * 64, "operation": "ENROLL", "voiceProfileId": "second",
                "expectedRevision": stale_revision, "label": "label",
                "causalRefs": [{"kind": "JOURNAL_EVENT", "namespace": "test", "eventId": "control"}],
            }
            self.assertEqual(store.fence_native_command(command)["status"], "READY")
            begun = store.begin_native_invocation(command)
            self.assertEqual(begun["status"], "STARTED")
            try:
                self.assertEqual(store.apply_native_command(command, unit(1))["status"], "CONFLICT")
            finally:
                store.finish_native_invocation(begun["invocationKey"])
            self.assertEqual(store.reconcile_native_command(command)["status"], "UNKNOWN")

    def test_reconciliation_is_a_barrier_for_live_invocations(self) -> None:
        import threading
        import time
        with tempfile.TemporaryDirectory() as tmp:
            store = SpeakerStore(Path(tmp), dim=4, threshold=0.55)
            command = {
                "commandHandle": "barrier", "intentId": "intent", "attemptId": "attempt", "fence": "1",
                "payloadDigest": "c" * 64, "operation": "ENROLL", "voiceProfileId": "vp",
                "expectedRevision": store.revision,
                "causalRefs": [{"kind": "JOURNAL_EVENT", "namespace": "test", "eventId": "control"}],
            }
            self.assertEqual(store.fence_native_command(command)["status"], "READY")
            begun = store.begin_native_invocation(command)
            self.assertEqual(begun["status"], "STARTED")
            results = []
            worker = threading.Thread(target=lambda: results.append(store.reconcile_native_command(command)))
            worker.start()
            time.sleep(0.02)
            self.assertTrue(worker.is_alive())
            store.finish_native_invocation(begun["invocationKey"])
            worker.join(1)
            self.assertEqual(results[0]["status"], "PROVEN_NOT_APPLIED")

    def test_failed_generation_stage_keeps_old_manifest_and_proves_predecessor(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = SpeakerStore(Path(tmp), dim=4, threshold=0.55)
            predecessor = store.revision
            command = {
                "commandHandle": "failed-stage", "intentId": "intent", "attemptId": "attempt", "fence": "1",
                "payloadDigest": "d" * 64, "operation": "ENROLL", "voiceProfileId": "vp",
                "expectedRevision": predecessor, "label": "label",
                "causalRefs": [{"kind": "JOURNAL_EVENT", "namespace": "test", "eventId": "control"}],
            }
            self.assertEqual(store.fence_native_command(command)["status"], "READY")
            begun = store.begin_native_invocation(command)
            original_write = store._write_fsynced
            def fail_vector(path, data):
                if path.name == "speakers.npz" and path.parent.name.startswith("generation-"):
                    raise OSError("injected generation stage failure")
                original_write(path, data)
            store._write_fsynced = fail_vector
            try:
                with self.assertRaises(OSError):
                    store.apply_native_command(command, unit(1))
            finally:
                store._write_fsynced = original_write
                store.finish_native_invocation(begun["invocationKey"])
            self.assertEqual(store.reconcile_native_command(command)["status"], "PROVEN_NOT_APPLIED")
            restarted = SpeakerStore(Path(tmp), dim=4, threshold=0.55)
            self.assertEqual(restarted.revision, predecessor)
            self.assertEqual(restarted.list_public(), [])

    def test_manifest_activation_fsync_failure_is_unknown_until_restart_reconciles_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            store = SpeakerStore(directory, dim=4, threshold=0.55)
            predecessor = store.revision
            command = {
                "commandHandle": "manifest-fsync", "intentId": "intent", "attemptId": "attempt", "fence": "1",
                "payloadDigest": "e" * 64, "operation": "ENROLL", "voiceProfileId": "vp",
                "expectedRevision": predecessor, "label": "label",
                "causalRefs": [{"kind": "JOURNAL_EVENT", "namespace": "test", "eventId": "control"}],
            }
            self.assertEqual(store.fence_native_command(command)["status"], "READY")
            begun = store.begin_native_invocation(command)
            original_sync = store._fsync_directory
            should_fail = True
            def fail_active_manifest_sync(path):
                nonlocal should_fail
                if path == directory and should_fail:
                    manifest = json.loads((directory / "speaker-manifest.json").read_text())
                    if manifest["commandReceipts"]:
                        should_fail = False
                        raise OSError("injected activation directory fsync failure")
                original_sync(path)
            store._fsync_directory = fail_active_manifest_sync
            try:
                with self.assertRaises(OSError):
                    store.apply_native_command(command, unit(2))
            finally:
                store._fsync_directory = original_sync
                store.finish_native_invocation(begun["invocationKey"])
            self.assertEqual(store.reconcile_native_command(command)["status"], "UNKNOWN")
            restarted = SpeakerStore(directory, dim=4, threshold=0.55)
            reconciled = restarted.reconcile_native_command(command)
            self.assertEqual(reconciled["status"], "ALREADY_APPLIED")
            self.assertEqual(restarted.revision, reconciled["receipt"]["resultingRevision"])
            self.assertEqual(len(restarted.list_public()), 1)


class ClusterMatchTests(unittest.TestCase):
    def test_two_unknown_clusters_stay_distinct(self) -> None:
        segments = [
            {"startMs": 0, "endMs": 1000, "speaker": "0"},
            {"startMs": 1100, "endMs": 2200, "speaker": "1"},
        ]
        self.assertEqual(unique_cluster_ids(segments), ["0", "1"])
        self.assertTrue(is_mixed_capture(segments))
        attached = attach_cluster_voice_profile_matches(
            segments,
            {
                "0": {"status": "NO_MATCH"},
                "1": {"status": "NO_MATCH"},
            },
        )
        self.assertEqual(attached[0]["speaker"], "0")
        self.assertEqual(attached[1]["speaker"], "1")
        self.assertNotEqual(attached[0]["speaker"], attached[1]["speaker"])

    def test_known_and_unknown_clusters_remain_distinct(self) -> None:
        segments = [
            {"startMs": 0, "endMs": 800, "speaker": "0"},
            {"startMs": 900, "endMs": 1700, "speaker": "1"},
        ]
        attached = attach_cluster_voice_profile_matches(
            segments,
            {
                "0": {"status": "MATCHED", "voiceProfileId": "vp_7"},
                "1": {"status": "NO_MATCH"},
            },
        )
        self.assertEqual(attached[0]["voiceProfileMatch"]["voiceProfileId"], "vp_7")
        self.assertEqual(attached[1]["voiceProfileMatch"]["status"], "NO_MATCH")
        self.assertNotEqual(attached[0]["speaker"], attached[1]["speaker"])

    def test_mixed_capture_does_not_share_one_whole_audio_match(self) -> None:
        segments = [
            {"startMs": 0, "endMs": 500, "speaker": "0"},
            {"startMs": 600, "endMs": 1200, "speaker": "1"},
        ]
        self.assertTrue(is_mixed_capture(segments))
        # Whole-audio identity is omitted for mixed captures; each cluster is
        # independent, including when one cluster has no matchable audio.
        attached = attach_cluster_voice_profile_matches(
            segments,
            {
                "0": {"status": "MATCHED", "voiceProfileId": "vp_7"},
                "1": {"status": "NO_MATCH"},
            },
        )
        ids = {item["voiceProfileMatch"].get("voiceProfileId") for item in attached}
        self.assertIn("vp_7", ids)
        self.assertIn(None, ids)

    def test_cluster_span_collection_concatenates_same_cluster_only(self) -> None:
        samples = np.arange(16000, dtype=np.float32)
        segments = [
            {"startMs": 0, "endMs": 250, "speaker": "0"},
            {"startMs": 250, "endMs": 500, "speaker": "1"},
            {"startMs": 500, "endMs": 750, "speaker": "0"},
        ]
        clips = collect_cluster_audio(samples, 16000, segments)
        self.assertEqual(set(clips), {"0", "1"})
        self.assertEqual(clips["0"].shape[0], 8000)
        self.assertEqual(clips["1"].shape[0], 4000)
        self.assertTrue(np.array_equal(clips["0"], np.concatenate([samples[0:4000], samples[8000:12000]])))
        self.assertFalse(cluster_audio_is_matchable(clips["1"], 16000))
        self.assertTrue(cluster_audio_is_matchable(clips["0"], 16000))


if __name__ == "__main__":
    unittest.main()
