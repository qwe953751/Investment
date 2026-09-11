import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8').replaceAll('\r\n', '\n');

test('筆記 #65 的前五日熱絡分數可切換到指定盤後交易日', () => {
    assert.match(siteScript, /const item = document\.createElement\('button'\);\s*item\.type = 'button';/);
    assert.match(siteScript, /item\.addEventListener\('click', \(\) => \{\s*update\(\{ view: 'daily', date: day\.tradingDate \}\);\s*\}\);/);
    assert.match(siteScript, /item\.setAttribute\('aria-label', `查看 \$\{displayDate\} 盤後熱絡分數`\);/);
});

test('筆記 #64 的 U1 手機裝置浮層不以右側按鈕錯誤定位', () => {
    assert.match(siteScript, /body\[data-msp-nav-variant="u1"\] \.msp-market-bar \.msp-utility-slot \.device-presence-panel\s*\{\s*left: 0;\s*right: auto;/);
    assert.match(siteScript, /width: min\(560px, calc\(100vw - 24px\)\);\s*max-width: calc\(100vw - 24px\);/);
});
