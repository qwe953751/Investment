#!/usr/bin/env python3
"""原生備份：全部 SQL 的 CMS AES-256-GCM 密文 + 最後寫入的完整性清單。

所有 SQL／解密內容只在 0700 暫存目錄；不印出連線資訊、SQL 資料列或原始錯誤。
validate 不需要正式庫權限。prepare-test 只產出拋棄式資料庫的測試資料。
"""
import argparse
from contextlib import ExitStack
from datetime import date, datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from urllib.parse import parse_qsl, unquote, urlsplit
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
PROTECTED = (
    'access_share_links', 'asset_operation_group_columns', 'asset_operation_snapshots',
    'asset_operation_sync_operations', 'asset_operation_sync_state', 'ocr_evaluations',
    'ocr_jobs', 'ocr_user_routing', 'ocr_workers',
)
OMITTED = ('daily_quotes', 'intraday_quotes', 'intraday_runs', 'intraday_topic_heat',
           'monthly_revenue', 'device_sessions')
PRIVATE = ('private_notes', 'admin_bgm')


def run(args, *, env=None, data=None):
    result = subprocess.run([str(a) for a in args], input=data, capture_output=True, env=env)
    if result.returncode:
        # PostgreSQL 的原始錯誤可能包含資料列或 URI，不能送進 Actions log。
        raise RuntimeError(f'{Path(args[0]).name} failed (exit {result.returncode}); credentials/data suppressed')
    return result.stdout


def tool(name):
    explicit = os.environ.get({'pg_dump': 'PG_DUMP', 'psql': 'PSQL', 'openssl': 'OPENSSL'}[name])
    candidates = [explicit, shutil.which(name)]
    if name in ('pg_dump', 'psql'):
        candidates.insert(1, '/opt/homebrew/opt/libpq/bin/' + name)
    else:
        candidates.insert(1, '/opt/homebrew/opt/openssl@3/bin/openssl')
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    raise RuntimeError(f'missing executable: {name}')


def db_env(variable):
    value = os.environ.get(variable)
    if not value:
        raise RuntimeError(f'{variable} is required')
    uri = urlsplit(value)
    if uri.scheme not in ('postgres', 'postgresql') or not uri.hostname or not uri.username:
        raise RuntimeError(f'{variable} must be a PostgreSQL connection URI')
    # PGDATABASE 環境變數不會像 -d 一樣展開 URI；逐項傳遞也避免密碼出現在程序參數。
    env = dict(os.environ, PGHOST=uri.hostname, PGPORT=str(uri.port or 5432),
               PGUSER=unquote(uri.username), PGPASSWORD=unquote(uri.password or ''),
               PGDATABASE=unquote(uri.path.lstrip('/')), PGCONNECT_TIMEOUT='20')
    options = {'sslmode': 'PGSSLMODE', 'sslrootcert': 'PGSSLROOTCERT', 'options': 'PGOPTIONS',
               'application_name': 'PGAPPNAME', 'connect_timeout': 'PGCONNECT_TIMEOUT'}
    for key, setting in parse_qsl(uri.query):
        if key not in options:
            raise RuntimeError(f'unsupported backup connection option: {key}')
        env[options[key]] = setting
    return env


class Snapshot:
    """保持來源唯讀交易，讓 count 與 pg_dump 使用完全相同的 MVCC snapshot。"""
    def __init__(self, variable, snapshot=None):
        self.label = variable
        self.query_number = 0
        self.env = db_env(variable)
        self.proc = subprocess.Popen([tool('psql'), '-XqAt', '-v', 'ON_ERROR_STOP=1',
                                      '-v', 'VERBOSITY=sqlstate'], env=self.env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True)
        imported = ''
        if snapshot is not None:
            if not re.fullmatch('[0-9A-Fa-f-]+', snapshot):
                raise ValueError('invalid exported snapshot')
            imported = f"set transaction snapshot '{snapshot}'; "
        self.query('begin isolation level repeatable read read only; ' + imported + 'select pg_export_snapshot();')
        self.snapshot = self.last

    def query(self, sql):
        self.query_number += 1
        self.proc.stdin.write(sql + '\n')
        self.proc.stdin.flush()
        self.last = self.proc.stdout.readline().strip()
        if not self.last:
            error = self.proc.stderr.read()
            state = re.search(r'ERROR:\s+([0-9A-Z]{5})\b', error)
            raise RuntimeError(f'read-only backup query failed ({self.label}, query {self.query_number})' +
                               (' (SQLSTATE ' + state[1] + ')' if state else '') +
                               '; credentials/data suppressed')
        return self.last

    def close(self):
        try:
            try:
                self.proc.stdin.write('rollback;\n')
                self.proc.stdin.close()
            except BrokenPipeError:
                pass
            self.proc.wait(timeout=10)
        finally:
            if self.proc.poll() is None:
                self.proc.kill()
                self.proc.wait()


def table_counts(sql):
    rows, columns, values = {}, {}, {}
    active = None
    for line in sql.splitlines():
        match = re.fullmatch(r'COPY public\.([a-z_0-9]+) \((.*)\) FROM stdin;', line)
        if match:
            active = match[1]
            if active in rows:
                raise ValueError('duplicate COPY section')
            rows[active], values[active] = 0, []
            columns[active] = match[2].split(', ')
        elif active:
            if line == r'\.':
                active = None
            else:
                rows[active] += 1
                values[active].append(line.split('\t'))
    if active or '-- PostgreSQL database dump complete' not in sql:
        raise ValueError('incomplete pg_dump')
    return rows, columns, values


def digest(data):
    return hashlib.sha256(data).hexdigest()


def check_counts(sql, expected):
    rows, _, _ = table_counts(sql)
    if rows != expected:
        raise ValueError('dump row counts differ from source snapshot')


def read_counts(source, tables):
    if not tables:
        return {}
    for name in tables:
        if not re.fullmatch('[a-z_0-9]+', name):
            raise ValueError('invalid table name')
    query = ' union all '.join(f"select '{t}' as name, count(*) as n from public.{t}" for t in tables)
    return json.loads(source.query(f'select json_object_agg(name,n) from ({query}) counts;'))


def audit_rls(source, tables):
    names = ','.join("'" + t + "'" for t in tables)
    unsafe = json.loads(source.query(f"""
        select coalesce(json_agg(c.relname),'[]'::json) from pg_class c
        where c.relnamespace='public'::regnamespace and c.relname in ({names})
        and (not has_table_privilege(c.oid,'SELECT') or (c.relrowsecurity and (
          not exists (select 1 from pg_policy p where p.polrelid=c.oid and p.polcmd in ('r','*')
            and p.polpermissive and pg_get_expr(p.polqual,p.polrelid)='true'
            and exists (select 1 from unnest(p.polroles) r where r=0 or pg_has_role(current_user,r,'USAGE')))
          or exists (select 1 from pg_policy p where p.polrelid=c.oid and p.polcmd in ('r','*')
            and not p.polpermissive and exists (select 1 from unnest(p.polroles) r
              where r=0 or pg_has_role(current_user,r,'USAGE'))))));
    """))
    if unsafe:
        raise RuntimeError('unverified SELECT/RLS coverage: ' + ', '.join(unsafe))


def prune(directory):
    files = sorted({p.name[:10] for p in directory.iterdir()
                    if re.fullmatch(r'\d{4}-\d{2}-\d{2}\.(?:sql\.gz(?:\.cms)?|backup\.cms)', p.name)}, reverse=True)
    keep = set(files[:5])
    for group, limit in ((lambda d: d.isocalendar()[:2], 4), (lambda d: (d.year, d.month), 6)):
        groups, added = set(), 0
        for path in files:
            key = group(date.fromisoformat(path))
            if key in groups:
                continue
            groups.add(key)
            if path not in keep and added < limit:
                keep.add(path)
                added += 1
    for path in set(files) - keep:
        for suffix in ('.sql.gz', '.sql.gz.cms', '.protected.cms', '.backup.cms', '.backup.json'):
            (directory / (path + suffix)).unlink(missing_ok=True)


def create(directory):
    # 全部必要設定先檢查，缺一個就不產出貌似完整的新備份。
    db_env('SUPABASE_PROTECTED_BACKUP_DB_URL')
    certificate = ROOT / 'scripts/backup-recipient.pem'
    if not certificate.is_file():
        raise RuntimeError('backup encryption certificate is missing')
    os.umask(0o077)
    directory.mkdir(parents=True, exist_ok=True)
    today = datetime.now(ZoneInfo('Asia/Taipei')).date().isoformat()
    with tempfile.TemporaryDirectory(prefix='invest-backup-') as temporary, ExitStack() as stack:
        work = Path(temporary)
        public = Snapshot('SUPABASE_DB_URL')
        stack.callback(public.close)
        protected = Snapshot('SUPABASE_PROTECTED_BACKUP_DB_URL', public.snapshot)
        stack.callback(protected.close)
        tables = json.loads(public.query("""select coalesce(json_agg(c.relname order by c.relname),'[]'::json)
            from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','p')
            and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass
              and d.objid=c.oid and d.deptype='e');"""))
        public_tables = sorted(set(tables) - set(OMITTED + PRIVATE + PROTECTED))
        audit_rls(public, public_tables)
        audit_rls(protected, PROTECTED)
        public_counts = read_counts(public, public_tables)
        protected_counts = read_counts(protected, PROTECTED)
        env = dict(os.environ, PG_DUMP=tool('pg_dump'), PSQL=tool('psql'),
                   PG_DUMP_SNAPSHOT=public.snapshot, TZ='Asia/Taipei', INVEST_BACKUP_INTERNAL='1')
        run(['bash', ROOT / 'scripts/backup-supabase.sh', work / 'public'], env=env)
        public_bytes = (work / 'public' / (today + '.sql.gz')).read_bytes()
        public_sql = gzip.decompress(public_bytes).decode()
        check_counts(public_sql, public_counts)
        protected_sql = run([tool('pg_dump'), '--data-only', '--no-owner', '--no-privileges',
                             '--enable-row-security', '--snapshot=' + protected.snapshot,
                             *['--table=public.' + t for t in PROTECTED]], env=protected.env).decode()
        check_counts(protected_sql, protected_counts)
        refs = json.loads(protected.query("""select json_agg(json_build_object('table',c.conrelid::regclass::text,
            'column',a.attname)) from pg_constraint c join pg_attribute a
            on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
            where c.contype='f' and c.confrelid=(select t.oid from pg_class t
              join pg_namespace n on n.oid=t.relnamespace where n.nspname='auth' and t.relname='users')
              and c.connamespace='public'::regnamespace;"""))
        _, columns, values = table_counts(protected_sql)
        identities = set()
        for ref in refs or []:
            table = ref['table'].removeprefix('public.')
            if table not in PROTECTED:
                continue
            index = columns[table].index(ref['column'])
            for row in values[table]:
                if row[index] != r'\N':
                    identities.add(str(uuid.UUID(row[index])))
        # 函式定義也可能夾帶憑證：連原有原生 SQL 一起加密，不能只加密九張表。
        payload = dict(schemaVersion=2, date=today, publicSql=public_sql, sql=protected_sql,
                       publicRows=public_counts, protectedRows=protected_counts,
                       authUserIds=sorted(identities))
        encrypted = run([tool('openssl'), 'cms', '-encrypt', '-aes-256-gcm', '-binary',
                         '-outform', 'DER', certificate], data=gzip.compress(json.dumps(payload).encode()))
        files = {today + '.backup.cms': encrypted}
        manifest = dict(schemaVersion=2, date=today, createdAt=datetime.now(timezone.utc).isoformat(),
                        publicRows=public_counts, protectedRows=protected_counts,
                        files={n:dict(sha256=digest(b), bytes=len(b)) for n,b in files.items()},
                        omitted=list(OMITTED + PRIVATE), encryption='CMS AES-256-GCM')
        # 先完成所有匯出與檢查；manifest 最後替換，半套產物永遠不算成功。
        files[today + '.backup.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
        for name, data in files.items():
            staged = work / name
            staged.write_bytes(data)
            os.replace(staged, directory / name)
        prune(directory)
        print('Backup bundle complete: ' + today)
        print(json.dumps(dict(publicRows=public_counts, protectedRows=protected_counts)))


def validate(path, max_age=None, decrypt=False):
    manifest = json.loads(path.read_text())
    if manifest.get('schemaVersion') != 2 or path.name != manifest['date'] + '.backup.json':
        raise ValueError('invalid backup manifest')
    if max_age is not None:
        age = datetime.now(timezone.utc) - datetime.fromisoformat(manifest['createdAt'])
        if age.total_seconds() < -300 or age.total_seconds() > max_age * 3600:
            raise ValueError('backup is stale or has a future timestamp')
    expected_names = {manifest['date'] + '.backup.cms'}
    if set(manifest['files']) != expected_names:
        raise ValueError('incomplete backup bundle')
    content = {}
    for name, info in manifest['files'].items():
        data = (path.parent / name).read_bytes()
        if digest(data) != info['sha256'] or len(data) != info['bytes']:
            raise ValueError('backup file digest/size mismatch')
        content[name] = data
    if set(manifest['protectedRows']) != set(PROTECTED):
        raise ValueError('protected table coverage mismatch')
    public_sql = None
    payload = None
    if decrypt:
        key = os.environ.get('BACKUP_DECRYPT_KEY_FILE')
        if not key or not Path(key).is_file():
            raise ValueError('BACKUP_DECRYPT_KEY_FILE is required')
        decrypted = run([tool('openssl'), 'cms', '-decrypt', '-binary', '-inform', 'DER',
                         '-inkey', key], data=content[manifest['date'] + '.backup.cms'])
        payload = json.loads(gzip.decompress(decrypted))
        if (payload.get('schemaVersion') != 2 or payload['date'] != manifest['date']
                or payload['publicRows'] != manifest['publicRows']
                or payload['protectedRows'] != manifest['protectedRows']):
            raise ValueError('encrypted backup/manifest pair mismatch')
        public_sql = payload['publicSql']
        check_counts(public_sql, manifest['publicRows'])
        for table in PRIVATE:
            if re.search(r'public\.' + table + r'\b', public_sql):
                raise ValueError('private table leaked into native dump')
        if set(table_counts(public_sql)[0]) & set(OMITTED + PROTECTED):
            raise ValueError('excluded/protected rows leaked into native dump')
        check_counts(payload['sql'], manifest['protectedRows'])
    return manifest, public_sql, payload


def assemble_restore(public_sql, protected_sql):
    # 兩份 dump 必須按照 pg_dump 的 pre-data → data → post-data 順序合併。
    # 否則在已建立 OCR 通知 trigger 後 COPY，會誤呼叫隔離環境沒有的 Realtime。
    # 所有外鍵與 trigger 仍照原 SQL 建立、驗證，不能靠忽略錯誤或移除外鍵過關。
    post = re.search(r'^-- Name: .*; Type: (?:CONSTRAINT|FK CONSTRAINT|INDEX|INDEX ATTACH|TRIGGER|RULE|POLICY|ROW SECURITY|ACL|DEFAULT ACL);',
                     public_sql, re.MULTILINE)
    offset = post.start() if post else public_sql.index('-- PostgreSQL database dump complete')
    protected_sql = re.sub(r'^\\(?:un)?restrict[^\n]*\n', '', protected_sql, flags=re.MULTILINE)
    return public_sql[:offset] + '\n' + protected_sql + '\n' + public_sql[offset:]


def prepare_test(path, output):
    manifest, public_sql, payload = validate(path, 96, True)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    (output / 'restore.sql').write_text(assemble_restore(public_sql, payload['sql']))
    # 僅供拋棄式測試：不備份 Auth 密碼／token，不假裝這些 UUID 能恢復正式登入。
    ids = [str(uuid.UUID(value)) for value in payload['authUserIds']]
    (output / 'auth-identities.sql').write_text('\n'.join(
        "insert into auth.users(id) values ('" + value + "');" for value in ids))
    checks = []
    for table, count in (manifest['publicRows'] | manifest['protectedRows']).items():
        if not re.fullmatch('[a-z_0-9]+', table) or type(count) is not int or count < 0:
            raise ValueError('invalid row-count manifest')
        checks.append(f"if (select count(*) from public.{table}) <> {count} then raise exception 'row count mismatch: {table}'; end if;")
    (output / 'verify.sql').write_text('do $$ begin\n' + '\n'.join(checks) + '\nend $$;\n')
    print('Prepared isolated restore for ' + manifest['date'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('create', 'validate', 'prepare-test'))
    parser.add_argument('path', type=Path)
    parser.add_argument('--max-age-hours', type=float)
    parser.add_argument('--decrypt', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.command == 'create':
        create(args.path)
    elif args.command == 'prepare-test':
        if not args.output:
            parser.error('--output is required')
        prepare_test(args.path, args.output)
    else:
        manifest, _, _ = validate(args.path, args.max_age_hours, args.decrypt)
        print('Verified backup bundle: ' + manifest['date'])


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, KeyError, OSError) as error:
        print('Backup failed: ' + str(error) if isinstance(error, RuntimeError) else
              'Backup failed: invalid/missing backup input (' + type(error).__name__ + ')', file=sys.stderr)
        sys.exit(1)
