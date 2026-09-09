import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const site = fs.readFileSync(
    path.join(root, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');
const html = fs.readFileSync(
    path.join(root, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'index.html'),
    'utf8');
const worker = fs.readFileSync(
    path.join(root, 'src', 'Invest.Web', 'Features', 'Assets', 'Ocr', 'Services', 'OcrWorkerRunner.cs'),
    'utf8');
const api = fs.readFileSync(
    path.join(root, 'src', 'Invest.Web', 'Features', 'Assets', 'Ocr', 'Services', 'OcrWorkerApiClient.cs'),
    'utf8');
const shareFunction = fs.readFileSync(
    path.join(root, 'supabase', 'functions', 'access-share', 'index.js'),
    'utf8');
const shareMigration = fs.readFileSync(
    path.join(root, 'db', '043_access_share_links.sql'),
    'utf8');
const realtimeMigration = fs.readFileSync(
    path.join(root, 'db', '044_ocr_realtime.sql'),
    'utf8');
const claimWakeMigration = fs.readFileSync(
    path.join(root, 'db', '047_ocr_realtime_claim_wake.sql'),
    'utf8');

test('central navigation rerenders the top-level tab and rejects unavailable views', () => {
    const update = site.match(/function update\(changes\) \{[\s\S]*?\r?\n\}\r?\n\r?\nlet snapshotNote/);
    assert.ok(update, '找不到中央 update()。');
    assert.match(update[0], /availableViews\(\)\.some\(view => view\.key === changes\.view\)/);
    assert.match(update[0], /marketSwitchRender\?\.\(\)/);

    const viewTabs = site.match(/function mspBuildViewTabs\([\s\S]*?\r?\n\}\r?\n\r?\n\/\/ 把原本標題/);
    assert.ok(viewTabs, '找不到主頁籤建構器。');
    assert.doesNotMatch(viewTabs[0], /\n\s*paint\(\);/);
});

test('holdings-only topic entries are non-navigable', () => {
    const link = site.match(/function makeTopicLink\([\s\S]*?\r?\n\}\r?\n\r?\nfunction makeTopicLevelLabel/);
    assert.ok(link, '找不到族群連結建構器。');
    assert.match(link[0], /SITE_ACCESS === 'holdings'/);
    assert.match(site, /id && topicById\.has\(id\) && SITE_ACCESS !== 'holdings'/);
});

test('permission sharing uses an opaque invite flow, not a password URL', () => {
    assert.match(site, /ACCESS_SHARE_FUNCTION/);
    assert.match(site, /INVITE_QUERY/);
    assert.match(site, /access-bar-share/);
    assert.match(html, /id="access-bar-share"/);
    assert.match(site, /history\.replaceState[\s\S]*delete\('invite'\)/);
    assert.match(shareFunction, /crypto\.subtle\.digest/);
    assert.match(shareFunction, /admin\/generate_link/);
    assert.match(shareFunction, /access_share_redeem/);
    assert.match(shareMigration, /revoked_at/);
    assert.match(shareMigration, /max_uses/);
});

test('OCR worker has an event-driven wake path and no idle claim polling', () => {
    assert.match(api, /ClientWebSocket/);
    assert.match(api, /RunWakeListenerAsync/);
    assert.match(api, /realtime_join_failed/);
    assert.match(worker, /RunWakeListenerAsync/);
    assert.doesNotMatch(worker, /Task\.Delay\(options\.PollInterval, cancellationToken\)/);
    assert.match(worker, /TimeSpan\.FromSeconds\(60\)/);
    assert.match(realtimeMigration, /realtime\.send/);
    assert.match(realtimeMigration, /realtime\.topic\(\)/);
    assert.match(realtimeMigration, /access_role.*ocr_worker/);
    assert.match(claimWakeMigration, /ocr_jobs_queue_broadcast/);
    assert.match(claimWakeMigration, /ocr_evaluations_queue_broadcast/);
    assert.match(claimWakeMigration, /ocr_wake_job/);
    assert.doesNotMatch(claimWakeMigration, /execute function public\.ocr_queue_broadcast\(\)/);
    assert.match(site, /assetAiOcrWake\(/);
    assert.match(site, /ASSET_AI_OCR_WAKE_AFTER_MS = 5_000/);
});
