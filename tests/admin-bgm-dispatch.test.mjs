import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'supabase/functions/admin-bgm-dispatch/index.js'), 'utf8');
const site = fs.readFileSync(path.join(root, 'src/Invest.Web/Infrastructure/StaticSite/Assets/site.js'), 'utf8');
const importId = '33aad58f-287a-459b-b586-60f155dac400';

function handlerFor(role, row = { import_id: importId, import_status: 'pending' }) {
    const calls = [];
    let handler;
    const context = {
        Deno: {
            env: { get: key => ({
                SUPABASE_URL: 'https://example.supabase.co',
                SUPABASE_SERVICE_ROLE_KEY: 'server-key',
                GH_ACTIONS_PAT: 'github-token'
            })[key] },
            serve: value => { handler = value; }
        },
        Response,
        console: { error() {} },
        fetch: async (url, options) => {
            calls.push({ url, options });
            if (url.endsWith('/auth/v1/user')) {
                return Response.json({ app_metadata: { access_role: role } });
            }
            if (url.includes('/rest/v1/admin_bgm?')) return Response.json([row]);
            if (url.endsWith('/admin-bgm-import.yml/dispatches')) return new Response(null, { status: 204 });
            throw new Error(`unexpected request: ${url}`);
        }
    };
    vm.runInNewContext(source, context);
    return { handler, calls };
}

function request() {
    return new Request('https://example.supabase.co/functions/v1/admin-bgm-dispatch', {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-user-jwt', Origin: 'https://frank-invest.github.io' },
        body: JSON.stringify({ import_id: importId })
    });
}

test('new BGM request calls authenticated dispatch after queue write', () => {
    const submit = site.match(/async function submitAdminBgmImport\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(submit);
    assert.ok(submit.indexOf("method: 'PATCH'") < submit.indexOf('/functions/v1/admin-bgm-dispatch'));
    assert.match(submit, /body: JSON\.stringify\(\{ import_id: payload\.import_id \}\)/);
});

test('only current pending admin import can start BGM workflow', async () => {
    const admin = handlerFor('admin');
    const accepted = await admin.handler(request());
    assert.equal(accepted.status, 202);
    assert.equal(admin.calls.length, 3);
    assert.match(admin.calls[2].url, /admin-bgm-import\.yml\/dispatches$/);
    assert.equal(JSON.parse(admin.calls[2].options.body).ref, 'main');

    const viewer = handlerFor('holdings');
    assert.equal((await viewer.handler(request())).status, 403);
    assert.equal(viewer.calls.length, 1);

    const replaced = handlerFor('admin', { import_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', import_status: 'pending' });
    assert.equal((await replaced.handler(request())).status, 409);
    assert.equal(replaced.calls.length, 2);
});
