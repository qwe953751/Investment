const TAIPEI = 'Asia/Taipei';

function taipeiParts(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError('at must be a valid ISO date-time');
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: TAIPEI,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return {
        date: `${values.year}-${values.month}-${values.day}`,
        minuteOfDay: Number(values.hour) * 60 + Number(values.minute)
    };
}

/** Pure daily gate used by the intraday relay and its behavior tests. */
export function decideEtfDividendDispatch({
    at,
    businessDate,
    authorized = false,
    runs = [],
    excludeRunId = null,
    retryDelayMinutes = 15,
    maxRuns = 3
}) {
    const now = at instanceof Date ? at : new Date(at);
    const local = taipeiParts(now);
    if (businessDate !== local.date) return { dispatch: false, reason: 'superseded', businessDate: local.date };
    if (local.minuteOfDay < 7 * 60 + 30) return { dispatch: false, reason: 'before-window', businessDate: local.date };
    if (local.minuteOfDay >= 22 * 60) return { dispatch: false, reason: 'after-window', businessDate: local.date };

    const todayRuns = runs.filter(run => {
        if (excludeRunId !== null && String(run.id) === String(excludeRunId)) return false;
        const createdAt = run.created_at ?? run.createdAt;
        return createdAt && taipeiParts(createdAt).date === local.date;
    });
    if (todayRuns.some(run => run.status === 'queued' || run.status === 'in_progress')) {
        return { dispatch: false, reason: 'already-running', businessDate: local.date };
    }
    if (todayRuns.some(run => run.conclusion === 'success')) {
        return { dispatch: false, reason: 'already-completed', businessDate: local.date };
    }
    if (todayRuns.length >= maxRuns) {
        return { dispatch: false, reason: 'retry-limit', businessDate: local.date };
    }

    const latest = todayRuns
        .slice()
        .sort((left, right) => Date.parse(right.updated_at ?? right.updatedAt ?? right.created_at)
            - Date.parse(left.updated_at ?? left.updatedAt ?? left.created_at))[0];
    const latestAt = latest && Date.parse(latest.updated_at ?? latest.updatedAt ?? latest.created_at);
    if (Number.isFinite(latestAt) && now.getTime() - latestAt < retryDelayMinutes * 60_000) {
        return { dispatch: false, reason: 'retry-cooldown', businessDate: local.date };
    }

    return {
        dispatch: true,
        reason: authorized ? 'scheduled' : 'license-gate-closed',
        businessDate: local.date,
        authorized: Boolean(authorized),
        attempt: todayRuns.length + 1
    };
}

function argument(name, fallback = undefined) {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1];
}

if (process.argv[1]?.endsWith('etf-dividends-gate.mjs')) {
    const runs = JSON.parse(argument('--runs', '[]'));
    const result = decideEtfDividendDispatch({
        at: argument('--at', new Date().toISOString()),
        businessDate: argument('--business-date', ''),
        authorized: ['true', '1'].includes(String(argument('--authorized', 'false')).toLowerCase()),
        runs,
        excludeRunId: argument('--exclude-run-id')
    });
    process.stdout.write(JSON.stringify(result));
}
