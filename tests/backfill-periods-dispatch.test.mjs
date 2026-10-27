import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { jobBlock, readWorkflow, stepBlock, stepRun } from './helpers/workflow-steps.mjs';

const workflow = await readWorkflow('backfill-periods.yml');
const dispatch = stepRun(stepBlock(jobBlock(workflow, 'backfill'), '派送下一批或發布已保存資料'));

function run({ weekday, hour, runs = 1, remaining = 75, attempted = 75 }) {
    const script = `
date() {
    case "$*" in
        '+%u') echo "$FAKE_WEEKDAY" ;;
        '+%H') echo "$FAKE_HOUR" ;;
        *) command date "$@" ;;
    esac
}
gh() { printf 'DISPATCH %s\\n' "$*"; }
${dispatch}
`;
    return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
        encoding: 'utf8',
        env: { ...process.env, AUTO_CONTINUE: 'true', ATTEMPTED: String(attempted),
            REMAINING: String(remaining), RUNS: String(runs), FAKE_WEEKDAY: String(weekday),
            FAKE_HOUR: String(hour).padStart(2, '0') }
    });
}

test('weekday before 15:00 continues the bounded backfill', () => {
    const result = run({ weekday: 2, hour: 14 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DISPATCH workflow run backfill-periods.yml --ref main/);
});

test('weekday from 15:00 preserves the daily snapshot pending slot', () => {
    for (const hour of [15, 18, 23]) {
        const result = run({ weekday: 2, hour });
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stdout, /DISPATCH workflow run backfill-periods.yml/);
        assert.match(result.stdout, /15:00 後暫停週月回補接續/);
    }
});

test('publication cadence remains active during the pause', () => {
    const result = run({ weekday: 2, hour: 18, runs: 5 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DISPATCH workflow run daily-snapshot.yml --ref main -f trading-days=300 -f publish-only=true/);
    assert.doesNotMatch(result.stdout, /DISPATCH workflow run backfill-periods.yml/);
});

test('weekend continues the backfill without a daily snapshot pause', () => {
    const result = run({ weekday: 6, hour: 18 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DISPATCH workflow run backfill-periods.yml --ref main/);
});
