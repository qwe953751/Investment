using System.Security.Cryptography;
using System.Text;

namespace Invest.Web.Features.StockTopics.Services;

/// <summary>
/// 產生族群節點的識別碼。
///
/// 為什麼不直接用中文名稱當 key：使用者會改名（「砷化鎵」與「GaAs」就是同一件事的兩種寫法），
/// 名稱一改，指向它的連結、歷史熱度與人工修正全部斷掉。所以對外一律用 Id，名稱只是顯示文字。
///
/// 但這一版的 Id 只能從名稱推導——Google Sheet 沒有任何欄位可以當穩定鍵，
/// 憑空發號又沒有地方存。折衷是：Id = 來源 + 正規化名稱的雜湊，
/// 意思是「同一份表格裡的同一個名稱，永遠得到同一個 Id」。
/// 這讓每次匯出的 Id 是穩定的，前端可以放心拿它當連結與展開狀態的 key。
/// 真正的改名保護要等 Id 有地方保存（資料庫或一份對照檔）之後才成立，
/// 那時候只要換掉這個類別，其餘程式碼與 JSON 欄位都不用動。
/// </summary>
public static class TopicIdFactory
{
    /// <summary>
    /// 名稱正規化：儲存格裡有換行（「銅箔基板\n(CCL)」）、全形空白與前後空白，
    /// 這些都只是排版，不該讓同一個概念變成兩個節點。
    /// </summary>
    public static string Normalize(string name)
    {
        var builder = new StringBuilder(name.Length);

        foreach (var character in name)
        {
            if (char.IsWhiteSpace(character) || character == '\u3000')
            {
                continue;
            }

            builder.Append(character);
        }

        return builder.ToString();
    }

    public static string Create(string prefix, string name)
    {
        var normalized = Normalize(name);
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(prefix + '\u0000' + normalized));

        // 只取前 5 個 byte（10 個十六進位字元）。151 + 113 個節點離碰撞還差得非常遠，
        // 但短 Id 在網址與 JSON 裡好讀得多。
        return prefix + '-' + Convert.ToHexStringLower(hash.AsSpan(0, 5));
    }
}
