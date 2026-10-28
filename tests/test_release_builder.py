import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "build_release.py"
spec = importlib.util.spec_from_file_location("build_release", SCRIPT)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ReleaseBuilderTests(unittest.TestCase):
    def test_source_ids_must_be_unique_before_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "staging.json"
            source.write_text(json.dumps({"schema_version": 1, "questions": [
                {"id": "DUP-1"}, {"id": "DUP-1"}
            ]}), encoding="utf-8")
            with self.assertRaisesRegex(builder.BuildError, "Duplicate source IDs"):
                builder.load_source(source)

    def test_public_allowlist_rejects_private_fields(self):
        rec = {
            "id": "Q-1", "branch": "CS", "year": 2024, "subject": "Computer Science",
            "topic": "Math", "type": "MCQ", "marks": 1, "text": "Synthetic test",
            "options": [{"id": "A", "text": "a"}, {"id": "B", "text": "b"}],
            "source": {"name": "synthetic fixture"}, "answer_key": "A"
        }
        self.assertIn("record_fields_not_allowlisted", builder.valid_public_record(rec))
        self.assertIn("private_field_leakage", builder.valid_public_record(rec))

    def test_private_shard_manifest_hash_and_count(self):
        record = {
            "id": "SYN-1", "branch": "CS", "year": 2024, "subject": "Computer Science",
            "topic": "Math", "type": "MCQ", "marks": 1, "text": "Synthetic test",
            "options": [{"id": "A", "text": "a"}, {"id": "B", "text": "b"}],
            "source": {"name": "synthetic fixture"}
        }
        self.assertEqual(builder.valid_public_record(record), [])
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            built = builder.build_shards([record], out, "test-release", placeholder=True)
            entry = built["manifest"]["shards"][0]
            data = (out / entry["path"]).read_bytes()
            self.assertEqual(builder.sha256(data), entry["sha256"])
            shard = json.loads(data)
            self.assertEqual(len(shard["questions"]), entry["question_count"])
            self.assertTrue(built["manifest"]["placeholder"])

    def test_release_field_allowlist_contains_no_solution_fields(self):
        q = {
            "id": "SYN-2", "branch": "CS", "year": 2024, "subject": "Computer Science",
            "topic": "Math", "type": "NAT", "marks": 1, "text": "Synthetic test",
            "options": [], "source": {"name": "synthetic fixture"}
        }
        self.assertEqual(builder.valid_public_record(q), [])
        self.assertEqual(builder.scan_private_keys(q), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
