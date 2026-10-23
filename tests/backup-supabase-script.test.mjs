// scripts/backup-supabase.sh 的行為測試。
//
// 用假的 psql／pg_dump 放在 PATH 之外、以 PG_DUMP／PSQL 環境變數指給腳本，驗證腳本自己的判斷：
// 帶了哪些排除參數、哪些情況會在 pg_dump 之前就中止、排除失效時絕不把內容寫進快照。
// 假指令只負責「記下呼叫」與「回固定答案」；SQL 本身與 pg_dump 對受限角色的實際行為，
// 已用真正的 PostgreSQL 與 pg_dump 18.6 另外驗證過（見 Doc/版本紀錄.md 2026-10-23 的備份修復）。
//
// 背景：2026-10-20 起 private_notes（db/066）與 admin_bgm（db/070）撤掉了備份帳號 invest_writer
// 的讀取權，pg_dump 鎖表被擋，整份備份連續多天沒有產出。備份會 commit 進公開 repo 的 data 分支，
// 所以私密表不能為了備份把讀取權開回去，只能整張不備份。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = join(root, 'scripts', 'backup-supabase.sh');
const skip = process.platform === 'win32' ? '備份腳本是 bash，只在 macOS／Linux 驗證' : false;

const psqlStub = `#!/bin/bash
sql=''
while [ "$#" -gt 0 ]; do
    case "$1" in
        -c) sql="$2"; shift 2 ;;
        *) shift ;;
    esac
done
printf '%s\\n-----\\n' "$sql" >> "$STUB_DIR/psql.log"
case "$sql" in
    *has_table_privilege*) answer="$STUB_UNREADABLE" ;;
    *"parent.relname = any(string_to_array('private_notes"*) answer="$STUB_PRIVATE_REFERRERS" ;;
    *) answer="$STUB_ORPHANS" ;;
esac
if [ -n "$answer" ]; then printf '%s\\n' "$answer"; fi
`;

const pgDumpStub = `#!/bin/bash
printf '%s\\n' "$@" > "$STUB_DIR/pg_dump.args"
cat <<'SQL'
-- PostgreSQL database dump
CREATE TABLE public.securities (id integer);
COPY public.securities (id) FROM stdin;
1
\\.
SQL
printf '%s\\n' "$STUB_DUMP_EXTRA"
echo '-- PostgreSQL database dump complete'
`;

async function withBackup(options, check) {
    const directory = await mkdtemp(join(tmpdir(), 'backup-script-'));
    try {
        for (const [name, body] of [['psql', psqlStub], ['pg_dump', pgDumpStub]]) {
            await writeFile(join(directory, name), body);
            await chmod(join(directory, name), 0o700);
        }
        const snapshots = join(directory, 'snapshots');
        const result = spawnSync('bash', [scriptPath, snapshots], {
            encoding: 'utf8',
            env: {
                ...process.env,
                SUPABASE_DB_URL: 'postgres://stub',
                PG_DUMP: join(directory, 'pg_dump'),
                PSQL: join(directory, 'psql'),
                STUB_DIR: directory,
                STUB_UNREADABLE: options.unreadable ?? '',
                STUB_ORPHANS: options.orphans ?? '',
                STUB_PRIVATE_REFERRERS: options.privateReferrers ?? '',
                STUB_DUMP_EXTRA: options.dumpExtra ?? ''
            }
        });
        const argsFile = join(directory, 'pg_dump.args');
        const logFile = join(directory, 'psql.log');
        await check({
            result,
            snapshots,
            pgDumpArgs: existsSync(argsFile) ? (await readFile(argsFile, 'utf8')).split('\n').filter(Boolean) : null,
            queries: existsSync(logFile) ? (await readFile(logFile, 'utf8')).split('\n-----\n').filter(Boolean) : []
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('備份整張排除私密表、不留裝置 IP，而且沒有任何會刪資料的參數', { skip }, async () => {
    await withBackup({}, async ({ result, snapshots, pgDumpArgs }) => {
        assert.equal(result.status, 0, result.stderr);

        for (const table of ['private_notes', 'admin_bgm']) {
            assert.ok(pgDumpArgs.includes(`--exclude-table=public.${table}`), `${table} 要整張排除`);
        }
        for (const table of ['daily_quotes', 'intraday_quotes', 'intraday_runs', 'intraday_topic_heat',
            'monthly_revenue', 'device_sessions']) {
            assert.ok(pgDumpArgs.includes(`--exclude-table-data=public.${table}`), `${table} 要排除內容`);
        }

        // 備份是純新增的 SQL：不帶 --clean／--create，檔案裡也沒有 DROP／TRUNCATE／DELETE，
        // 所以不管怎麼還原，這份檔案本身都不會刪掉正式庫現有的任何東西。
        assert.deepEqual(pgDumpArgs.filter(arg => /^(-c|-C|--clean|--create|--if-exists)$/.test(arg)), []);
        const [file] = await readdir(snapshots);
        assert.match(file, /^\d{4}-\d{2}-\d{2}\.sql\.gz$/);
        const dump = gunzipSync(await readFile(join(snapshots, file))).toString('utf8');
        assert.doesNotMatch(dump, /^(DROP|TRUNCATE|DELETE)\b/mi);
    });
});

test('備份前的檢查把私密表排出「讀不到」清單，並且送出完整的排除名單', { skip }, async () => {
    await withBackup({}, async ({ result, queries }) => {
        assert.equal(result.status, 0, result.stderr);

        const unreadable = queries.find(query => query.includes('has_table_privilege'));
        assert.ok(unreadable, '要先問資料庫哪些表備份帳號讀不到');
        assert.match(unreadable, /relkind in \('r', 'p'\)/);
        assert.match(unreadable, /deptype = 'e'/, '延伸套件自己的表 pg_dump 本來就不會鎖，不能算進去');
        for (const table of ['private_notes', 'admin_bgm']) {
            assert.ok(unreadable.includes(table), `${table} 是刻意讀不到的，不能被當成異常`);
        }

        const foreignKeys = queries.filter(query => query.includes('pg_constraint'));
        assert.equal(foreignKeys.length, 2, '外鍵要查兩次：指向被排除內容的表、指向整張不備份的表');
        assert.ok(foreignKeys.some(query => query.includes('device_sessions')));
    });
});

test('出現備份帳號讀不到的新表時，在 pg_dump 之前點名並中止', { skip }, async () => {
    await withBackup({ unreadable: 'brand_new_secret' }, async ({ result, snapshots, pgDumpArgs }) => {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /brand_new_secret/);
        assert.match(result.stderr, /private_tables/);
        assert.match(result.stderr, /grant select/);
        assert.equal(pgDumpArgs, null, '不能再讓 pg_dump 去撞 permission denied');
        assert.deepEqual(await readdir(snapshots), []);
    });
});

test('其他表的外鍵指向被排除內容的表時中止（原本的孤兒外鍵檢查）', { skip }, async () => {
    await withBackup({ orphans: 'intraday_extra' }, async ({ result, snapshots, pgDumpArgs }) => {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /intraday_extra/);
        assert.match(result.stderr, /violates foreign key constraint/);
        assert.equal(pgDumpArgs, null);
        assert.deepEqual(await readdir(snapshots), []);
    });
});

test('其他表的外鍵指向整張不備份的私密表時中止', { skip }, async () => {
    await withBackup({ privateReferrers: 'private_note_tags' }, async ({ result, snapshots, pgDumpArgs }) => {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /private_note_tags/);
        assert.match(result.stderr, /relation does not exist/);
        assert.equal(pgDumpArgs, null);
        assert.deepEqual(await readdir(snapshots), []);
    });
});

for (const [name, dumpExtra, expected] of [
    ['私密表的資料', 'COPY public.private_notes (id, body) FROM stdin;', /私密表 private_notes/],
    ['私密表的建表語句', 'CREATE TABLE public.admin_bgm (id smallint);', /私密表 admin_bgm/],
    ['私密表的政策', 'CREATE POLICY frank_private_notes_only ON public.private_notes FOR ALL TO authenticated;', /私密表 private_notes/],
    ['私密表的權限', 'GRANT SELECT ON TABLE public.admin_bgm TO authenticated;', /私密表 admin_bgm/],
    ['指向私密表的外鍵', 'ALTER TABLE ONLY public.x ADD CONSTRAINT x_fk FOREIGN KEY (n) REFERENCES public.private_notes(id);', /私密表 private_notes/],
    ['裝置表的內容', 'COPY public.device_sessions (device_id, ip_address) FROM stdin;', /device_sessions 的資料/]
]) {
    test(`排除失效時絕不把${name}寫進快照`, { skip }, async () => {
        await withBackup({ dumpExtra }, async ({ result, snapshots }) => {
            assert.equal(result.status, 1);
            assert.match(result.stderr, expected);
            // 快照目錄會被 commit 進公開的 data 分支，擋在壓縮與寫入之前。
            assert.deepEqual(await readdir(snapshots), []);
        });
    });
}

test('名字只是前綴相同的另一張表不算洩漏私密表', { skip }, async () => {
    await withBackup({ dumpExtra: 'CREATE TABLE public.private_notes_archive (id integer);' }, async ({ result, snapshots }) => {
        assert.equal(result.status, 0, result.stderr);
        assert.equal((await readdir(snapshots)).length, 1);
    });
});

test('每週還原測試只碰當場開的容器：drop schema 不能漏到 Supabase', async () => {
    const workflow = (await readFile(new URL('../.github/workflows/restore-test.yml', import.meta.url), 'utf8'))
        .replaceAll('\r\n', '\n');
    assert.doesNotMatch(workflow, /SUPABASE|secrets\./, '還原測試不該拿到任何連線資訊');

    const code = workflow.split('\n').filter(line => !/^\s*#/.test(line));
    const psqlLines = code.filter(line => /\bpsql\b/.test(line));
    assert.ok(psqlLines.length >= 4);
    assert.ok(psqlLines.every(line => line.includes('docker exec restoretest')),
        '每一個 psql 都要經 docker exec 進拋棄式容器');

    // 備份不含私密表，正式庫的私人筆記只存在正式庫；這句 drop schema 只能對容器裡剛建的資料庫。
    const drops = code.map((line, index) => [line, index]).filter(([line]) => /drop schema/i.test(line));
    assert.equal(drops.length, 1);
    assert.match(code[drops[0][1] - 1], /docker exec restoretest psql -U postgres -d restored/);
});
