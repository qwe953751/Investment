import copy
from datetime import datetime, timedelta, timezone
import gzip
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('backup_bundle', Path(__file__).resolve().parents[1] / 'scripts/backup-bundle.py')
bundle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle)


def sql(tables):
    lines = ['-- PostgreSQL database dump']
    for name, values in tables.items():
        lines.extend([f'COPY public.{name} (id) FROM stdin;', *values, r'\.'])
    return '\n'.join(lines + ['-- PostgreSQL database dump complete', ''])


class BackupBundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = tempfile.TemporaryDirectory()
        cls.key = Path(cls.keys.name) / 'key.pem'
        cls.cert = Path(cls.keys.name) / 'cert.pem'
        bundle.run([bundle.tool('openssl'), 'req', '-x509', '-newkey', 'rsa:2048',
                    '-nodes', '-keyout', cls.key, '-out', cls.cert, '-days', '1', '-subj', '/CN=Backup Test'])

    @classmethod
    def tearDownClass(cls):
        cls.keys.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'BACKUP_DECRYPT_KEY_FILE': str(self.key)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.name = datetime.now(timezone.utc).date().isoformat()
        self.path = self.folder / (self.name + '.backup.json')
        self.public = gzip.compress(sql({'securities': ['1']}).encode())
        self.protected_sql = sql({t: ['00000000-0000-0000-0000-000000000001'] if t == 'ocr_jobs' else []
                                  for t in bundle.PROTECTED})
        self.counts = {t: int(t == 'ocr_jobs') for t in bundle.PROTECTED}
        self.payload = dict(schemaVersion=2, date=self.name,
                            sql=self.protected_sql, protectedRows=self.counts,
                            authUserIds=['00000000-0000-0000-0000-000000000001'])
        self.manifest = dict(schemaVersion=2, date=self.name,
                             createdAt=datetime.now(timezone.utc).isoformat(),
                             publicRows={'securities': 1}, protectedRows=self.counts)
        self.write_bundle()

    def write_bundle(self):
        self.payload['publicSql'] = gzip.decompress(self.public).decode()
        self.payload['publicRows'] = self.manifest['publicRows']
        encrypted = bundle.run([bundle.tool('openssl'), 'cms', '-encrypt', '-aes-256-gcm',
                                '-binary', '-outform', 'DER', self.cert],
                               data=gzip.compress(json.dumps(self.payload).encode()))
        files = {self.name + '.backup.cms': encrypted}
        self.manifest['files'] = {name: dict(sha256=bundle.digest(data), bytes=len(data))
                                  for name, data in files.items()}
        for name, data in files.items():
            (self.folder / name).write_bytes(data)
        self.path.write_text(json.dumps(self.manifest))

    def test_valid_encrypted_pair_preserves_nonzero_protected_rows(self):
        manifest, _, payload = bundle.validate(self.path, 24, True)
        self.assertEqual(manifest['protectedRows']['ocr_jobs'], 1)
        self.assertEqual(payload['sql'], self.protected_sql)

    def test_copy_parser_counts_actual_rows_and_rejects_truncation(self):
        self.assertEqual(bundle.table_counts(sql({'notes': ['1', '2']}))[0], {'notes': 2})
        for invalid in [sql({'notes': ['1']}).replace('-- PostgreSQL database dump complete', ''),
                        '-- PostgreSQL database dump complete\nCOPY public.notes (id) FROM stdin;\n1']:
            with self.assertRaises(ValueError):
                bundle.table_counts(invalid)

    def test_source_count_mismatch_is_not_a_successful_backup(self):
        with self.assertRaisesRegex(ValueError, 'source snapshot'):
            bundle.check_counts(self.protected_sql, {**self.counts, 'ocr_jobs': 0})

    def test_corrupt_public_file_is_rejected(self):
        path = self.folder / (self.name + '.backup.cms')
        path.write_bytes(path.read_bytes()[:-1])
        with self.assertRaisesRegex(ValueError, 'digest/size'):
            bundle.validate(self.path)

    def test_gcm_rejects_ciphertext_tampering_even_if_manifest_hash_is_changed(self):
        path = self.folder / (self.name + '.backup.cms')
        data = bytearray(path.read_bytes())
        data[-1] ^= 1
        path.write_bytes(data)
        self.manifest['files'][path.name]['sha256'] = bundle.digest(data)
        self.path.write_text(json.dumps(self.manifest))
        with self.assertRaises(RuntimeError):
            bundle.validate(self.path, decrypt=True)

    def test_different_days_cannot_be_mixed(self):
        self.payload['date'] = '2000-01-01'
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, 'pair mismatch'):
            bundle.validate(self.path, decrypt=True)

    def test_stale_backup_does_not_pass_weekly_restore(self):
        self.manifest['createdAt'] = (datetime.now(timezone.utc) - timedelta(hours=100)).isoformat()
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, 'stale'):
            bundle.validate(self.path, 96)

    def test_future_timestamp_is_rejected(self):
        self.manifest['createdAt'] = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        self.write_bundle()
        with self.assertRaises(ValueError):
            bundle.validate(self.path, 96)

    def test_missing_encrypted_file_is_rejected(self):
        (self.folder / (self.name + '.backup.cms')).unlink()
        with self.assertRaises(OSError):
            bundle.validate(self.path)

    def test_manifest_cannot_read_outside_snapshot_directory(self):
        self.manifest['files']['../other'] = self.manifest['files'].pop(self.name + '.backup.cms')
        self.path.write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            bundle.validate(self.path, decrypt=True)

    def test_private_table_definition_never_passes_public_validation(self):
        self.public = gzip.compress((sql({'securities': ['1']}) + 'CREATE TABLE public.private_notes(id uuid);').encode())
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, 'private table'):
            bundle.validate(self.path, decrypt=True)

    def test_protected_table_must_not_leak_into_public_dump(self):
        self.public = gzip.compress(sql({'securities': ['1'], 'ocr_jobs': ['1']}).encode())
        self.manifest['publicRows']['ocr_jobs'] = 1
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, 'leaked'):
            bundle.validate(self.path, decrypt=True)

    def test_prepare_test_verifies_every_table_and_only_recreates_auth_ids(self):
        output = self.folder / 'restore'
        bundle.prepare_test(self.path, output)
        checks = (output / 'verify.sql').read_text()
        self.assertIn('public.ocr_jobs) <> 1', checks)
        self.assertIn('public.securities) <> 1', checks)
        identities = (output / 'auth-identities.sql').read_text()
        self.assertEqual(identities, "insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001');")
        self.assertNotIn('password', identities)

    def test_restore_data_precedes_constraints_and_notification_triggers(self):
        public = ('\\restrict publickey\n' + sql({'securities': ['1']}) +
                  '-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres\n'
                  'ALTER TABLE public.ocr_jobs ADD PRIMARY KEY(id);\n'
                  '-- Name: jobs notify; Type: TRIGGER; Schema: public; Owner: postgres\n'
                  'CREATE TRIGGER notify AFTER INSERT ON public.ocr_jobs EXECUTE FUNCTION notify();\n'
                  '\\unrestrict publickey\n')
        protected = '\\restrict privatekey\n' + self.protected_sql + '\\unrestrict privatekey\n'
        combined = bundle.assemble_restore(public, protected)
        self.assertLess(combined.index('COPY public.ocr_jobs'), combined.index('ADD PRIMARY KEY'))
        self.assertLess(combined.index('COPY public.ocr_jobs'), combined.index('CREATE TRIGGER'))
        self.assertNotIn('privatekey', combined)
        self.assertIn('\\restrict publickey', combined)

    def test_connection_uri_is_split_without_putting_password_in_arguments(self):
        with patch.dict(os.environ, {'BACKUP_TEST_URL': 'postgresql://reader%2Eref:pass%40word@localhost:5433/postgres?sslmode=require'}):
            env = bundle.db_env('BACKUP_TEST_URL')
        self.assertEqual(env['PGUSER'], 'reader.ref')
        self.assertEqual(env['PGPASSWORD'], 'pass@word')
        self.assertEqual(env['PGDATABASE'], 'postgres')
        self.assertEqual(env['PGSSLMODE'], 'require')

    def test_prune_rotates_all_companions_together(self):
        today = datetime.now(timezone.utc).date()
        for ago in range(60):
            day = (today - timedelta(days=ago)).isoformat()
            for suffix in ('.backup.cms', '.backup.json'):
                (self.folder / (day + suffix)).touch()
        bundle.prune(self.folder)
        dates = {p.name[:10] for p in self.folder.glob('*.backup.cms')}
        for suffix in ('.backup.json',):
            self.assertEqual(dates, {p.name[:10] for p in self.folder.glob('*' + suffix)})
        self.assertTrue(all((today - timedelta(days=n)).isoformat() in dates for n in range(5)))


if __name__ == '__main__':
    unittest.main()
