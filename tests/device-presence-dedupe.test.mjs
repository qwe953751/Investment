import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const functionScript = fs.readFileSync(
    path.join(repositoryRoot, 'supabase', 'functions', 'device-presence', 'index.js'),
    'utf8');

function functionSource(name) {
    const start = functionScript.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `找不到 ${name}，無法驗證裝置去重規則。`);

    const openingBrace = functionScript.indexOf('{', start);
    let depth = 0;

    for (let index = openingBrace; index < functionScript.length; index += 1) {
        if (functionScript[index] === '{') {
            depth += 1;
        } else if (functionScript[index] === '}') {
            depth -= 1;

            if (depth === 0) {
                return functionScript.slice(start, index + 1);
            }
        }
    }

    throw new Error(`${name} 缺少結尾大括號。`);
}

function constantSource(name) {
    const pattern = new RegExp(`const ${name}\\s*=[^;]+;`);
    const match = functionScript.match(pattern);
    assert.ok(match, `找不到常數 ${name}。`);
    return match[0];
}

function deduplicateDeviceSessions() {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        constantSource('UNKNOWN_DEVICE_NAME'),
        constantSource('DEVICE_DEDUPE_MIN_AGE_MS'),
        functionSource('deduplicateDeviceSessions')
    ].join('\n'), context);

    return context.deduplicateDeviceSessions;
}

test('同 IP、同權限但名稱皆為未知裝置時不視為重複', () => {
    const dedupe = deduplicateDeviceSessions();
    const now = Date.now();
    const devices = [
        {
            device_id: 'device-newer-000000000001',
            device_name: '未知裝置',
            ip_address: '1.2.3.4',
            access_level: 'admin',
            user_agent: 'ua-a',
            last_seen_at: new Date(now).toISOString()
        },
        {
            device_id: 'device-older-000000000002',
            device_name: '未知裝置',
            ip_address: '1.2.3.4',
            access_level: 'admin',
            user_agent: 'ua-b',
            last_seen_at: new Date(now - 60_000).toISOString()
        }
    ];

    const { duplicateIds, uniqueDevices } = dedupe(devices, now);

    assert.deepEqual(JSON.parse(JSON.stringify(duplicateIds)), []);
    assert.equal(uniqueDevices.length, 2);
});

test('比對鍵含 user_agent，不同瀏覽器的裝置不會互相覆蓋', () => {
    const dedupe = deduplicateDeviceSessions();
    const now = Date.now();
    const devices = [
        {
            device_id: 'device-chrome-00000000001',
            device_name: '我的筆電',
            ip_address: '1.2.3.4',
            access_level: 'admin',
            user_agent: 'Chrome',
            last_seen_at: new Date(now).toISOString()
        },
        {
            device_id: 'device-safari-00000000002',
            device_name: '我的筆電',
            ip_address: '1.2.3.4',
            access_level: 'admin',
            user_agent: 'Safari',
            last_seen_at: new Date(now - 60_000).toISOString()
        }
    ];

    const { duplicateIds, uniqueDevices } = dedupe(devices, now);

    assert.deepEqual(JSON.parse(JSON.stringify(duplicateIds)), []);
    assert.equal(uniqueDevices.length, 2);
});

test('同鍵重複列若在 24 小時內仍保留，避免誤刪使用中的裝置', () => {
    const dedupe = deduplicateDeviceSessions();
    const now = Date.now();
    const devices = [
        {
            device_id: 'device-newest-0000000001',
            device_name: '我的手機',
            ip_address: '5.6.7.8',
            access_level: 'viewer',
            user_agent: 'Chrome',
            last_seen_at: new Date(now).toISOString()
        },
        {
            device_id: 'device-recent-0000000002',
            device_name: '我的手機',
            ip_address: '5.6.7.8',
            access_level: 'viewer',
            user_agent: 'Chrome',
            last_seen_at: new Date(now - 3_600_000).toISOString()
        }
    ];

    const { duplicateIds, uniqueDevices } = dedupe(devices, now);

    assert.deepEqual(JSON.parse(JSON.stringify(duplicateIds)), []);
    assert.equal(uniqueDevices.length, 2);
});

test('同鍵重複列超過 24 小時才會被清除，且保留最新一筆', () => {
    const dedupe = deduplicateDeviceSessions();
    const now = Date.now();
    const devices = [
        {
            device_id: 'device-newest-0000000003',
            device_name: '我的手機',
            ip_address: '5.6.7.8',
            access_level: 'viewer',
            user_agent: 'Chrome',
            last_seen_at: new Date(now).toISOString()
        },
        {
            device_id: 'device-stale-00000000004',
            device_name: '我的手機',
            ip_address: '5.6.7.8',
            access_level: 'viewer',
            user_agent: 'Chrome',
            last_seen_at: new Date(now - 25 * 60 * 60 * 1000).toISOString()
        }
    ];

    const { duplicateIds, uniqueDevices } = dedupe(devices, now);

    assert.deepEqual(JSON.parse(JSON.stringify(duplicateIds)), ['device-stale-00000000004']);
    assert.equal(uniqueDevices.length, 1);
    assert.equal(uniqueDevices[0].device_id, 'device-newest-0000000003');
});
