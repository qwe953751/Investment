import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');

function functionSource(name) {
    const match = siteScript.match(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(match, `找不到 ${name}。`);

    const start = match.index;
    const openingBrace = siteScript.indexOf('{', siteScript.indexOf(')', start));
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

function optionalFunctionSource(name) {
    return siteScript.includes(`function ${name}(`) || siteScript.includes(`async function ${name}(`)
        ? functionSource(name)
        : '';
}

function commonLoadSource(functionName) {
    return [
        optionalFunctionSource('fetchJsonAttempt'),
        optionalFunctionSource('fetchJsonWithRetry'),
        optionalFunctionSource('staticJsonLoadErrorMessage'),
        functionSource(functionName)
    ].filter(Boolean).join('\n');
}

function periodHarness() {
    let calls = 0;
    const context = {
        cache: new Map(),
        periodLoadErrors: new Map(),
        version: 'test-version',
        AbortController,
        clearTimeout,
        setTimeout,
        fetch: async () => {
            calls += 1;

            if (calls === 1) {
                throw new TypeError('simulated offline');
            }

            return {
                ok: true,
                json: async () => ({ rows: [{ ticker: '2330' }] })
            };
        }
    };

    vm.createContext(context);
    vm.runInContext(commonLoadSource('fetchPeriod'), context);

    return {
        fetchPeriod: context.fetchPeriod,
        calls: () => calls
    };
}

test('期間快照遇到暫時斷線後會自動重試並完成載入', async () => {
    const harness = periodHarness();
    const result = await harness.fetchPeriod('1-2026-09-08');

    assert.deepEqual(JSON.parse(JSON.stringify(result)), { rows: [{ ticker: '2330' }] });
    assert.equal(harness.calls(), 2);
});

function jsonBodyTimeoutHarness() {
    const context = {
        AbortController,
        clearTimeout,
        setTimeout,
        fetch: async () => ({
            ok: true,
            json: () => new Promise(() => {})
        })
    };

    vm.createContext(context);
    vm.runInContext(optionalFunctionSource('fetchJsonAttempt'), context);

    return context.fetchJsonAttempt('data/test.json', {}, 10);
}

test('大型 JSON 的 response body 卡住時也會在逾時後返回錯誤', async () => {
    await assert.rejects(jsonBodyTimeoutHarness(), error => error?.name === 'TimeoutError');
});

function topicsHarness() {
    let calls = 0;
    const panel = {
        children: [],
        replaceChildren(...children) {
            this.children = children;
        },
        append(...children) {
            this.children.push(...children);
        }
    };
    const context = {
        TOPIC_EDITOR_PROTOTYPE: false,
        state: { topicTab: 'heat' },
        version: 'test-version',
        AbortController,
        clearTimeout,
        setTimeout,
        fetch: async () => {
            calls += 1;

            if (calls <= 3) {
                throw new TypeError('simulated offline');
            }

            return {
                ok: true,
                json: async () => ({ mappings: [], periods: [], activeVersion: null })
            };
        },
        el: () => panel,
        makeTopicNotice: message => ({ message }),
        prepareTopics() {},
        renderSnapshotNote() {},
        renderTopicTabs() {},
        isIntradayTopicDataView: () => false,
        loadIntradayTopicHeat: async () => {},
        renderTopicPanel() {}
    };

    vm.createContext(context);
    vm.runInContext([
        'let topicData = null;',
        'let topicLoadError = "";',
        'let topicLoading = false;',
        commonLoadSource('loadTopics')
    ].join('\n'), context);

    return {
        loadTopics: context.loadTopics,
        calls: () => calls,
        topicData: () => vm.runInContext('topicData', context)
    };
}

test('族群快照持續失敗後，按重試可在不重整整頁下恢復', async () => {
    const harness = topicsHarness();

    await harness.loadTopics();
    assert.equal(harness.topicData(), null);

    await harness.loadTopics(true);
    assert.deepEqual(JSON.parse(JSON.stringify(harness.topicData())), {
        mappings: [],
        periods: [],
        activeVersion: null
    });
    assert.equal(harness.calls(), 4);
});

test('啟動流程不應以補充資料 Promise.all 阻塞核心排行', () => {
    const start = functionSource('start');

    assert.doesNotMatch(start, /await Promise\.all\(\[loadRevenue\(\), loadAttributions\(\)\]\)/);
    assert.match(start, /loadRevenue\(\)/);
    assert.match(start, /loadAttributions\(\)/);
});
