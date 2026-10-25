import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// db/074：美股新持倉的 webhook 觸發器改成「失敗也放行」。
//
// db/073 在 Vault 讀不到端點或 secret 時 raise exception，而觸發器是 AFTER INSERT ... FOR EACH ROW 且沒有 WHEN，
// 是不是美股要到 Edge Function 才判斷，所以 Vault 一缺，任何市場的持倉新增都會整筆失敗。
// 這裡釘住 migration 的結構與它和 073 的對應。行為本身（Vault 缺設定、pg_net 出錯、Vault 表不存在、
// 一次新增多列、權限）已在真正的 PostgreSQL（PGlite）逐項驗證過，並在正式庫做過端到端測試，
// 見 Doc/版本紀錄.md 2026-10-25；這個測試不依賴資料庫，才能在每次發布前跑。

const read = async path => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const withoutComments = sql => sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

const sql073 = withoutComments(await read('db/073_watchlist_webhook_secret.sql'));
const sql074 = withoutComments(await read('db/074_watchlist_webhook_fail_open.sql'));

test('074：任何失敗都只記 warning 並放行寫入，不再 raise exception', () => {
    assert.match(sql073, /raise exception/, '073 就是因為這句才會擋住所有持倉新增');
    assert.doesNotMatch(sql074, /raise exception/i);
    assert.match(sql074, /exception when others then/);
    assert.equal((sql074.match(/raise warning/g) ?? []).length, 2, '設定缺漏、其他錯誤各一則');

    // 兩條路都要 return new，持倉才寫得進去：設定缺漏時在區塊內提早 return，其他錯誤落到最後的 return。
    assert.equal((sql074.match(/return new;/g) ?? []).length, 2);
    assert.match(sql074, /if endpoint is null or webhook_secret is null then\s+raise warning '[^']*';\s+return new;\s+end if;/);
    assert.match(sql074, /end;\s+return new;\s+end;\s+\$\$;/);
});

test('074：warning 只帶 SQLSTATE，不把原始錯誤訊息（可能含端點或 secret）寫進資料庫 log', () => {
    assert.match(sql074, /raise warning 'US watchlist webhook dispatch skipped \(SQLSTATE %\); holding saved', sqlstate;/);
    assert.doesNotMatch(sql074, /sqlerrm/i);
    assert.doesNotMatch(sql074, /raise warning '[^']*'[^;]*\b(endpoint|webhook_secret)\b/i, 'warning 的參數不能帶端點或 secret');
});

test('074：呼叫 webhook 的 url／header／body／逾時與 073 完全一致，沒有被順手改動', () => {
    for (const fragment of [
        "name = 'us_watchlist_webhook_url'",
        "name = 'us_watchlist_webhook_secret'",
        "'Content-Type', 'application/json'",
        "'x-watchlist-webhook-secret', webhook_secret",
        "jsonb_build_object('type', 'INSERT', 'table', 'asset_holdings', 'record', to_jsonb(new))",
        'timeout_milliseconds := 5000'
    ]) {
        assert.ok(sql073.includes(fragment), `073 應包含 ${fragment}`);
        assert.ok(sql074.includes(fragment), `074 應包含 ${fragment}`);
    }
    assert.match(sql074, /security definer\s+set search_path = ''/);
});

test('074：函式定義不含任何金鑰（備份會公開函式定義），也不讀 service_role', () => {
    assert.doesNotMatch(sql074, /eyJ[A-Za-z0-9_-]{10,}|sb_secret_|service_role/);
});

test('074：重新聲明只供觸發器執行，並自我登記進 schema_migrations', () => {
    assert.match(sql074, /revoke all on function public\.dispatch_us_watchlist_webhook\(\)\s+from public, anon, authenticated, invest_writer, invest_backup_reader;/);
    assert.match(sql074, /insert into public\.schema_migrations \(filename\) values \('074_watchlist_webhook_fail_open\.sql'\)\s+on conflict \(filename\) do nothing;/);
    assert.match(sql074, /create or replace function public\.dispatch_us_watchlist_webhook\(\)\s+returns trigger/);
});

test('文件：開發環境說明 Vault 缺設定不再擋持倉寫入，以及怎麼檢查', async () => {
    const doc = await read('Doc/開發環境.md');
    assert.ok(doc.includes('074_watchlist_webhook_fail_open.sql'), '開發環境.md 要提到 db/074');
    const section = doc.slice(doc.indexOf('### 美股新持倉即時觸發'));
    assert.match(section, /Vault[\s\S]{0,120}缺[\s\S]{0,200}(不會擋|照常寫入|不擋)/, '要寫明 Vault 缺設定時持倉仍照常寫入');
    assert.match(section, /US watchlist webhook/, '要寫出 log 裡的 warning 關鍵字，才有辦法檢查');
    assert.match(section, /net\._http_response/);
});
