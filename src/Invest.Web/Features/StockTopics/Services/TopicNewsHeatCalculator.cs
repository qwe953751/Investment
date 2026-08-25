using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 族群新聞熱度，照文件 §12 的公式做，但只吃得到公開資訊觀測站的重大訊息。
///
/// 文件的原式是
///   EventEvidenceScore = 來源可信度 × 直接性 × 新鮮度 × 時間衰減 × 獨立來源確認
/// 目前五項裡有兩項是常數，因為只有一種來源：
///
///   來源可信度   1.00。MOPS 是文件 §13 的 S 層，公司自己發的公告。
///   獨立來源確認 1.00。只有一條來源鏈，談不上互相佐證。等媒體來源接上才有意義。
///
/// 剩下三項才真的在動：
///
///   直接性   借用材料性。材料性問的是「這種公告有沒有可能推動股價」，
///            正好就是這則公告對族群有多直接。0 分的例行公告根本進不了這裡。
///   新鮮度   同一檔在同一個催化類型底下的第二則、第三則要打折。
///            實測很多是「(補充公告)…」與同一天發兩則土地案，那是同一件事的後續，
///            照篇數加總會讓一家公司自己把族群灌熱。
///   時間衰減 依催化類型給半衰期，照文件 §12.4。法說會兩週後就沒人記得，
///            擴產案三個月後還在蓋。用同一個半衰期會兩邊都錯。
///
/// 最後 NewsHeat = 100 × (1 − e^(−Σ分數 / k))，指數飽和是為了讓發二十則公告的族群
/// 不會比發五則的高四倍——新聞多不等於題材強，只是那家公司話多。
///
/// 注意：這個分數目前只當參考欄，沒有計入綜合熱度。公式的參數（半衰期、k、新鮮度折數）
/// 都還沒有人工標準答案校正過，文件自己也寫「以上只是初始參數」。
/// 拿沒校正過的數字去動排序，等於用一個沒人驗證過的公式改寫全站的族群排名。
///
/// 而且第一次跑真實資料就看得出一個沒解決的問題：Σ分數跟成員數的相關係數是 0.77，
/// 253 檔的「傳產」拿到 99.4 分，但它的資金熱度只有 37.7。節點大就一定有人在發公告，
/// 這個分數目前有一半在量「這個節點有多大」而不是「這個題材有多熱」。
/// 例外是金融保險——15 檔卻拿到 97 分，那是真的一直在發（財報、法說會、金控併購）。
/// 要修得引入基準線（這個節點平常一個月發幾則），而基準線要有歷史才算得出來，
/// 目前資料庫只累積了八天。所以先擺著，等資料夠長再回頭校正。
/// </summary>
public static class TopicNewsHeatCalculator
{
    /// <summary>
    /// 指數飽和的尺度。Σ分數 = k 時大約 63 分，= 2k 時 86 分。
    /// 取 3 的理由是實測資料裡一個熱門族群一個月大約累積 2～4 分，
    /// 讓那一段落在分數變化最明顯的區間，而不是擠在 90 分以上分不出高低。
    /// </summary>
    private const double Saturation = 3.0;

    /// <summary>
    /// 同一檔在同一個催化類型底下，第 n 則的新鮮度折數。
    /// 第一則 1、第二則 0.5、第三則 0.25……收斂到 2，所以一家公司再怎麼發公告，
    /// 單一類型最多也只能貢獻兩則的份量。
    /// </summary>
    private const double NoveltyDecay = 0.5;

    /// <summary>
    /// 各催化類型的半衰期（天），照文件 §12.4 的建議區間取中間值。
    /// 沒列到的類型用 <see cref="DefaultHalfLifeDays"/>。
    /// </summary>
    private static readonly Dictionary<string, double> HalfLifeDays = new(StringComparer.Ordinal)
    {
        // 盤面新聞／單日異動 2～5 日
        ["法說會"] = 5,
        ["澄清"] = 5,
        ["交易警示"] = 3,

        // 財報是定期的，過了那一週市場就換看下一季
        ["財報"] = 10,

        // 事故要看後續，但也就一個月內的事
        ["資安/災害"] = 21,
        ["訴訟/裁罰"] = 30,

        // 訂單／產品認證 30～90 日
        ["訂單/合作"] = 45,
        ["新藥/認證"] = 60,

        // 擴產／資本支出 60～180 日
        ["擴產/投資"] = 90,
        ["併購"] = 90
    };

    private const double DefaultHalfLifeDays = 14;

    /// <param name="asOf">時間衰減算到哪一天。用基準日而不是今天，否則週末重跑 export 分數會自己往下掉。</param>
    /// <returns>族群節點 Id → 新聞熱度 0～100。沒有任何事件的節點不會出現在字典裡（那是「查過了，沒新聞」，不是 0 分）。</returns>
    public static IReadOnlyDictionary<string, decimal> Calculate(
        IReadOnlyList<MaterialEvent> events,
        TopicMapping mapping,
        DateOnly asOf)
    {
        // 先把公告變成「哪一檔、哪一種催化、多少分」，順便把材料性 0 的丟掉。
        var scored = new List<(string Ticker, string Type, double Materiality, int Age)>();

        foreach (var item in events)
        {
            var age = asOf.DayNumber - item.AnnouncedOn.DayNumber;

            if (age < 0 || age > CatalystEventBuilder.FadingDays)
            {
                continue;
            }

            var catalyst = CatalystClassifier.Classify(item.Subject);

            if (catalyst.Materiality <= 0)
            {
                continue;
            }

            scored.Add((item.Ticker, catalyst.Type, catalyst.Materiality, age));
        }

        if (scored.Count == 0)
        {
            return new Dictionary<string, decimal>(StringComparer.Ordinal);
        }

        // 新鮮度要在「同一檔 × 同一類型」這個範圍裡數第幾則，而且要從最新的那則開始數，
        // 這樣拿到滿分的是最新消息，不是三週前的第一則。
        var perTicker = new Dictionary<(string Ticker, string Type), double>();

        foreach (var group in scored.GroupBy(item => (item.Ticker, item.Type)))
        {
            var rank = 0;
            var total = 0.0;

            foreach (var item in group.OrderBy(item => item.Age))
            {
                var novelty = Math.Pow(NoveltyDecay, rank);
                var decay = Math.Pow(0.5, item.Age / HalfLife(item.Type));

                total += item.Materiality * novelty * decay;
                rank++;
            }

            perTicker[group.Key] = total;
        }

        // 一檔股票掛在幾個族群，每個族群就都完整計一次——跟資金熱度同一個口徑，
        // 這裡看的是「這個題材有多少事情在發生」，不是把一則公告切成幾份。
        var members = TopicMembership.Resolve(mapping);
        var result = new Dictionary<string, decimal>(StringComparer.Ordinal);

        foreach (var topic in mapping.Topics)
        {
            var tickers = members.GetValueOrDefault(topic.Id, []);
            var sum = 0.0;

            foreach (var entry in perTicker)
            {
                if (tickers.Contains(entry.Key.Ticker))
                {
                    sum += entry.Value;
                }
            }

            if (sum <= 0)
            {
                continue;
            }

            result[topic.Id] = (decimal)(100.0 * (1.0 - Math.Exp(-sum / Saturation)));
        }

        return result;
    }

    private static double HalfLife(string catalystType)
        => HalfLifeDays.GetValueOrDefault(catalystType, DefaultHalfLifeDays);
}
