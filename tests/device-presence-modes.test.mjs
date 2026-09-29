import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const edgeScript = fs.readFileSync(
    path.join(repositoryRoot, 'supabase', 'functions', 'device-presence', 'index.js'),
    'utf8');
const siteScript = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'Invest.Web', 'Infrastructure', 'StaticSite', 'Assets', 'site.js'),
    'utf8');
const schemaMigration = fs.readFileSync(
    path.join(repositoryRoot, 'db', '061_device_presence_access_modes.sql'),
    'utf8');

function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `找不到 ${name}。`);

    const openingBrace = source.indexOf('{', start);
    let depth = 0;

    for (let index = openingBrace; index < source.length; index += 1) {
        if (source[index] === '{') {
            depth += 1;
        } else if (source[index] === '}') {
            depth -= 1;

            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }

    throw new Error(`${name} 缺少結尾大括號。`);
}

function extractConstant(source, name) {
    const start = source.indexOf(`const ${name} =`);
    assert.ok(start >= 0, `找不到 ${name}。`);

    const end = source.indexOf(';', start);
    assert.ok(end >= 0, `${name} 缺少結尾分號。`);
    return source.slice(start, end + 1);
}

test('裝置登記端接受四種模式並拒絕未知值', () => {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        extractConstant(edgeScript, 'DEVICE_ACCESS_LEVELS'),
        extractFunction(edgeScript, 'isValidDeviceAccessLevel')
    ].join('\n'), context);

    for (const mode of ['admin', 'monitor', 'holdings', 'viewer']) {
        assert.equal(context.isValidDeviceAccessLevel(mode), true, `${mode} 應可登記`);
    }

    assert.equal(context.isValidDeviceAccessLevel('owner'), false);
    assert.match(edgeScript, /if \(!isValidDeviceAccessLevel\(accessLevel\)\)/);
});

test('裝置面板依四種模式顯示筆記指定的名稱', () => {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        extractConstant(siteScript, 'DEVICE_PRESENCE_MODE_LABELS'),
        extractFunction(siteScript, 'devicePresenceModeText'),
        'globalThis.devicePresenceModeLabels = DEVICE_PRESENCE_MODE_LABELS;'
    ].join('\n'), context);

    assert.deepEqual(JSON.parse(JSON.stringify(context.devicePresenceModeLabels)), {
        admin: '最高權限',
        monitor: '監控者',
        holdings: '持倉者',
        viewer: '訪客'
    });
    assert.equal(context.devicePresenceModeText('unknown'), '未知模式');
    assert.match(siteScript, /appendDevicePresenceCell\(row, '模式', devicePresenceModeText\(device\.access_level\)\)/);
});

test('權限切換後立即更新裝置登記，migration 容納四種模式且可重跑', () => {
    const afterAccessChange = extractFunction(siteScript, 'afterAccessChange');
    assert.match(afterAccessChange, /void registerDevicePresence\(\);/);

    for (const mode of ['admin', 'monitor', 'holdings', 'viewer']) {
        assert.match(schemaMigration, new RegExp(`'${mode}'`));
    }

    assert.match(schemaMigration, /drop constraint if exists device_sessions_access_level_check/);
    assert.match(schemaMigration, /on conflict \(filename\) do nothing/);
});
