import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

async function load(name, values = {}) {
    const extension = name === 'us-watchlist-dispatch' ? 'ts' : 'js';
    const source = await readFile(new URL(`../supabase/functions/${name}/index.${extension}`, import.meta.url), 'utf8');
    let handler;
    const sandbox = vm.createContext({
        Deno: { env: { get: key => values[key] }, serve: fn => { handler = fn; } },
        Response, Request, Headers, URL, TextEncoder, crypto: webcrypto,
        console: { error() {}, log() {} },
        fetch: async () => { throw new Error('Unexpected network request'); }
    });
    vm.runInContext(source, sandbox);
    return { sandbox, handler };
}

for (const name of ['ocr-jobs', 'access-share', 'us-watchlist-dispatch']) {
    test(`${name}：新 secret key 放 apikey，不當成 Bearer JWT`, async () => {
        const { sandbox } = await load(name, { INVEST_SERVICE_ROLE_KEY: 'sb_secret_test_only', SUPABASE_SERVICE_ROLE_KEY: 'old-key' });
        const headers = vm.runInContext('serviceHeaders()', sandbox);
        assert.equal(headers.apikey, 'sb_secret_test_only');
        assert.equal(headers.Authorization, undefined);
    });
}

test('device-presence：新 secret key 不送 Bearer，既有使用者 JWT 仍可額外指定', async () => {
    const { sandbox } = await load('device-presence');
    const headers = vm.runInContext('databaseHeaders("sb_secret_test_only", {Authorization:"Bearer user-jwt"})', sandbox);
    assert.equal(headers.apikey, 'sb_secret_test_only');
    assert.equal(headers.Authorization, 'Bearer user-jwt');
});

test('webhook 拒絕未簽名或已外洩的 service_role JWT，不會觸發 GitHub', async () => {
    const { handler } = await load('us-watchlist-dispatch', { US_WATCHLIST_WEBHOOK_SECRET: 'test-webhook-secret' });
    const jwt = 'header.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.signature';
    const response = await handler(new Request('https://example.invalid', {
        method: 'POST', headers: { Authorization: 'Bearer ' + jwt }, body: '{}'
    }));
    assert.equal(response.status, 403);
});

test('webhook 只接受配對 secret，錯誤與未設定 secret 均拒絕', async () => {
    for (const [configured, supplied, status] of [
        ['test-secret', 'test-secret', 200], ['test-secret', 'wrong-secret', 403], ['', '', 403]
    ]) {
        const { handler } = await load('us-watchlist-dispatch', { US_WATCHLIST_WEBHOOK_SECRET: configured });
        const response = await handler(new Request('https://example.invalid', {
            method: 'POST', headers: { 'x-watchlist-webhook-secret': supplied }, body: '{}'
        }));
        assert.equal(response.status, status);
    }
});

test('所有雲端函式優先讀取獨立輪替金鑰', async () => {
    for (const name of ['ocr-jobs', 'access-share', 'asset-operation-sync', 'admin-bgm-dispatch', 'us-watchlist-dispatch']) {
        const { sandbox } = await load(name, { INVEST_SERVICE_ROLE_KEY: 'sb_secret_test_only', SUPABASE_SERVICE_ROLE_KEY: 'old-key' });
        const variable = name === 'admin-bgm-dispatch' ? 'SERVICE_KEY' : 'SERVICE_ROLE_KEY';
        assert.equal(vm.runInContext(variable, sandbox), 'sb_secret_test_only');
    }
});
