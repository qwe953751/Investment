import gzip
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('sanitize', Path(__file__).resolve().parents[1] / 'scripts/sanitize-backup-history.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class SanitizeBackupHistoryTests(unittest.TestCase):
    def test_only_device_rows_are_removed_every_other_byte_is_preserved(self):
        before = (b'-- PostgreSQL database dump\nCREATE TABLE public.device_sessions(ip_address text);\n'
                  b'COPY public.notes (id, body) FROM stdin;\n1\tkeep this\\ntext\n\\.\n'
                  b'COPY public.device_sessions (device_id, ip_address) FROM stdin;\n'
                  b'device-a\t192.0.2.1\ndevice-b\t198.51.100.2\n\\.\n'
                  b'ALTER TABLE public.device_sessions ENABLE ROW LEVEL SECURITY;\n')
        expected = before.replace(b'device-a\t192.0.2.1\ndevice-b\t198.51.100.2\n', b'')
        cleaned, count = module.sanitize_sql(before)
        self.assertEqual(cleaned, expected)
        self.assertEqual(count, 2)

    def test_incomplete_copy_aborts_instead_of_removing_following_sql(self):
        with self.assertRaises(ValueError):
            module.sanitize_sql(b'COPY public.device_sessions (id) FROM stdin;\nrow\n')

    def test_insert_format_requires_explicit_review(self):
        with self.assertRaises(ValueError):
            module.sanitize_sql(b'INSERT INTO public.device_sessions VALUES (1);\n')

    def test_gzip_non_sql_and_already_clean_snapshots_are_byte_identical(self):
        for original in [b'normal JSON', gzip.compress(b'{"date":"2026-10-24"}'),
                         gzip.compress(b'-- PostgreSQL database dump\nCOPY public.device_sessions (id) FROM stdin;\n\\.\n')]:
            self.assertEqual(module.sanitize_gzip(original), (original, 0))

    def test_recompression_is_deterministic_and_data_survives(self):
        original = gzip.compress(b'-- PostgreSQL database dump\nCOPY public.device_sessions (id) FROM stdin;\nsecret\n\\.\n')
        first, count = module.sanitize_gzip(original)
        second, _ = module.sanitize_gzip(original)
        self.assertEqual(count, 1)
        self.assertEqual(first, second)
        self.assertNotIn(b'secret', gzip.decompress(first))
        self.assertEqual(module.sanitize_gzip(first), (first, 0))


if __name__ == '__main__':
    unittest.main()
