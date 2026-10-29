import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/Invest.Web/Infrastructure/StaticSite/Assets/site.js', import.meta.url), 'utf8');
const accountsStart = source.indexOf('const FRANK_ADMIN_EMAIL =');
assert.ok(accountsStart >= 0, '找不到登入帳號設定。');
const accountsEnd = source.indexOf('\n];', accountsStart) + 3;
const accountsDefinition = source.slice(accountsStart, accountsEnd);
const accounts = vm.runInNewContext(`${accountsDefinition}; ACCESS_TIER_ACCOUNTS`, {
    FRANK_ADMIN_EMAIL: 'admin@investment.local'
});
const start = source.indexOf('function klineIndicatorDefaultsOpen() {');
assert.ok(start >= 0, '找不到 K 線指標的權限預設函式。');
const end = source.indexOf('\n}', start) + 2;
const defaultsFunction = source.slice(start, end);

function defaultIsOpen({ access = 'admin', tier = 'admin', email = 'fortune@investment.local' } = {}) {
    const context = {
        SITE_ACCESS: access,
        loginTier: tier,
        loginAccount: email === null ? null : accounts.find(account => account.email === email) ?? null
    };
    return vm.runInNewContext(`${defaultsFunction}; klineIndicatorDefaultsOpen()`, context);
}

test('只有設定為預設展開的財神最高權限帳號會打開 KD 與 MACD', () => {
    assert.equal(defaultIsOpen(), true);
    assert.equal(defaultIsOpen({ email: 'admin@investment.local' }), false);
    assert.equal(defaultIsOpen({ email: 'monitor@investment.local' }), false);
    assert.equal(defaultIsOpen({ email: 'holdings@investment.local' }), false);
    assert.equal(defaultIsOpen({ tier: null, email: null }), false);
    assert.equal(defaultIsOpen({ access: 'viewer' }), false);
});
