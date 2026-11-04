// 正式資產資料接頭：計算只呼叫由 C# 產生的 AssetPerformance；保留原有 renderer 與編輯功能。
function assetPerformanceViews(view) {
    return view.annualScope === 'owner' ? view.accountViews : [view];
}
function assetPerformanceFlow(flow,view) {
    return {date:flow.flowDate,amount:flow.amount===null?null:flow.direction==='withdrawal'?-flow.amount:flow.amount,
        currency:flow.currency ?? (view.market==='美股'?'USD':'TWD'),valued:true,
        amountTwd:flow.amountTwd==null?null:flow.direction==='withdrawal'?-flow.amountTwd:flow.amountTwd};
}
function assetPerformanceCompute(views,windows,adjusted=assetCashFlowAdjusted) {
    return AssetPerformance.calculate({windows,adjusted,available:assetCashFlowAvailable,
        flows:views.flatMap(view=>view.cashFlows.map(flow=>assetPerformanceFlow(flow,view)))});
}
function assetPerformanceWindow(first, last) {
    return { start:first.date, end:last.date, initial:first.value, final:last.value };
}
function assetPerformanceMeta(result) {
    return { delta:result?.gain ?? null, percent:result?.percent ?? null,
        tone:result?.gain > 0 ? 'up' : result?.gain < 0 ? 'down' : 'neutral' };
}
function assetPerformanceScope(options) {
    const [scope,id] = options.periodKey.split(':');
    return scope === 'account' ? [assetAccountView(assetFindAccount(id))]
        : assetAccountsOf(id).map(assetAccountView);
}
function assetPerformanceAnnualWindow(views,row) {
    const year=Number(row.date.slice(0,4));
    const scope=views.length === 1 ? views[0] : assetAnnualPreviewOwnerView({id:views[0]?.ownerId ?? ''},views);
    const complete=views.length > 0 && views.every(view=>assetAnnualSnapshotRows.some(snapshot=>
        snapshot.accountId===view.id && !snapshot.ownerId && Number(snapshot.snapshotYear)===year-1));
    const previous=complete ? assetPerformanceFormalAnnualRows(scope).find(snapshot=>snapshot.year===year-1) : null;
    return {start:`${year-1}-12-31`,end:row.date,initial:previous?.totalAssets ?? null,final:row.value};
}

const assetPerformanceFormalTrend = makeAssetValueTrendCard;
makeAssetValueTrendCard = function (rows, options) {
    const period = assetTrendPeriodByKey.get(options.periodKey) ?? ASSET_DEFAULT_TREND_PERIOD;
    const profit=assetTrendMode === 'profit';
    const year=TAIPEI_DATE.format(new Date()).slice(0,4);
    const visible = assetTrendRowsForPeriod(profit ? rows.filter(row=>row.date.slice(0,4)===year) : rows, period);
    if (!options.available || !visible.length) return assetPerformanceTrendControls(assetPerformanceFormalTrend(profit ? [] : rows,
        profit ? {...options,available:false,unavailableHint:`${year} 年尚無可用的資產日快照。`} : options));
    const views=assetPerformanceScope(options);
    const windows=visible.flatMap((row,i) => [
        profit ? assetPerformanceAnnualWindow(views,row) : assetPerformanceWindow(visible[0],row),
        assetPerformanceWindow(i ? visible[i-1] : row,row),assetPerformanceWindow(row,visible.at(-1))]);
    const results = assetPerformanceCompute(views,windows);
    const invalid = results?.find(result => result.gain === null);
    let card;
    if (!results || invalid) {
        card = assetPerformanceFormalTrend([], {...options, available:false,
            unavailableHint:profit && windows.some(window=>window.initial===null)
                ? `缺少 ${Number(year)-1} 年底完整總資產，無法計算當年損益。` : invalid?.reason ?? '計算現有資料中…'});
        const footer=assetPerformanceFormalTrend(rows,options).querySelector('.asset-value-trend-footer');
        if(footer)card.append(footer);
    } else {
        card = assetPerformanceFormalTrend(visible.map((row,i) => ({ ...row, actualValue:row.value,
            value:assetTrendMode === 'profit' ? results[i*3].gain : results[i*3].assetValue,
            assetPerformanceDisplayedValue:profit ? results[i*3].gain : results[i*3].assetValue,
            assetPerformanceAnnualBase:profit ? windows[i*3].initial : null,
            assetPerformanceAnnualFlow:profit ? results[i*3].netFlow : null,
            assetPerformancePrevious:i ? assetPerformanceMeta(results?.[i*3+1]) : assetPerformanceMeta(null),
            assetPerformanceCurrent:assetPerformanceMeta(results?.[i*3+2]) })),options);
    }
    const total = card.querySelector('.asset-value-trend-selection-item:nth-child(2) span');
    if (total) total.textContent = profit ? '當年損益' : assetCashFlowAdjusted ? '調整後資產' : '總資產';
    const footer = card.querySelector('.asset-value-trend-footer');
    if (footer) footer.title = assetTrendMode === 'assets'
        ? '出入金開：曲線為期初資產＋累積投資損益；關：實際資產總值。實際餘額另見上方資產總值卡與日期提示。'
        : '當年損益＝當日資產－去年年底總資產；出入金開啟時，再扣除當年1/1至該日的淨入金。期間按鈕只改顯示範圍，不重設年度基準。';
    return assetPerformanceTrendControls(card);
};
function assetPerformanceTrendControls(card) { return card; }
const assetPerformanceFormalTooltip = assetTrendTooltipText;
assetTrendTooltipText = row => row.actualValue === undefined ? assetPerformanceFormalTooltip(row)
    : `${row.date.replaceAll('-','/')} · 實際總資產 ${assetCurrency(row.actualValue)}${assetTrendMode === 'profit' ? ` · 去年底總資產 ${assetCurrency(row.assetPerformanceAnnualBase)} · 當年損益 ${assetSignedCurrency(row.value)} · 今年截至該日淨入金 ${assetSignedCurrency(row.assetPerformanceAnnualFlow)}` : assetCashFlowAdjusted ? ` · 調整後資產 ${assetCurrency(row.value)}` : ''}`;

const assetPerformanceFormalAnnualRows = assetAnnualPreviewRowsFor;
assetAnnualPreviewRowsFor = function (view) {
    const views = assetPerformanceViews(view);
    const rows = assetPerformanceFormalAnnualRows(view).map(row => {
        const complete = row.auto ? views.every(v => !v.incomplete && v.twdTotalValue !== null)
            : views.every(v => assetAnnualSnapshotRows.some(s => s.accountId === v.id && !s.ownerId && Number(s.snapshotYear) === row.year));
        return {...row,totalAssets:complete ? row.totalAssets : null};
    });
    const results = assetPerformanceCompute(views, rows.map(row => ({start:`${row.year-1}-12-31`,
        end:row.auto ? TAIPEI_DATE.format(new Date()) : `${row.year}-12-31`,
        initial:rows.find(previous => previous.year === row.year-1)?.totalAssets ?? null, final:row.totalAssets})));
    return rows.map((row,i) => ({...row,cost:assetPerformanceFundingFor(view,row.year)?.twdNet ?? null,assetPerformanceResult:results?.[i]}));
};
const assetPerformanceFormalAnnualMetric = makeAssetAnnualPreviewMetric;
makeAssetAnnualPreviewMetric = function (rows) {
    const card = assetPerformanceFormalAnnualMetric(rows);
    card.querySelector('.asset-preview-metric-label').textContent = assetCashFlowAdjusted ? '今年報酬（估算）' : '今年資產增減率';
    card.title = rows[0]?.assetPerformanceResult?.reason ?? '點擊展開年度與每月資料；Modified Dietz 估算，非年化。';
    return card;
};
const assetPerformanceFormalAnnualSection = makeAssetAnnualPreviewSection;
makeAssetAnnualPreviewSection = function (view,rows) {
    const section = assetPerformanceFormalAnnualSection(view,rows);
    const heading=section.querySelector('h2'); if(heading) heading.textContent='每年總資產與損益';
    section.querySelectorAll('.asset-annual-preview-value').forEach(value => {
        const label=value.querySelector('span'); if(label?.textContent==='試算淨值') label.textContent=assetCashFlowAdjusted?'年度投資損益':'年度資產增減';
    });
    section.querySelectorAll('.asset-annual-preview-row').forEach((element,i)=>{
        if(rows[i]?.assetPerformanceResult?.reason) element.title=rows[i].assetPerformanceResult.reason;
    });
    return section;
};

const assetPerformanceFormalMonths = assetAnnualPreviewMonthRowsFor;
assetAnnualPreviewMonthRowsFor = function (view,year) {
    const data=assetPerformanceFormalMonths(view,year), previousDecember=assetPerformanceFormalMonths(view,Number(year)-1).months.at(-1);
    const today=TAIPEI_DATE.format(new Date());
    const results=assetPerformanceCompute(assetPerformanceViews(view),data.months.map((month,i)=>{
        const previous=i ? data.months[i-1] : previousDecember;
        return {start:previous?.date || `${Number(year)-1}-12-31`,end:month.date || today,
            initial:previous?.value ?? null,final:month.value};
    }));
    return {...data,months:data.months.map((month,i)=>({...month,mom:results?.[i]?.percent ?? null,assetPerformanceResult:results?.[i]}))};
};
const assetPerformanceFormalMonthChart=makeAssetAnnualPreviewMonthChart;
makeAssetAnnualPreviewMonthChart=function(view,row){
    const chart=assetPerformanceFormalMonthChart(view,row);
    chart.querySelector('.asset-annual-preview-month-heading strong').textContent=assetCashFlowAdjusted?'每月報酬（估算，%）':'每月 MOM（%）';
    return chart;
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
