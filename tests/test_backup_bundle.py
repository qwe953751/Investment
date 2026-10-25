import copy
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import gzip
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

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


TAIPEI = ZoneInfo('Asia/Taipei')


def taipei(month, day, hour, minute=0, second=0):
    return datetime(2026, month, day, hour, minute, second, tzinfo=TAIPEI).astimezone(timezone.utc)


def write_backup(folder, date, created_at, cms=b'encrypted-bytes'):
    """寫一組結構正確的備份（清單＋密文）。cycle／validate 不解密，所以密文內容可以是任意位元組。"""
    folder.mkdir(parents=True, exist_ok=True)
    manifest = dict(schemaVersion=2, date=date, createdAt=created_at.isoformat(),
                    publicRows={'securities': 1}, protectedRows=dict.fromkeys(bundle.PROTECTED, 0),
                    files={date + '.backup.cms': dict(sha256=bundle.digest(cms), bytes=len(cms))})
    (folder / (date + '.backup.cms')).write_bytes(cms)
    path = folder / (date + '.backup.json')
    path.write_text(json.dumps(manifest))
    return path


class BackupCycleTests(unittest.TestCase):
    """每個收盤週期（台北 18:00 起算）只備份一次：判斷在 current_backup，不連資料庫。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name) / 'snapshots'

    def test_cycle_starts_at_18_taipei_and_rolls_back_a_day_before_it(self):
        for now, start in [(taipei(10, 26, 17, 59, 59), taipei(10, 25, 18)),
                           (taipei(10, 26, 18), taipei(10, 26, 18)),
                           (taipei(10, 26, 23, 59, 59), taipei(10, 26, 18)),
                           # 晚到的排程拖過午夜才送達：仍屬前一天 18:00 開始的那個週期
                           (taipei(10, 27, 0, 58), taipei(10, 26, 18)),
                           (taipei(10, 27, 3, 59), taipei(10, 26, 18)),
                           (taipei(11, 1, 9), taipei(10, 31, 18))]:
            self.assertEqual(bundle.cycle_start(now), start, now)

    def test_backup_made_in_this_cycle_is_current(self):
        write_backup(self.folder, '2026-10-26', taipei(10, 26, 18, 31))
        self.assertEqual(bundle.current_backup(self.folder, taipei(10, 26, 21, 20)), ('2026-10-26', None))
        # 晚到排程拖過午夜才來：同一個週期，不再備份第二次。
        self.assertEqual(bundle.current_backup(self.folder, taipei(10, 27, 0, 58)), ('2026-10-26', None))
        self.assertEqual(bundle.current_backup(self.folder, taipei(10, 27, 17, 59, 59)), ('2026-10-26', None))

    def test_next_evenings_run_is_due_again_at_18(self):
        write_backup(self.folder, '2026-10-26', taipei(10, 26, 18, 31))
        self.assertEqual(bundle.current_backup(self.folder, taipei(10, 27, 18)), (None, 'older-than-cycle'))

    def test_backup_after_midnight_does_not_cover_the_next_evening(self):
        # 凌晨 00:58 才送達的晚到排程做了備份（檔名是隔天的日期）。
        # 當晚 18:00 的完整流程仍要備份：白天的修改不能等到再隔一天。
        write_backup(self.folder, '2026-10-27', taipei(10, 27, 0, 58))
        self.assertEqual(bundle.current_backup(self.folder, taipei(10, 27, 3)), ('2026-10-27', None))
        self.assertEqual(bundle.current_backup(self.folder, taipei(10, 27, 18, 5)), (None, 'older-than-cycle'))

    def test_boundary_is_inclusive_at_the_cycle_start(self):
        write_backup(self.folder, '2026-10-26', taipei(10, 26, 18))
        self.assertEqual(bundle.current_backup(self.folder, taipei(10, 26, 18, 1)), ('2026-10-26', None))
        write_backup(self.folder, '2026-10-27', taipei(10, 26, 17, 59, 59))
        self.assertEqual(bundle.current_backup(self.folder, taipei(10, 26, 18, 1))[1], 'older-than-cycle')

    def test_nothing_to_trust_means_back_up(self):
        self.assertEqual(bundle.current_backup(self.folder, taipei(10, 26, 19)), (None, 'no-manifest'))
        self.folder.mkdir(parents=True)
        (self.folder / '2026-10-26.sql.gz.cms').write_bytes(b'old format')
        self.assertEqual(bundle.current_backup(self.folder, taipei(10, 26, 19)), (None, 'no-manifest'))

    def test_a_manifest_that_fails_validation_is_not_trusted(self):
        for label, damage in [
            ('密文被截斷', lambda path: (path.parent / '2026-10-26.backup.cms').write_bytes(b'short')),
            ('密文遺失', lambda path: (path.parent / '2026-10-26.backup.cms').unlink()),
            ('清單不是 JSON', lambda path: path.write_text('{ not json')),
            ('清單少了建立時間', lambda path: path.write_text(json.dumps(
                {k: v for k, v in json.loads(path.read_text()).items() if k != 'createdAt'}))),
            ('建立時間沒有時區', lambda path: path.write_text(json.dumps(
                {**json.loads(path.read_text()), 'createdAt': '2026-10-26T18:31:00'})))]:
            with self.subTest(label):
                path = write_backup(self.folder, '2026-10-26', taipei(10, 26, 18, 31))
                damage(path)
                found, reason = bundle.current_backup(self.folder, taipei(10, 26, 21))
                self.assertIsNone(found)
                self.assertRegex(reason, r'^(invalid-|error-)')

    def test_a_broken_newest_manifest_is_not_rescued_by_an_older_valid_one(self):
        # 最新那份壞了，就當作本週期沒有備份；不退回去相信更舊的檔案。
        write_backup(self.folder, '2026-10-26', taipei(10, 26, 18, 31))
        newest = write_backup(self.folder, '2026-10-27', taipei(10, 26, 23, 40))
        (self.folder / '2026-10-27.backup.cms').write_bytes(b'tampered')
        found, reason = bundle.current_backup(self.folder, taipei(10, 27, 1))
        self.assertIsNone(found)
        self.assertTrue(reason.startswith('invalid-'), reason)
        self.assertTrue(newest.exists())

    def test_future_timestamps_are_rejected_with_a_small_clock_skew_allowance(self):
        now = taipei(10, 26, 19)
        write_backup(self.folder, '2026-10-26', now + timedelta(minutes=3))
        self.assertEqual(bundle.current_backup(self.folder, now), ('2026-10-26', None))
        write_backup(self.folder, '2026-10-26', now + timedelta(minutes=10))
        self.assertEqual(bundle.current_backup(self.folder, now), (None, 'future-timestamp'))

    def test_report_writes_workflow_outputs_and_never_raises(self):
        output = Path(self.temp.name) / 'github-output'
        with patch.dict(os.environ, {'GITHUB_OUTPUT': str(output)}):
            bundle.report_cycle(self.folder, taipei(10, 26, 19))
            self.assertEqual(output.read_text(), 'fresh=false\n')
            output.write_text('')
            write_backup(self.folder, '2026-10-26', taipei(10, 26, 18, 31))
            bundle.report_cycle(self.folder, taipei(10, 26, 19))
            self.assertEqual(output.read_text(), 'date=2026-10-26\nfresh=true\n')
            output.write_text('')
            with patch.object(bundle, 'current_backup', side_effect=MemoryError('boom')):
                bundle.report_cycle(self.folder, taipei(10, 26, 19))
            self.assertEqual(output.read_text(), 'fresh=false\n')

    def test_cli_always_exits_zero_so_the_workflow_falls_through_to_a_backup(self):
        output = Path(self.temp.name) / 'github-output'
        script = Path(bundle.__file__)
        for directory in (self.folder, Path(self.temp.name) / 'does-not-exist'):
            output.write_text('')
            result = subprocess.run([sys.executable, str(script), 'cycle', str(directory)], capture_output=True,
                                    text=True, env=dict(os.environ, GITHUB_OUTPUT=str(output)))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output.read_text(), 'fresh=false\n')
            self.assertIn('No valid backup in the current cycle', result.stdout)

    def test_the_cycle_hour_is_the_daily_refresh_hour_used_elsewhere(self):
        root = Path(bundle.__file__).resolve().parent.parent
        self.assertEqual(bundle.CYCLE_HOUR, 18)
        self.assertIn('DAILY_REFRESH_HOUR = 18;', (root / 'scripts/daily-snapshot-done.mjs').read_text())
        self.assertIn('DailyRefresh = new(18, 0)', (
            root / 'src/Invest.Web/Infrastructure/MarketData/CollectionSchedule.cs').read_text())


class FakeSnapshot:
    """取代 psql 常駐連線：依 SQL 內容回固定答案，只用來驗證 create() 的流程與日期。"""
    PUBLIC_COUNTS = {'securities': 1}

    def __init__(self, variable, snapshot=None):
        self.snapshot = 'snapshot-1'
        self.env = {}

    def query(self, sql):
        if 'json_object_agg' in sql:
            return json.dumps(self.PUBLIC_COUNTS if 'public.securities' in sql
                              else {t: int(t == 'ocr_jobs') for t in bundle.PROTECTED})
        if 'has_table_privilege' in sql:
            return '[]'
        if 'json_build_object' in sql:
            return '[]'
        return json.dumps(['securities', *bundle.PROTECTED])

    def close(self):
        pass


class BackupCreateDateTests(unittest.TestCase):
    """create() 只讀一次日期：整輪備份跨過午夜，檔名、清單、內部匯出器與輸出給後續步驟的日期都要一致。"""

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

    def run_create(self, instants):
        """用假時鐘、假 psql／pg_dump 跑完整的 create()；回傳 (目錄, GITHUB_OUTPUT 內容, 內部匯出器看到的環境)。"""
        class Clock(datetime):
            queue = list(instants)

            @classmethod
            def now(cls, tz=None):
                value = cls.queue.pop(0) if len(cls.queue) > 1 else cls.queue[0]
                return value.astimezone(tz) if tz else value

        root = self.folder / 'repo'
        (root / 'scripts').mkdir(parents=True)
        (root / 'scripts/backup-recipient.pem').write_bytes(self.cert.read_bytes())
        output = self.folder / 'github-output'
        output.write_text('')
        seen = {}
        real_run, real_tool = bundle.run, bundle.tool

        def fake_run(args, *, env=None, data=None):
            if args[0] == 'bash':  # 取代 backup-supabase.sh：只照 INVEST_BACKUP_DATE 命名，和真的一樣
                seen.update(date=env['INVEST_BACKUP_DATE'], internal=env['INVEST_BACKUP_INTERNAL'])
                Path(args[2]).mkdir(parents=True, exist_ok=True)
                (Path(args[2]) / (env['INVEST_BACKUP_DATE'] + '.sql.gz')).write_bytes(
                    gzip.compress(sql({'securities': ['1']}).encode()))
                return b''
            if str(args[0]).endswith('pg_dump'):
                return sql({t: ['00000000-0000-0000-0000-000000000001'] if t == 'ocr_jobs' else []
                            for t in bundle.PROTECTED}).encode()
            return real_run(args, env=env, data=data)  # openssl 用真的，產出的密文才能解開驗證

        with ExitStack() as stack:
            for each in (patch.object(bundle, 'ROOT', root), patch.object(bundle, 'Snapshot', FakeSnapshot),
                         patch.object(bundle, 'run', fake_run), patch.object(bundle, 'datetime', Clock),
                         patch.object(bundle, 'tool', lambda name: f'/fake/{name}' if name in ('pg_dump', 'psql')
                                      else real_tool(name)),
                         patch.dict(os.environ, {'GITHUB_OUTPUT': str(output), 'BACKUP_DECRYPT_KEY_FILE': str(self.key),
                                                 'SUPABASE_PROTECTED_BACKUP_DB_URL': 'postgresql://u:p@localhost/db'})):
                stack.enter_context(each)
            target = self.folder / 'out'
            bundle.create(target)
        return target, output.read_text(), seen

    def test_backup_that_crosses_midnight_keeps_the_date_it_started_with(self):
        # 23:59:58 開始、00:00:31 才寫清單：日期是開始那一刻的 2026-10-26，建立時間是隔天凌晨。
        target, output, seen = self.run_create([taipei(10, 26, 23, 59, 58), taipei(10, 27, 0, 0, 31)])
        self.assertEqual(seen, {'date': '2026-10-26', 'internal': '1'})
        self.assertEqual(sorted(p.name for p in target.iterdir()),
                         ['2026-10-26.backup.cms', '2026-10-26.backup.json'])
        self.assertEqual(output, 'date=2026-10-26\n')
        with patch.dict(os.environ, {'BACKUP_DECRYPT_KEY_FILE': str(self.key)}):
            manifest, _, payload = bundle.validate(target / '2026-10-26.backup.json', None, True)
        self.assertEqual((manifest['date'], payload['date']), ('2026-10-26', '2026-10-26'))
        self.assertTrue(manifest['createdAt'].startswith('2026-10-26T16:00:31'), manifest['createdAt'])

    def test_a_normal_backup_reports_the_same_date_to_the_workflow(self):
        target, output, seen = self.run_create([taipei(10, 26, 18, 31)])
        self.assertEqual(seen['date'], '2026-10-26')
        self.assertEqual(output, 'date=2026-10-26\n')
        self.assertEqual(bundle.current_backup(target, taipei(10, 26, 21)), ('2026-10-26', None))


if __name__ == '__main__':
    unittest.main()
