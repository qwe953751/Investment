import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');

test('筆記 #56 的市場導覽小控件保持在頁面最上層', () => {
    const utilityLayerRule = siteScript.match(
        /\.msp-market-bar\[data-nav-variant\] \.msp-utility-slot\s*\{([\s\S]*?)\}/);

    assert.ok(utilityLayerRule, '找不到市場導覽小控件的 stacking layer 規則。');
    assert.match(utilityLayerRule[1], /position:\s*relative;/);
    assert.match(utilityLayerRule[1], /z-index:\s*40;/);
});
