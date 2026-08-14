using System.Globalization;
using System.Reflection;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Features.TradingValueRanking.Services;

namespace Invest.Web.Infrastructure.StaticSite;

/// <summary>
/// 把排行榜輸出成一份純靜態網站。
///
/// 網站要在「本機電腦關機時也看得到」，但排行頁是 Blazor Interactive Server，
/// 每次互動都得回伺服器算，本機不開就沒得看。與其為了這件事把整個專案改成
/// WebAssembly（行情要整包塞進瀏覽器），不如在本機把所有篩選組合先算好，
/// 輸出成靜態 JSON 丟到免費的靜態空間。
///
/// 關鍵是**計算仍然只有一份**：這裡直接呼叫 <see cref="TradingValueRankingQueryService"/>，
/// 連顯示文字都用 <see cref="RankingFormatter"/> 先格式化好寫進 JSON，
/// 前端只負責挑檔案、畫表格與排序，不重寫任何一條公式。
/// </summary>
public sealed class StaticSiteExporter(TradingValueRankingQueryService ranking)
{
    /// <summary>
    /// 與排行頁上的按鈕一致。組合數是 4 × 2 × 3 × 4 = 96，再乘上可選的基準日，全部先算好。
    /// </summary>
    private static readonly int[] PeriodDayOptions = [1, 5, 10, 20];

    private static readonly (RankingMode Mode, string Key)[] ModeOptions =
    [
        (RankingMode.TradingHeat, "heat"),
        (RankingMode.CapitalAcceleration, "accel")
    ];

    private static readonly (MarketFilter Market, string Key)[] MarketOptions =
    [
        (MarketFilter.All, "all"),
        (MarketFilter.Twse, "twse"),
        (MarketFilter.Tpex, "tpex")
    ];

    /// <summary>
    /// 平均每日成交值的門檻，在檔名裡用「萬元」表示，避免出現一長串 0。
    /// 畫面上顯示的是乘上期間天數後的總額，見 <see cref="ToThresholdExports"/>。
    /// </summary>
    private static readonly int[] ThresholdOptionsInTenThousand = [0, 5_000, 10_000, 100_000];

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,

        // 不轉義中文。轉義後檔案會膨脹三倍，而且用編輯器打開完全看不懂。
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public async Task<StaticSiteExportReport> ExportAsync(
        string outputDirectory,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var dataDirectory = Path.Combine(outputDirectory, "data");
        Directory.CreateDirectory(dataDirectory);

        var dataSet = await ranking.GetDataSetAsync(cancellationToken);
        var tradingDates = dataSet.DailyTrading
            .Select(trading => trading.TradingDate)
            .Distinct()
            .Order()
            .ToArray();

        var dateOptions = RankingDates.ToOptions(tradingDates);
        var selectableDates = dateOptions.Where(option => option.IsAvailable).ToArray();
        var fileCount = 0;

        foreach (var date in selectableDates)
        {
            foreach (var periodDays in PeriodDayOptions)
            {
                foreach (var (mode, modeKey) in ModeOptions)
                {
                    foreach (var (market, marketKey) in MarketOptions)
                    {
                        foreach (var thresholdInTenThousand in ThresholdOptionsInTenThousand)
                        {
                            cancellationToken.ThrowIfCancellationRequested();

                            var query = new RankingQuery
                            {
                                PeriodDays = periodDays,
                                EndDate = date.Date,
                                Mode = mode,
                                Market = market,
                                MinimumAverageDailyTradingValue = thresholdInTenThousand * 10_000m
                            };

                            var key = $"{modeKey}-{periodDays}-{marketKey}-{thresholdInTenThousand}-{date.Key}";
                            var result = await ranking.GetRankingAsync(query, cancellationToken);

                            await WriteJsonAsync(
                                Path.Combine(dataDirectory, key + ".json"),
                                ToExport(key, query, result),
                                cancellationToken);

                            fileCount++;
                        }
                    }
                }
            }

            progress?.Report($"{date.Key} 完成（累計 {fileCount} 個檔案）");
        }

        await WriteJsonAsync(
            Path.Combine(outputDirectory, "manifest.json"),
            new ManifestExport(
                // 靜態網站沒有伺服器可以問「這份資料多新」，所以把產生時間寫進檔案裡。
                DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm"),

                // 前端拿這個當快取版本號。同一份快照的檔案可以放心被瀏覽器快取，
                // 重新發佈後版本號一變，網址跟著變，舊檔就自動失效。
                DateTimeOffset.Now.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture),
                tradingDates.Length,
                tradingDates.Length > 0 ? tradingDates[^1].ToString("yyyy/MM/dd") : "—",
                dataSet.Stocks.Count,
                ToThresholdExports(),
                [.. dateOptions.Select(option => new DateExport(option.Key, option.Text, option.IsAvailable))]),
            cancellationToken);

        var assetNames = await WriteEmbeddedAssetsAsync(outputDirectory, cancellationToken);
        progress?.Report($"已寫出頁面檔案：{string.Join("、", assetNames)}");

        return new StaticSiteExportReport(outputDirectory, fileCount, selectableDates.Length, tradingDates.Length);
    }

    /// <summary>
    /// 頁面本身（HTML / CSS / JS）以內嵌資源的方式跟著組件走，
    /// 這樣不論從哪個工作目錄執行 export 都找得到。
    /// </summary>
    private static async Task<IReadOnlyList<string>> WriteEmbeddedAssetsAsync(
        string outputDirectory,
        CancellationToken cancellationToken)
    {
        const string prefix = "Invest.Web.Infrastructure.StaticSite.Assets.";

        var assembly = typeof(StaticSiteExporter).GetTypeInfo().Assembly;
        var written = new List<string>();

        foreach (var resourceName in assembly.GetManifestResourceNames())
        {
            if (!resourceName.StartsWith(prefix, StringComparison.Ordinal))
            {
                continue;
            }

            var fileName = resourceName[prefix.Length..];

            await using var source = assembly.GetManifestResourceStream(resourceName)!;
            await using var target = File.Create(Path.Combine(outputDirectory, fileName));
            await source.CopyToAsync(target, cancellationToken);

            written.Add(fileName);
        }

        return written;
    }

    private static async Task WriteJsonAsync<T>(string path, T value, CancellationToken cancellationToken)
    {
        await using var stream = File.Create(path);
        await JsonSerializer.SerializeAsync(stream, value, JsonOptions, cancellationToken);
    }

    private static RankingExport ToExport(string key, RankingQuery query, TradingValueRankingResult result)
        => new(
            key,
            result.HasSufficientData,
            result.InsufficientDataMessage,
            RankingFormatter.ToPeriodText(result.CurrentPeriodStart, result.CurrentPeriodEnd),
            RankingFormatter.ToPeriodText(result.PreviousPeriodStart, result.PreviousPeriodEnd),
            result.HasSufficientData
                ? RankingFormatter.ToBillionText(result.MarketTotalTradingValue / result.PeriodDays, 0)
                : "—",
            result.RankedStockCount,
            [.. result.Rows.Select(ToExport)]);

    /// <summary>
    /// 每個欄位同時給「顯示文字」與「排序用的數字」：
    /// 文字已經在 C# 這邊格式化完，前端不必知道億元怎麼換算；
    /// 數字則讓前端點欄位標題時可以就地排序，不必為了排序回頭再要一份檔案。
    /// </summary>
    private static RowExport ToExport(StockRankingRow row) => new(
        row.Rank,
        row.RankChange,
        RankingFormatter.ToRankChangeText(row.RankChange),
        RankingFormatter.ToTrendCssClass(row.RankChange),
        row.Ticker,
        row.Name,
        RankingFormatter.ToMarketText(row.Market),
        Math.Round(row.AverageDailyTradingValue),
        RankingFormatter.ToBillionText(row.AverageDailyTradingValue),
        Round(row.TradingValueChangeRate),
        RankingFormatter.ToSignedPercentText(row.TradingValueChangeRate),
        RankingFormatter.ToTrendCssClass(row.TradingValueChangeRate),
        Round(row.MarketShare),
        RankingFormatter.ToPercentText(row.MarketShare),
        Round(row.MarketShareChange),
        RankingFormatter.ToSignedPercentText(row.MarketShareChange, 2),
        RankingFormatter.ToTrendCssClass(row.MarketShareChange),
        Round(row.PriceChangeRate),
        RankingFormatter.ToSignedPercentText(row.PriceChangeRate),
        RankingFormatter.ToTrendCssClass(row.PriceChangeRate),
        row.ClosePrice,
        row.ClosePrice?.ToString("N2") ?? "—");

    /// <summary>
    /// 比率算出來會帶著 28 位小數，整包 JSON 因此膨脹一倍。
    /// 這些數字只拿來排序，不拿來顯示（顯示文字另外給），八位小數綽綽有餘。
    /// </summary>
    private static decimal Round(decimal value) => Math.Round(value, 8);

    private static decimal? Round(decimal? value) => value is { } number ? Round(number) : null;

    /// <summary>
    /// 門檻按鈕的文字。門檻本身是「平均每日」，但顯示的是乘上期間天數後的總額，
    /// 所以同一個門檻在不同期間下文字不一樣，得逐期間先算好。
    /// 這段文字用 <see cref="RankingFormatter"/> 產生，前端不自己換算單位。
    /// </summary>
    private static IReadOnlyList<ThresholdExport> ToThresholdExports()
        => [.. ThresholdOptionsInTenThousand.Select(threshold => new ThresholdExport(
            threshold,
            PeriodDayOptions.ToDictionary(
                periodDays => periodDays.ToString(CultureInfo.InvariantCulture),
                periodDays => RankingFormatter.ToThresholdText(threshold * 10_000m * periodDays))))];

    private sealed record ManifestExport(
        string GeneratedAt,
        string Version,
        int TradingDayCount,
        string LatestTradingDate,
        int StockCount,
        IReadOnlyList<ThresholdExport> Thresholds,
        IReadOnlyList<DateExport> Dates);

    private sealed record ThresholdExport(int Key, IReadOnlyDictionary<string, string> TextByPeriod);

    /// <summary>
    /// 基準日按鈕。清單包含沒有行情的日期（週末、假日），前端把它們畫成停用的按鈕。
    /// </summary>
    private sealed record DateExport(string Key, string Text, bool Available);

    private sealed record RankingExport(
        string Key,
        bool HasSufficientData,
        string? Message,
        string CurrentPeriod,
        string PreviousPeriod,
        string MarketDailyAverage,
        int RankedStockCount,
        IReadOnlyList<RowExport> Rows);

    private sealed record RowExport(
        int Rank,
        int? RankChange,
        string RankChangeText,
        string RankChangeClass,
        string Ticker,
        string Name,
        string MarketText,
        decimal Value,
        string ValueText,
        decimal? Rate,
        string RateText,
        string RateClass,
        decimal Share,
        string ShareText,
        decimal ShareChange,
        string ShareChangeText,
        string ShareChangeClass,
        decimal? PriceChange,
        string PriceChangeText,
        string PriceChangeClass,
        decimal? Close,
        string CloseText);
}

public sealed record StaticSiteExportReport(
    string OutputDirectory,
    int FileCount,
    int SelectableDateCount,
    int TradingDayCount);
