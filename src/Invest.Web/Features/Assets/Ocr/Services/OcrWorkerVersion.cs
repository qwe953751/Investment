namespace Invest.Web.Features.Assets.Ocr.Services;

/// <summary>
/// AI OCR Worker 的版本號。Worker 是常駐在各台機器上的程式，不會跟著網站發布更新；
/// 網站上傳前會從 readiness 回應讀到負責那台的版本，比網站要求的舊就顯示警告
/// （2026-10-13：公司 Windows 沒重建，三欄股數修正對使用者無效，畫面卻沒有任何徵兆）。
///
/// 改了 Worker 端的 AI OCR 程式（<c>Features/Assets/Ocr</c>、<c>Infrastructure/Ai/Cli</c>）就要把 <see cref="Current"/> +1，
/// 並同步 site.js 的 <c>ASSET_AI_OCR_WORKER_VERSION</c>；<c>OcrWorkerVersionTests</c> 會比對兩邊相同，
/// 也會用程式指紋擋下「改了程式卻忘了升版」。
/// </summary>
public static class OcrWorkerVersion
{
    /// <summary>
    /// 1＝2026-10-13 之前（沒有回報版本）；2＝昨日餘額／今買成／今賣成三欄股數＋回報版本；
    /// 3＝2026-10-16 Agent 改成「沒成功就換」（Codex 失敗改跑 Claude、全部失敗才接力給另一台），背景評估只用主要 Agent；
    /// 4＝2026-10-17 修正送給 Claude 的 Schema（移除被 CLI 拒絕的 `$schema`），Claude 備援才真正能用，失敗原因附上診斷訊息；
    /// 5＝2026-10-17 CLI 的 stdout／stderr 一律以 UTF-8 解讀（Windows 預設用主控台字碼頁 950，Claude 的中文結果被讀壞成 invalid_json）。
    /// </summary>
    public const int Current = 5;

    public static string Label => $"AI OCR v{Current}";

    /// <summary>
    /// 回報給伺服器的 platform：版本放最前面，作業系統描述接在後面。伺服器與資料庫判斷 Windows
    /// 都是子字串比對（<c>/windows/i</c>、<c>ilike '%windows%'</c>），加前綴不影響分流；
    /// Edge 只保留前 100 字，版本放前面才不會被截掉。
    /// </summary>
    public static string DescribePlatform(string osDescription) => $"{Label} · {osDescription}";
}
