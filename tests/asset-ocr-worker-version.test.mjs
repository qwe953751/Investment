import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// 2026-10-13：公司 Windows Worker 沒重建，AI OCR 修正對使用者無效卻毫無徵兆。
// 現在 Worker 把版本放在回報的 platform 前面，網站在 readiness 決定交給誰時就比對版本並警告。
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');
const edgeScript = fs.readFileSync(
    path.join(repositoryRoot, 'supabase', 'functions', 'ocr-jobs', 'index.js'),
    'utf8');

function functionSource(script, name) {
    const start = script.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `找不到 ${name}。`);

    const openingBrace = script.indexOf('{', start);
    let depth = 0;

    for (let index = openingBrace; index < script.length; index += 1) {
        if (script[index] === '{') {
            depth += 1;
        } else if (script[index] === '}') {
            depth -= 1;

            if (depth === 0) {
                return script.slice(start, index + 1);
            }
        }
    }

    throw new Error(`${name} 缺少結尾大括號。`);
}

const requiredVersion = Number(/const ASSET_AI_OCR_WORKER_VERSION = (\d+);/.exec(siteScript)?.[1]);

function versionFunctions() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        `const ASSET_AI_OCR_WORKER_VERSION = ${requiredVersion};`,
        functionSource(siteScript, 'assetAiOcrWorkerVersion'),
        functionSource(siteScript, 'assetAiOcrOutdatedWorkerNotice')
    ].join('\n\n'), context);
    return context;
}

test('網站要求的 AI OCR Worker 版本是正整數', () => {
    assert.ok(Number.isInteger(requiredVersion) && requiredVersion >= 2, `目前是 ${requiredVersion}`);
});

test('從 Worker 回報的 platform 讀出 AI OCR 版本；沒有版本字樣的舊 Worker 當 v1', () => {
    const { assetAiOcrWorkerVersion } = versionFunctions();

    assert.equal(assetAiOcrWorkerVersion('Microsoft Windows 10.0.19044'), 1);
    assert.equal(assetAiOcrWorkerVersion('macOS 26.1.0'), 1);
    assert.equal(assetAiOcrWorkerVersion(null), 1);
    assert.equal(assetAiOcrWorkerVersion('AI OCR v2 · Microsoft Windows 10.0.19044'), 2);
    assert.equal(assetAiOcrWorkerVersion('AI OCR v13 · macOS 26.1.0'), 13);
});

test('交給舊版 Worker 時上傳前就警告，並指出是哪一台', () => {
    const { assetAiOcrOutdatedWorkerNotice } = versionFunctions();
    const notice = assetAiOcrOutdatedWorkerNotice({ ready: true, workerPlatform: 'Microsoft Windows 10.0.19044' });

    assert.match(notice, /^⚠ /);
    assert.match(notice, /Windows Worker/);
    assert.match(notice, new RegExp(`v${requiredVersion}`));
    assert.match(notice, /v1/);
    assert.match(notice, /重建/);

    const macNotice = assetAiOcrOutdatedWorkerNotice({ ready: true, workerPlatform: `AI OCR v${requiredVersion - 1} · macOS 26.1.0` });
    assert.match(macNotice, /Mac Worker/);
});

test('負責的 Worker 已是最新版、或這批改走 Tesseract 時不警告', () => {
    const { assetAiOcrOutdatedWorkerNotice } = versionFunctions();

    assert.equal(assetAiOcrOutdatedWorkerNotice({
        ready: true,
        workerPlatform: `AI OCR v${requiredVersion} · Microsoft Windows 10.0.19044`
    }), '');
    assert.equal(assetAiOcrOutdatedWorkerNotice({
        ready: true,
        workerPlatform: `AI OCR v${requiredVersion + 1} · macOS 26.1.0`
    }), '');
    assert.equal(assetAiOcrOutdatedWorkerNotice({ ready: false, workerPlatform: 'Microsoft Windows 10.0.19044' }), '');
    assert.equal(assetAiOcrOutdatedWorkerNotice(null), '');
});

test('警告在辨識中與校對時都顯示，換下一批會清掉', () => {
    assert.match(siteScript, /workerWarning: '',/);
    assert.equal(
        (siteScript.match(/makeAssetOcrWorkerWarning\(assetScreenshotDraft\.workerWarning\)/g) ?? []).length,
        2,
        '辨識中與校對畫面各要顯示一次');
});

test('platform 前面加上版本字樣後，伺服器仍然分得出 Windows 與 Mac', () => {
    const context = {};
    vm.createContext(context);
    vm.runInContext(functionSource(edgeScript, 'isWindowsPlatform'), context);

    assert.equal(context.isWindowsPlatform(`AI OCR v${requiredVersion} · Microsoft Windows 10.0.19044`), true);
    assert.equal(context.isWindowsPlatform(`AI OCR v${requiredVersion} · macOS 26.1.0`), false);
});
