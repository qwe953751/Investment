import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// 筆記 #61：CDN 快照的 cache-control 因為掛在 .NET 的 Content.Headers 上被靜默丟棄，
// 三週來 Supabase Storage 存的都是 no-cache。note-images 這條路徑是純前端 fetch，
// 沒有那個陷阱，但一樣完全沒有送 cache-control——修的時候順手補上。
// 這裡直接執行 uploadNoteImage()，攔截 fetch 呼叫，斷言標頭真的帶了長 TTL 與 immutable，
// 不是只檢查原始碼字串出現過那個值。
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');

function functionSource(name) {
    const starts = [
        siteScript.indexOf(`function ${name}(`),
        siteScript.indexOf(`async function ${name}(`)
    ].filter(index => index >= 0);
    assert.ok(starts.length > 0, `找不到 ${name}。`);
    const start = Math.min(...starts);

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

function constantSource(name) {
    const pattern = new RegExp(`const ${name}\\s*=[^;]+;`);
    const match = siteScript.match(pattern);
    assert.ok(match, `找不到常數 ${name}。`);
    return match[0];
}

function createUploadNoteImage({ fetchImpl }) {
    const context = {
        supabase: { url: 'https://example.supabase.co', anonKey: 'anon-key' },
        crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
        fetch: fetchImpl,
        console
    };
    vm.createContext(context);
    vm.runInContext([
        constantSource('NOTE_IMAGES_BUCKET'),
        constantSource('NOTE_IMAGE_MAX_BYTES'),
        constantSource('NOTE_IMAGE_EXTENSIONS'),
        constantSource('NOTE_IMAGE_TYPES'),
        constantSource('NOTE_IMAGE_SOURCE_EXTENSIONS'),
        constantSource('NOTE_IMAGE_SOURCE_TYPES'),
        functionSource('noteImageSourceType'),
        functionSource('encodeStoragePath'),
        functionSource('uploadNoteImage')
    ].join('\n'), context);

    return context.uploadNoteImage;
}

test('筆記圖片上傳會送出長 TTL 與 immutable 的 cache-control', async () => {
    let capturedUrl = null;
    let capturedInit = null;
    const uploadNoteImage = createUploadNoteImage({
        fetchImpl: async (url, init) => {
            capturedUrl = url;
            capturedInit = init;
            return { ok: true, status: 200, json: async () => ({}) };
        }
    });

    const image = { file: { size: 1024, type: 'image/png', name: 'a.png' } };
    const result = await uploadNoteImage('note-1', image);

    assert.equal(capturedInit.method, 'POST');
    assert.equal(capturedInit.headers['cache-control'], 'max-age=31536000, immutable');
    assert.match(capturedUrl, /\/storage\/v1\/object\/note-images\/notes\/note-1\//);
    assert.equal(result.mimeType, 'image/png');
});

test('筆記圖片上傳失敗時不吞掉 HTTP 狀態', async () => {
    const uploadNoteImage = createUploadNoteImage({
        fetchImpl: async () => ({ ok: false, status: 413, json: async () => ({ message: '太大了' }) })
    });

    const image = { file: { size: 1024, type: 'image/png', name: 'a.png' } };

    await assert.rejects(
        () => uploadNoteImage('note-1', image),
        /413/);
});
