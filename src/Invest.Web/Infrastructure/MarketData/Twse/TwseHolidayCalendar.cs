using System.Text.Json;

namespace Invest.Web.Infrastructure.MarketData.Twse;

/// <summary>
/// 證交所公布的當年度休市日曆。
///
/// 只用來回答一個問題：**今天**抓不到收盤行情，是因為休市，還是因為官方還沒公布？
/// 這兩件事在行情 API 上長得一模一樣（兩個市場都回空），沒有日曆就分不出來。
///
/// 端點：openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule，一次給整年。
/// 只有在確定是休市時才回 true；查不到、抓不到、年份對不上一律回 false，
/// 讓呼叫端維持原本「先不記錄、繼續重試」的保守行為——
/// 把交易日誤記成休市是不會再重試的，代價比多紅一次燈大得多。
/// </summary>
public sealed class TwseHolidayCalendar(HttpClient httpClient, ILogger<TwseHolidayCalendar> logger)
{
    private const string Url = "https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule";

    // 這份清單同時包含休市日與「春節前最後交易日」這類**照常開市**的特殊日子。
    // 名稱帶「交易日」的都是有開市的，照單全收會把一年三天的交易日誤判成休市。
    private const string TradingDayKeyword = "交易日";

    private readonly SemaphoreSlim _gate = new(1, 1);
    private Task<IReadOnlySet<DateOnly>>? _closedDates;

    public async Task<bool> IsClosedAsync(DateOnly date, CancellationToken cancellationToken = default)
    {
        var closed = await GetClosedDatesAsync(cancellationToken);
        return closed.Contains(date);
    }

    private async Task<IReadOnlySet<DateOnly>> GetClosedDatesAsync(CancellationToken cancellationToken)
    {
        // 一天跑一次的批次程序，抓一次就夠了。
        await _gate.WaitAsync(cancellationToken);

        try
        {
            _closedDates ??= LoadAsync(cancellationToken);
            return await _closedDates;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<IReadOnlySet<DateOnly>> LoadAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using var stream = await httpClient.GetStreamAsync(Url, cancellationToken);
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

            var closed = new HashSet<DateOnly>();

            foreach (var entry in document.RootElement.EnumerateArray())
            {
                var name = entry.TryGetProperty("Name", out var nameValue) ? nameValue.GetString() : null;

                if (name is not null && name.Contains(TradingDayKeyword, StringComparison.Ordinal))
                {
                    continue;
                }

                if (entry.TryGetProperty("Date", out var dateValue)
                    && TryParseRocDate(dateValue.GetString(), out var date))
                {
                    closed.Add(date);
                }
            }

            logger.LogInformation("證交所休市日曆共 {Count} 天。", closed.Count);
            return closed;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogWarning(exception, "讀不到證交所休市日曆，這次不做休市判斷。");
            return new HashSet<DateOnly>();
        }
    }

    /// <summary>民國日期，例如 1150101 是 2026-01-01。</summary>
    private static bool TryParseRocDate(string? text, out DateOnly date)
    {
        date = default;

        if (text is not { Length: 7 } || !int.TryParse(text, out _))
        {
            return false;
        }

        var year = int.Parse(text[..3]) + 1911;
        var month = int.Parse(text[3..5]);
        var day = int.Parse(text[5..]);

        if (month is < 1 or > 12 || day < 1 || day > DateTime.DaysInMonth(year, month))
        {
            return false;
        }

        date = new DateOnly(year, month, day);
        return true;
    }
}
