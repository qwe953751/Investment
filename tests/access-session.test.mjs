import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');

function startupAuthSource() {
    const start = siteScript.indexOf('async function start()');
    assert.ok(start >= 0, '找不到 start。');

    const restore = siteScript.indexOf('    await restoreSession();', start);
    const autoLogin = siteScript.indexOf('    if (AUTOLOGIN_QUERY', start);
    const cleanup = siteScript.indexOf('    // 用過就把 key 從網址列拿掉', start);
    assert.ok(restore >= 0, '找不到 restoreSession 啟動接線。');
    assert.ok(autoLogin >= 0, '找不到 AUTOLOGIN_QUERY 啟動接線。');
    assert.ok(cleanup > 0, '找不到 key 清除接線。');

    return siteScript.slice(Math.min(restore, autoLogin), cleanup);
}

async function runStartupAuth({ key, loginSucceeds }) {
    const context = {};
    vm.createContext(context);

    const source = startupAuthSource();
    const result = await vm.runInContext(`
        (async () => {
            const AUTOLOGIN_QUERY = ${JSON.stringify(key)};
            let loginTier = null;
            const calls = [];

            async function restoreSession() {
                calls.push('restore');
                loginTier = 'holdings';
            }

            async function loginWithPassword() {
                calls.push('login');
                if (${loginSucceeds ? 'true' : 'false'}) {
                    loginTier = 'monitor';
                    return true;
                }

                return false;
            }

            ${source}

            return { tier: loginTier, calls: Array.from(calls) };
        })()
    `, context);

    return {
        tier: result.tier,
        calls: Array.from(result.calls)
    };
}

test('網址 key 優先於既有持倉者 session，並切換到 key 對應權限', async () => {
    const result = await runStartupAuth({
        key: 'monitor-password-placeholder',
        loginSucceeds: true
    });

    assert.equal(result.tier, 'monitor');
    assert.deepEqual(result.calls, ['login']);
});

test('網址 key 驗證失敗時，才回復既有 refresh session', async () => {
    const result = await runStartupAuth({
        key: 'invalid-password-placeholder',
        loginSucceeds: false
    });

    assert.equal(result.tier, 'holdings');
    assert.deepEqual(result.calls, ['login', 'restore']);
});

test('沒有網址 key 時，維持既有 refresh session 的恢復行為', async () => {
    const result = await runStartupAuth({
        key: null,
        loginSucceeds: false
    });

    assert.equal(result.tier, 'holdings');
    assert.deepEqual(result.calls, ['restore']);
});
