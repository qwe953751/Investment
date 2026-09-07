import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');

function functionSource(name) {
    const start = siteScript.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `找不到 ${name}。`);

    const openingBrace = siteScript.indexOf('{', start);
    let depth = 0;

    for (let index = openingBrace; index < siteScript.length; index += 1) {
        if (siteScript[index] === '{') {
            depth += 1;
        } else if (siteScript[index] === '}') {
            depth -= 1;

            if (depth === 0) {
                return siteScript.slice(start, index + 1);
            }
        }
    }

    throw new Error(`${name} 缺少結尾大括號。`);
}

test('族群成員營收增減沿用營收彈窗按鈕', () => {
    const source = functionSource('makeTopicMemberTable');

    assert.match(source, /const revenueButton = document\.createElement\('button'\)/);
    assert.match(source, /revenueButton\.className = 'revenue-cell-button'/);
    assert.match(source, /revenueButton\.dataset\.ticker = member\.ticker/);
    assert.match(source, /revenueButton\.setAttribute\('aria-controls', 'revenue-popover'\)/);
    assert.match(source, /toggleRevenueDetails\(member\.ticker, memberName, revenueButton\)/);
    assert.match(source, /revenueCell\.append\(revenueButton\)/);
});
