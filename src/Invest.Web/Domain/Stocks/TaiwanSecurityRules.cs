namespace Invest.Web.Domain.Stocks;

/// <summary>
/// 台股標的分類規則的唯一定義處。
///
/// 代碼形狀只能判斷「這可能是什麼」，不能當成權威分類：四碼數字可能是普通股也可能是
/// 2009 年以前掛牌的 TDR，六碼可能是 ETF 也可能是之後掛牌的 TDR。因此這裡的規則都以
/// 名稱或官方名冊為準，各解析器與讀取舊快取的程式都呼叫這一份，不各自寫正規表示式。
/// </summary>
public static class TaiwanSecurityRules
{
    private const string TdrNameSuffix = "-DR";

    /// <summary>
    /// 證交所規定 TDR 的證券簡稱必須以「-DR」結尾（例如 美德醫療-DR、康師傅-DR）。
    /// 2026-10-02 證交所日行情的十檔 TDR（四碼 4 檔、六碼 6 檔）全部符合。
    /// </summary>
    public static bool IsTdrName(string? name)
        => name is not null
            && name.Trim().EndsWith(TdrNameSuffix, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// TDR 的代碼只可能是純數字四碼（舊）或六碼（新），而且不以 0 開頭
    /// （0 開頭是 ETF）。用來擋掉名稱剛好帶 -DR 的其他商品。
    /// </summary>
    public static bool IsTdrTickerShape(string? ticker)
    {
        var normalized = ticker?.Trim();

        return normalized is { Length: 4 or 6 }
            && normalized[0] != '0'
            && normalized.All(char.IsAsciiDigit);
    }

    /// <summary>
    /// 是不是以外幣計價的 ETF 交易線。櫃買中心與證交所的雙幣 ETF 以第六碼區分：
    /// K 與 C 結尾是外幣（美元、人民幣）交易線，同一檔基金另有新台幣交易線
    /// （例如 00625K 對應 006205，00636K 對應 00636）。
    ///
    /// 台股頁籤只顯示新台幣商品；這個判斷只決定「頁籤要不要顯示」，
    /// 原始行情照樣保存，持倉查名稱也不受影響。
    /// </summary>
    public static bool IsForeignCurrencyEtfLine(string? ticker)
    {
        var normalized = ticker?.Trim().ToUpperInvariant();

        return normalized is { Length: 6 }
            && normalized[0] == '0'
            && normalized[^1] is 'K' or 'C';
    }

    /// <summary>
    /// 把「看起來是普通股」的資料依名稱修正成 TDR。讀取舊快取與資料庫列時用，
    /// 因為那些資料沒有種類欄位，或當初的解析器還不認得 TDR。
    /// </summary>
    public static StockKind Reclassify(StockKind kind, string? ticker, string? name)
        => kind == StockKind.CommonStock && IsTdrName(name) && IsTdrTickerShape(ticker)
            ? StockKind.Tdr
            : kind;
}
