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

function retryPolicyHarness() {
    const timeoutValues = [];
    const context = {
        fetchJsonAttempt: async (_url, _options, timeoutMs) => {
            timeoutValues.push(timeoutMs);
            return { ok: true };
        }
    };

    vm.createContext(context);
    vm.runInContext(optionalFunctionSource('fetchJsonWithRetry'), context);

    return {
        fetchJsonWithRetry: context.fetchJsonWithRetry,
        timeoutValues: () => timeoutValues
    };
}

test('JSON 載入器會把每種資料的逾時與重試政策傳給單次請求', async () => {
    const harness = retryPolicyHarness();

    await harness.fetchJsonWithRetry(
        'data/topics.json',
        {},
        { timeoutMs: 30_000, retryDelays: [1_000] });

    assert.deepEqual(harness.timeoutValues(), [30_000]);
});

test('大型靜態資料使用較長逾時且只做一次重試', () => {
    const period = functionSource('fetchPeriod');
    const topics = functionSource('loadTopics');

    for (const source of [period, topics]) {
        assert.match(source, /timeoutMs: 30_000/);
        assert.match(source, /retryDelays: \[1_000\]/);
    }
});

function authRequestHarness() {
    let policy;
    const context = {
        supabase: { url: 'https://example.supabase.co', anonKey: 'anon-key' },
        PODCAST_NOTES_LOCAL_PREVIEW: false,
        fetchJsonWithRetry: async (_url, _options, nextPolicy) => {
            policy = nextPolicy;
            return { access_token: 'access-token', refresh_token: 'refresh-token' };
        }
    };

    vm.createContext(context);
    vm.runInContext(functionSource('authRequest'), context);

    return {
        authRequest: context.authRequest,
        policy: () => policy
    };
}

test('Auth 請求使用單次有界請求，不放大成三次重試', async () => {
    const harness = authRequestHarness();
    const result = await harness.authRequest('password', { email: 'test@example.com' });

    assert.equal(result.session.access_token, 'access-token');
    assert.equal(result.error, null);
    assert.deepEqual(JSON.parse(JSON.stringify(harness.policy())), {
        timeoutMs: 8_000,
        retryDelays: []
    });
});

function loginTransportFailureHarness() {
    let calls = 0;
    const context = {
        ACCESS_TIER_ACCOUNTS: [
            { email: 'one@example.com' },
            { email: 'two@example.com' }
        ],
        authRequest: async () => {
            calls += 1;
            return { session: null, error: { transportFailure: true } };
        },
        isTransientAuthError: error => error?.transportFailure === true,
        activateLoginAccount() {}
    };

    vm.createContext(context);
    vm.runInContext(functionSource('loginWithPassword'), context);

    return {
        loginWithPassword: context.loginWithPassword,
        calls: () => calls
    };
}

test('Auth 遇到網路失敗時停止帳號輪詢，不逐一重試四組帳號', async () => {
    const harness = loginTransportFailureHarness();

    assert.equal(await harness.loginWithPassword('password'), false);
    assert.equal(harness.calls(), 1);
});

function intradayCdnHarness() {
    const calls = [];
    const context = {
        URL,
        location: { href: 'https://frank-invest.github.io/' },
        intradayCdn: { latestUrl: 'https://cdn.example/latest.json' },
        intradaySnapshotRunId: null,
        intradayRaw: null,
        intradaySummary: null,
        intradayCdnUrl: file => `https://cdn.example/${file}`,
        validateIntradayCdnSnapshot() {},
        fetchJsonAttempt: async (url, _options, timeoutMs) => {
            calls.push({ url: String(url), timeoutMs });

            return calls.length === 1
                ? {
                    schemaVersion: 1,
                    runId: 7,
                    tradeDate: '2026-09-08',
                    capturedAt: '2026-09-08T01:00:00Z',
                    file: 'intraday-20260908-0900-run7.json',
                    rowCount: 1
                }
                : {
                    schemaVersion: 1,
                    runId: 7,
                    rows: [{ symbol: '2330' }],
                    summary: {
                        trade_date: '2026-09-08',
                        captured_at: '2026-09-08T01:00:00Z'
                    }
                };
        }
    };

    vm.createContext(context);
    vm.runInContext(functionSource('fetchIntradayCdnSnapshot'), context);

    return {
        fetchIntradayCdnSnapshot: context.fetchIntradayCdnSnapshot,
        calls: () => calls
    };
}

test('盤中 CDN 的指標與完整快照都有獨立的有界逾時', async () => {
    const harness = intradayCdnHarness();

    await harness.fetchIntradayCdnSnapshot();

    assert.deepEqual(harness.calls().map(call => call.timeoutMs), [10_000, 15_000]);
});

test('盤中資料庫 fallback 的分頁與摘要也有獨立的有界逾時', () => {
    const rows = functionSource('fetchIntradayRows');
    const summary = functionSource('fetchIntradaySummaryRow');

    assert.match(rows, /15_000/);
    assert.match(summary, /fetchJsonAttempt/);
    assert.match(summary, /10_000/);
});

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
    assert.match(start, /if \(!isIntradayDataView\(\)\)/);
    assert.match(start, /loadRevenue\(\)/);
    assert.match(start, /loadAttributions\(\)/);
});

test('盤中快照完成後才背景載入補充資料，不等待補充資料', () => {
    const ensure = functionSource('ensureIntradaySnapshot');

    assert.doesNotMatch(ensure, /await Promise\.all\(\[loadMarketFlags\(\), loadRevenue\(force\)\]\)/);
    assert.match(ensure, /void Promise\.all\(\[loadMarketFlags\(\), loadRevenue\(force\)\]\)/);
});
