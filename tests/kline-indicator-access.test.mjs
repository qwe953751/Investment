import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/Invest.Web/Infrastructure/StaticSite/Assets/site.js', import.meta.url), 'utf8');
const start = source.indexOf('function klineIndicatorDefaultsOpen() {');
assert.ok(start >= 0, '找不到 K 線指標的權限預設函式。');
const end = source.indexOf('\n}', start) + 2;
const defaultsFunction = source.slice(start, end);

function defaultIsOpen({ access = 'admin', tier = 'admin', email = 'admin@investment.local' } = {}) {
    const context = {
        SITE_ACCESS: access,
        loginTier: tier,
        loginAccount: email === null ? null : { email },
        FRANK_ADMIN_EMAIL: 'admin@investment.local'
    };
    return vm.runInNewContext(`${defaultsFunction}; klineIndicatorDefaultsOpen()`, context);
}

test('只有指定的主要最高權限帳號預設展開 KD 與 MACD', () => {
    assert.equal(defaultIsOpen(), true);
    assert.equal(defaultIsOpen({ email: 'fortune@investment.local' }), false);
    assert.equal(defaultIsOpen({ tier: null, email: null }), false);
    assert.equal(defaultIsOpen({ access: 'viewer', tier: 'admin' }), false);
});
