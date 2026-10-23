namespace Invest.Web.Infrastructure.MarketData.ForeignExchange;

/// <summary>
/// sync-fx 的本體：向期交所取最新 USD/TWD 參考匯率，交給資料庫保存。
///
/// 來源不可用時不寫任何值，資料庫既有的最新一筆照常給資產頁用（帳戶頁會標出匯率日期）。
/// 2026-10-19～10-22 期交所四度對 GitHub runner 回中文開頭的非 JSON，以前例外一路沒人接，
/// 程式以未處理例外（exit 134）中止、整輪標紅。
///
/// 回傳值決定 workflow 的「美元兌台幣參考匯率」警報：
///   0 — 存好了；或這一輪取不到，但期交所目前這份檔案稍早已有別輪存過，手上就是最新的。
///   1 — 取不到，而且目前這份檔案還沒有任何一輪存到：資產頁仍在用上一份的匯率。
/// 每晚有好幾輪完整流程，其中一輪存到就夠；每失敗一次就發警告的話，那四天裡鈴鐺會閃四次，
/// 照這條規則只會在 10/22 18:07～21:45「真的還沒更新」時亮一次。
/// </summary>
public static class UsdTwdExchangeRateSync
{
    /// <summary>
    /// 期交所每天早上約 06:36（台北）更新一次檔案（2026-10-19 實測 Last-Modified），
    /// 所以「目前這份檔案」從最近一個台北 06:00 算起。完整流程最早 15:00 才會跑，不會卡在邊界上。
    /// </summary>
    internal static readonly TimeOnly SourceRefreshTime = new(6, 0);

    private static readonly TimeZoneInfo Taipei = TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei");

    public static async Task<int> RunAsync(
        TaifexExchangeRateClient client,
        Func<UsdTwdExchangeRate, CancellationToken, Task> saveAsync,
        Func<CancellationToken, Task<DateTimeOffset?>> loadLastSavedAtAsync,
        DateTimeOffset now,
        TextWriter output,
        TextWriter error,
        CancellationToken cancellationToken = default)
    {
        UsdTwdExchangeRate rate;

        try
        {
            rate = await client.GetLatestUsdTwdAsync(cancellationToken);
        }
        catch (TaifexExchangeRateUnavailableException exception)
        {
            await error.WriteLineAsync($"期交所匯率來源不可用：{exception.Message}");
            await error.WriteLineAsync("這一輪不寫入任何匯率，資料庫保留既有的最新一筆。");

            var periodStart = CurrentPeriodStart(now);
            var lastSavedAt = await loadLastSavedAtAsync(cancellationToken);

            if (lastSavedAt >= periodStart)
            {
                await output.WriteLineAsync(
                    $"{Format(periodStart)} 之後已在 {Format(lastSavedAt.Value)} 成功存過，"
                    + "資產頁用的就是期交所目前這份檔案的匯率，不發警告。");
                return 0;
            }

            await error.WriteLineAsync(
                $"{Format(periodStart)} 之後還沒有任何一輪存到匯率"
                + $"（上次成功：{(lastSavedAt is { } saved ? Format(saved) : "從未")}），"
                + "資產頁仍在用上一份的匯率；下一次完整流程會再試。");
            return 1;
        }

        await saveAsync(rate, cancellationToken);
        await output.WriteLineAsync($"USD/TWD {rate.RateDate:yyyy-MM-dd} = {rate.Rate:0.######}（{rate.Source}）");
        return 0;
    }

    /// <summary>最近一個台北 06:00（含此刻）。</summary>
    internal static DateTimeOffset CurrentPeriodStart(DateTimeOffset now)
    {
        var local = TimeZoneInfo.ConvertTime(now, Taipei).DateTime;
        var day = DateOnly.FromDateTime(local);

        if (TimeOnly.FromDateTime(local) < SourceRefreshTime)
        {
            day = day.AddDays(-1);
        }

        var start = day.ToDateTime(SourceRefreshTime);
        return new DateTimeOffset(start, Taipei.GetUtcOffset(start));
    }

    private static string Format(DateTimeOffset value)
        => $"{TimeZoneInfo.ConvertTime(value, Taipei):MM-dd HH:mm}";
}
