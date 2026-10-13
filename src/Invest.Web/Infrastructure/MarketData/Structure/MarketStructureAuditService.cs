using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Features.MarketStructure.Models;
using Invest.Web.Features.MarketStructure.Services;
using Invest.Web.Infrastructure.Database;
using Invest.Web.Infrastructure.MarketData.Intraday;
using Npgsql;

namespace Invest.Web.Infrastructure.MarketData.Structure;

/// <summary>唯讀診斷：完整raw可精確組裝；DB逐輪是保留欄位／精度的診斷，不冒充舊hash重播。</summary>
public sealed class MarketStructureAuditService(MarketStructureQueryService query)
{
    public async Task<IReadOnlyList<MarketStructureResult>> AuditAsync(string rawFile, bool allDatabase, CancellationToken ct = default)
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var document = JsonSerializer.Deserialize<IntradaySnapshotPublisher.SnapshotDocument>(await File.ReadAllTextAsync(rawFile, ct), options)
            ?? throw new InvalidDataException("raw JSON 不存在。");
        if (document.SchemaVersion != 1 || document.RowCount != document.Rows.Count
            || !DateOnly.TryParseExact(document.TradeDate, "yyyy-MM-dd", out var date))
            throw new InvalidDataException("raw 日期／schema／列數不符。");
        if (!allDatabase)
            return [await query.CalculateIntradayAsync(document.RunId, IntradaySnapshotPublisher.FromDocument(document, date), document.CapturedAt, ct)];

        await using var connection = await SupabaseConnection.OpenAsync(ct);
        var snapshots = new Dictionary<long, (DateTimeOffset Time, List<MarketIndexQuote> Indices, List<IntradayQuote> Quotes)>();
        await using (var command = new NpgsqlCommand("""
            select id,captured_at,twse_index,twse_change_percent,tpex_index,tpex_change_percent
            from intraday_runs where trade_date=@date order by captured_at,id
            """, connection))
        {
            command.Parameters.AddWithValue("date", date);
            await using var reader = await command.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                var indices = new List<MarketIndexQuote>();
                foreach (var (market, value, change) in new[] { (Market.Twse, 2, 3), (Market.Tpex, 4, 5) })
                    if (!reader.IsDBNull(value)) indices.Add(new() { Market = market, Value = reader.GetDecimal(value),
                        ChangePercent = reader.IsDBNull(change) ? null : reader.GetDecimal(change) });
                snapshots[reader.GetInt64(0)] = (reader.GetFieldValue<DateTimeOffset>(1), indices, []);
            }
        }
        var metadata = document.Rows.ToDictionary(x => x.Symbol, StringComparer.Ordinal);
        await using (var command = new NpgsqlCommand("""
            select q.run_id,s.symbol,s.name,q.price,q.turnover,q.change_percent
            from intraday_quotes q join intraday_runs r on r.id=q.run_id join securities s on s.id=q.security_id
            where r.trade_date=@date order by q.run_id,q.security_id
            """, connection))
        {
            command.Parameters.AddWithValue("date", date);
            await using var reader = await command.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                var ticker = reader.GetString(1);
                if (!metadata.TryGetValue(ticker, out var identity)) throw new InvalidDataException("DB標的缺當日raw類型／市場身分。");
                if (identity.Kind != "stock" || identity.Market == "EMERGING") continue;
                snapshots[reader.GetInt64(0)].Quotes.Add(new()
                {
                    Market = identity.Market == "TWSE" ? Market.Twse : Market.Tpex,
                    Ticker = ticker, Name = reader.GetString(2), Kind = StockKind.CommonStock,
                    Price = reader.IsDBNull(3) ? null : reader.GetDecimal(3),
                    EstimatedTradingValue = Convert.ToDecimal(reader.GetValue(4)), TradingVolume = 0m,
                    ChangePercent = reader.IsDBNull(5) ? null : reader.GetDecimal(5),
                    ReferencePrice = identity.ReferencePrice, PriceSource = IntradayPriceSource.LastTrade
                });
            }
        }
        var results = new List<MarketStructureResult>(snapshots.Count);
        foreach (var (runId, run) in snapshots)
            results.Add(await query.CalculateIntradayAsync(runId, new() { TradeDate = date, Quotes = run.Quotes,
                MarketIndices = run.Indices }, run.Time, ct));
        return results;
    }
}
