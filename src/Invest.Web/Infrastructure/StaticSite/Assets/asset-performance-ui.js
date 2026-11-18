// 正式資產資料接頭。淨值與金流對齊後交由 C# 產生的 AssetPerformance 計算。
function assetPerformanceViews(view) {
    return view.annualScope === 'owner' ? view.accountViews : [view];
}

function assetPerformanceFlow(flow, view) {
    const sign = flow.direction === 'withdrawal' ? -1 : 1;
    return {
        date: flow.flowDate,
        amount: flow.amount == null ? null : sign * flow.amount,
        currency: flow.currency || (view.market === '美股' ? 'USD' : 'TWD'),
        valued: true,
        amountTwd: flow.amountTwd == null ? null : sign * flow.amountTwd
    };
}

function assetPerformanceCompute(views, windows, adjusted = true) {
    return AssetPerformance.calculate({
        windows,
        adjusted,
        available: assetCashFlowAvailable,
        flows: views.flatMap(view => view.cashFlows.map(flow => assetPerformanceFlow(flow, view)))
    });
}

function assetPerformanceWindow(first, last) {
    return { start: first.date, end: last.date, initial: first.value, final: last.value };
}

function assetPerformanceMeta(result) {
    return { delta: result?.gain ?? null, percent: result?.percent ?? null,
        tone: result?.gain > 0 ? 'up' : result?.gain < 0 ? 'down' : 'neutral' };
}

function assetPerformanceScope(options) {
    const [scope, id] = options.periodKey.split(':');
    return scope === 'account' ? [assetFindAccount(id)] : assetAccountsOf(id);
}

function assetPerformanceValuations(views) {
    const accountIds = new Set(views.map(view => view.id));
    const byDate = new Map();
    for (const row of assetPerformanceValuationRows ?? []) {
        if (!accountIds.has(row.account_id)) continue;
        const value = assetNumber(row.net_value_twd);
        if (value === null) continue;
        const values = byDate.get(row.valuation_date) ?? new Map();
        values.set(row.account_id, value);
        byDate.set(row.valuation_date, values);
    }
    return [...byDate]
        .filter(([, values]) => values.size === accountIds.size)
        .map(([date, values]) => ({ date, value: AssetPerformance.sum([...values.values()]) }))
        .sort((left, right) => left.date.localeCompare(right.date));
}

function assetPerformanceAnnualWindow(valuations, row) {
    const start = (Number(row.date.slice(0, 4)) - 1) + '-12-31';
    return assetPerformanceWindow(valuations.find(point => point.date === start) ?? { date: start, value: null }, row);
}

function assetPerformanceLegacyYearEnd(views, year) {
    const complete = views.length && views.every(view => assetAnnualSnapshotRows.some(row =>
        row.accountId === view.id && !row.ownerId && Number(row.snapshotYear) === year));
    if (!complete) return null;
    const scope = views.length === 1 ? views[0] : assetAnnualPreviewOwnerView({ id: views[0].ownerId }, views);
    return assetPerformanceFormalAnnualRows(scope).find(row => row.year === year)?.totalAssets ?? null;
}

const assetPerformanceFormalTrend = makeAssetValueTrendCard;
makeAssetValueTrendCard = function (rows, options) {
    const period = assetTrendPeriodByKey.get(options.periodKey) ?? ASSET_DEFAULT_TREND_PERIOD;
    const year = TAIPEI_DATE.format(new Date()).slice(0, 4);
    const profit = assetTrendMode === 'profit';
    const inMode = points => profit ? points.filter(row => row.date.startsWith(year)) : points;
    const accounts = assetPerformanceScope(options);
    const valuations = assetCashFlowAdjusted ? assetPerformanceValuations(accounts) : [];
    const verified = assetTrendRowsForPeriod(inMode(valuations), period);
    const yearStart = (Number(year) - 1) + '-12-31';
    const verifiedStart = valuations.find(row => row.date === yearStart);
    const useVerified = profit ? verified.length > 0 && verifiedStart !== undefined : verified.length > 1;
    const visible = useVerified ? verified : assetTrendRowsForPeriod(inMode(rows), period);
    const trendOptions = useVerified ? { ...options, available: true } : options;
    if (!trendOptions.available || visible.length === 0) {
        return assetPerformanceFormalTrend(profit ? [] : rows, profit
            ? { ...trendOptions, available: false, unavailableHint: year + ' 年尚無可用的資產日快照。' }
            : trendOptions);
    }
    const views = accounts.map(assetAccountView);
    const annualStart = profit ? (useVerified ? verifiedStart : null) ?? {
        date: yearStart, value: assetPerformanceLegacyYearEnd(views, Number(year) - 1)
    } : null;
    const windows = visible.flatMap((row, index) => [
        assetPerformanceWindow(annualStart ?? visible[0], row),
        assetPerformanceWindow(visible[index - 1] ?? row, row),
        assetPerformanceWindow(row, visible.at(-1))
    ]);
    const results = assetPerformanceCompute(views, windows, assetCashFlowAdjusted);
    const invalid = results.find(result => result.gain === null);
    let card;
    if (invalid) {
        card = assetPerformanceFormalTrend([], { ...trendOptions, available: false,
            unavailableHint: profit && annualStart.value === null
                ? '缺少 ' + (Number(year) - 1) + ' 年底完整總資產，無法計算當年損益。' : invalid.reason });
        const footer = assetPerformanceFormalTrend(rows, trendOptions).querySelector('.asset-value-trend-footer');
        if (footer) card.append(footer);
    } else {
        card = assetPerformanceFormalTrend(visible.map((row, index) => ({
            ...row, actualValue: row.value,
            value: profit ? results[index * 3].gain : results[index * 3].assetValue,
            assetPerformanceAnnualBase: profit ? windows[index * 3].initial : null,
            assetPerformanceAnnualFlow: profit ? results[index * 3].netFlow : null,
            assetPerformancePrevious: assetPerformanceMeta(index ? results[index * 3 + 1] : null),
            assetPerformanceCurrent: assetPerformanceMeta(results[index * 3 + 2])
        })), trendOptions);
    }
    const total = card.querySelector('.asset-value-trend-selection-item:nth-child(2) span');
    if (total) total.textContent = profit ? '當年損益' : assetCashFlowAdjusted ? '調整後資產' : '總資產';
    const footer = card.querySelector('.asset-value-trend-footer');
    if (footer) {
        footer.title = useVerified ? '按已確認日末淨值與同期出入金調整。'
            : assetCashFlowAdjusted ? '按舊資產快照與出入金試算，舊點未確認完整日末淨值。'
            : profit ? '當年損益＝當日資產－去年年底總資產。' : '總資產取已保存快照與今日即時估值。';
    }
    return card;
};

const assetPerformanceFormalTooltip = assetTrendTooltipText;
assetTrendTooltipText = row => {
    if (row.actualValue === undefined) return assetPerformanceFormalTooltip(row);
    const base = row.date.replaceAll('-', '/') + ' · 實際總資產 ' + assetCurrency(row.actualValue);
    return assetTrendMode === 'profit'
        ? base + ' · 去年底總資產 ' + assetCurrency(row.assetPerformanceAnnualBase)
            + ' · 當年損益 ' + assetSignedCurrency(row.value)
            + ' · 今年截至該日淨入金 ' + assetSignedCurrency(row.assetPerformanceAnnualFlow)
        : base + (assetCashFlowAdjusted ? ' · 調整後資產 ' + assetCurrency(row.value) : '');
};

const assetPerformanceFormalAnnualRows = assetAnnualPreviewRowsFor;
assetAnnualPreviewRowsFor = function (view) {
    const views = assetPerformanceViews(view);
    const valuations = assetPerformanceValuations(views);
    const last = valuations.at(-1);
    const rows = assetPerformanceFormalAnnualRows(view);
    for (const point of valuations) {
        const year = Number(point.date.slice(0, 4));
        if (point.date.slice(5) === '12-31' && !rows.some(row => row.year === year)) {
            rows.push({ id: '', year, period: '全年', status: '日末淨值', totalAssets: point.value, auto: false });
        }
    }
    rows.sort((left, right) => right.year - left.year);
    const windows = rows.map(row => {
        const end = row.auto && last?.date.startsWith(String(row.year)) ? last.date : row.year + '-12-31';
        const point = valuations.find(valuation => valuation.date === end) ?? { date: end, value: null };
        return assetPerformanceAnnualWindow(valuations, point);
    });
    const results = assetPerformanceCompute(views, windows);
    return rows.map((row, index) => ({
        ...row,
        cost: assetPerformanceFundingFor(view, row.year)?.twdNet ?? null,
        performanceDate: windows[index].final === null ? null : windows[index].end,
        assetPerformanceResult: results[index]
    }));
};

const assetPerformanceFormalAnnualMetric = makeAssetAnnualPreviewMetric;
makeAssetAnnualPreviewMetric = function (rows) {
    const card = assetPerformanceFormalAnnualMetric(rows);
    card.querySelector('.asset-preview-metric-label').textContent = '今年報酬（估算）';
    card.title = rows[0]?.assetPerformanceResult?.reason ?? '已確認至 ' + rows[0]?.performanceDate + ' · Modified Dietz 估算';
    return card;
};

const assetPerformanceFormalAnnualSection = makeAssetAnnualPreviewSection;
makeAssetAnnualPreviewSection = function (view, rows) {
    const section = assetPerformanceFormalAnnualSection(view, rows);
    section.querySelector('h2').textContent = '每年總資產與損益';
    section.querySelectorAll('.asset-annual-preview-value > span').forEach(label => {
        if (label.textContent === '試算淨值') label.textContent = '年度投資損益';
    });
    section.querySelectorAll('.asset-annual-preview-row').forEach((element, index) => {
        const row = rows[index];
        element.title = row.assetPerformanceResult.reason ?? '績效截至 ' + row.performanceDate;
    });
    return section;
};

const assetPerformanceFormalMonths = assetAnnualPreviewMonthRowsFor;
assetAnnualPreviewMonthRowsFor = function (view, year) {
    const data = assetPerformanceFormalMonths(view, year);
    const views = assetPerformanceViews(view);
    const valuations = assetPerformanceValuations(views);
    const checkpoints = new Map(valuations.map(row => [row.date.slice(0, 7), row]));
    const windows = data.months.map(month => {
        const previousKey = month.month === 1 ? (Number(year) - 1) + '-12'
            : year + '-' + String(month.month - 1).padStart(2, '0');
        const key = year + '-' + String(month.month).padStart(2, '0');
        return assetPerformanceWindow(
            checkpoints.get(previousKey) ?? { date: previousKey + '-01', value: null },
            checkpoints.get(key) ?? { date: key + '-01', value: null });
    });
    const results = assetPerformanceCompute(views, windows);
    return {
        available: assetPerformanceValuationRows !== null,
        months: data.months.map((month, index) => ({
            ...month,
            date: windows[index].final === null ? '' : windows[index].end,
            value: windows[index].final,
            mom: results[index].percent,
            assetPerformanceResult: results[index]
        }))
    };
};

const assetPerformanceFormalMonthChart = makeAssetAnnualPreviewMonthChart;
makeAssetAnnualPreviewMonthChart = function (view, row) {
    const chart = assetPerformanceFormalMonthChart(view, row);
    chart.querySelector('.asset-annual-preview-month-heading strong').textContent = '每月報酬（估算，%）';
    const empty = chart.querySelector('.asset-annual-preview-month-empty');
    if (empty) empty.textContent = '日末淨值暫時無法讀取。';
    return chart;
};

async function saveAssetPerformanceValuation(accountId, date, value, retryAuthentication = true) {
    if (authAccessToken === null && !await refreshAuthAccessToken()) {
        throw new Error('請重新登入最高權限帳號');
    }
    const url = supabase.url + '/rest/v1/asset_performance_valuations';
    const deleting = value === null;
    const query = deleting ? '?account_id=eq.' + encodeURIComponent(accountId) + '&valuation_date=eq.' + encodeURIComponent(date)
        : '?on_conflict=account_id,valuation_date';
    const response = await fetch(url + query, {
        method: deleting ? 'DELETE' : 'POST',
        headers: {
            apikey: supabase.anonKey,
            Authorization: 'Bearer ' + authAccessToken,
            'Content-Type': 'application/json',
            Prefer: deleting ? 'return=representation' : 'resolution=merge-duplicates,return=representation'
        },
        body: deleting ? undefined : JSON.stringify({
            account_id: accountId, valuation_date: date, net_value_twd: value, updated_at: new Date().toISOString()
        })
    });
    if (response.status === 401 && retryAuthentication && await refreshAuthAccessToken()) {
        return saveAssetPerformanceValuation(accountId, date, value, false);
    }
    if (!response.ok) throw new Error('日末淨值寫入失敗（HTTP ' + response.status + '）');
    if ((await response.json()).length !== 1) throw new Error('日末淨值未更新，請重新整理');
}

const assetPerformanceFormalCashFlowSection = makeAssetCashFlowSection;
makeAssetCashFlowSection = function (view) {
    const section = assetPerformanceFormalCashFlowSection(view);
    if (loginTier !== 'admin') return section;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '績效用日末淨值';
    const note = document.createElement('p');
    note.className = 'asset-local-only-note';
    const valuations = assetPerformanceValuations([view]);
    const latest = valuations.at(-1);
    note.textContent = assetPerformanceValuationRows === null ? '日末淨值暫時無法讀取。'
        : '依券商資料輸入已結束台北日期的台幣帳戶淨值，包含持倉、現金及淨交割款。出入金日期請填實際入帳日。'
            + (latest ? ' 最近一筆 ' + latest.date + ' · ' + assetCurrency(latest.value) : '');
    details.append(summary, note);
    section.append(details);
    if (assetPerformanceValuationRows === null) return section;

    const form = document.createElement('form');
    form.className = 'asset-editor-form';
    const yesterday = TAIPEI_DATE.format(new Date(Date.now() - 86_400_000));
    const date = assetField(form, 'date', '估值日期', yesterday, { required: true });
    date.max = yesterday;
    const value = assetAmountField(form, '帳戶淨值（TWD）', '', { required: true });
    const fill = () => {
        const point = valuations.find(row => row.date === date.value);
        value.value = point ? String(point.value) : '';
        remove.disabled = assetsBusy || !point;
    };
    const actions = assetActions(form, '儲存日末淨值', () => { date.value = yesterday; fill(); });
    const remove = assetButton('刪除此日淨值', 'asset-secondary-button', () => {
        if (!window.confirm('確定刪除 ' + date.value + ' 的日末淨值？')) return;
        void runAssetAction('刪除日末淨值中…',
            () => saveAssetPerformanceValuation(view.id, date.value, null), '已刪除日末淨值。', false);
    });
    actions.append(remove);
    date.addEventListener('change', fill);
    fill();
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const amount = assetNumber(value.value);
        if (amount === null || !date.value || date.value > yesterday) return;
        await runAssetAction('儲存日末淨值中…',
            () => saveAssetPerformanceValuation(view.id, date.value, amount), '已儲存日末淨值。', false);
    });
    details.append(form);
    return section;
};

const assetPerformanceFormalRender=renderAssetsDashboard;
renderAssetsDashboard=function(){
    assetPerformanceFormalRender();
    const page=el('assets-page'); if(!page || !assetsLoaded || assetsLoadError)return;
    const content=page.querySelector('.asset-account-content,.asset-dashboard-content');if(!content)return;

    for(const label of page.querySelectorAll('.asset-annual-preview-value > span')){
        for(const node of label.childNodes)if(node.nodeType===3)node.textContent=node.textContent.replaceAll('入金成本','年度淨投入');
    }
    for(const label of page.querySelectorAll('.asset-preview-metric-label'))if(label.textContent==='入金成本'){
        const card=label.closest('.asset-preview-metric');
        card.querySelector('.asset-preview-metric-value')?.classList.remove('positive','negative','unchanged');
        if(card.textContent.includes('—'))card.title='至少一筆金流缺少歷史匯率；原幣金額保留，台幣總額不使用目前匯率回推。';
    }
    page.querySelectorAll('.asset-dashboard-config-card tbody tr').forEach(row=>row.children[5]?.classList.remove('positive','negative','unchanged'));
};

function assetPerformanceFundingFor(view,year=null) {
    return AssetPerformance.funding(assetPerformanceViews(view).flatMap(v=>v.cashFlows.map(flow=>assetPerformanceFlow(flow,v))),
        TAIPEI_DATE.format(new Date()),year,assetCashFlowAvailable);
}
const assetPerformanceFormalAccountView=assetAccountView;
assetAccountView=function(account){
    const view=assetPerformanceFormalAccountView(account),funding=assetPerformanceFundingFor(view);
    return {...view,fundingCost:funding?.nativeNet ?? null,twdFundingCost:funding?.twdNet ?? null};
};
assetAnnualPreviewFundingCostNativeFor=(view,year)=>assetPerformanceFundingFor(view,year)?.nativeNet ?? null;
assetAnnualPreviewFundingCostFor=(view,year)=>assetPerformanceFundingFor(view,year)?.twdNet ?? null;
