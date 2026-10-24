import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/daily-snapshot.yml', import.meta.url), 'utf8');
const match = workflow.match(/name: 判斷排程是否仍可執行\n\s+shell: bash\n\s+run: \|\n([\s\S]*?)\n  snapshot:/);
const shell = match[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');

for (const [backup, publish, status, expected] of [
    [true, false, 0, 'should_run=false'],
    [true, true, 1, null],
    [false, true, 0, 'should_run=true'],
    [false, false, 0, 'should_run=true']
]) {
    test(`實際 preflight shell：backup-only=${backup}, publish-only=${publish}`, async () => {
        const folder = await mkdtemp(join(tmpdir(), 'backup-preflight-'));
        try {
            const output = join(folder, 'output');
            const script = shell.replaceAll('${{ inputs.backup-only }}', String(backup))
                .replaceAll('${{ inputs.publish-only }}', String(publish));
            const result = spawnSync('bash', ['-e', '-c', script], {
                encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_OUTPUT: output }
            });
            assert.equal(result.status, status, result.stderr);
            if (expected) assert.match(await readFile(output, 'utf8'), new RegExp(expected));
        } finally { await rm(folder, { recursive: true, force: true }); }
    });
}

test('排行略過或失敗仍有備份 job，純發布不動獨立備份警報', () => {
    const job = workflow.split('\n  backup:')[1];
    assert.match(job, /needs: \[preflight, snapshot\]/);
    assert.match(job, /always\(\) && !cancelled\(\) && inputs\.publish-only != true/);
    assert.doesNotMatch(job, /needs\.snapshot\.(?:result|outputs)/);
    const alert = job.split('name: 更新原生資料備份獨立警報')[1];
    assert.match(alert, /steps\.saved\.outcome/);
    assert.doesNotMatch(alert, /job\.status|steps\.dump\.outcome/);
    assert.match(job, /origin\/data:\$file/);
});

test('還原 job 只有解密金鑰，正式資料庫連線僅交給通知 job', async () => {
    const restoreWorkflow = await readFile(new URL('../.github/workflows/restore-test.yml', import.meta.url), 'utf8');
    const [restore, alert] = restoreWorkflow.split('\n  alert:');
    assert.doesNotMatch(restore, /SUPABASE_DB_URL/);
    assert.match(restore, /PROTECTED_BACKUP_DECRYPT_KEY/);
    assert.match(restore, /prepare-test/);
    assert.match(restore, /restore-input\/verify\.sql/);
    assert.match(alert, /needs: restore/);
    assert.match(alert, /備份還原驗證/);
});
