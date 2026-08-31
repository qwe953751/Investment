#!/usr/bin/env bash
#
# 把 export 產生的靜態網站推上 gh-pages 分支。
#
# 每次都用一個全新的 orphan commit 覆蓋整個分支，不保留歷史：
# 一份快照就有一百多 MB，累積下來會讓 clone 這個 repo 變成災難。
# 要看舊的數字就回到本機重跑 export，行情快取才是真正的資料來源。
#
#   scripts/publish-gh-pages.sh [靜態網站目錄]
#
# 推去哪裡預設跟著 origin 走；GitHub Actions 裡用 GH_PAGES_REMOTE 換成帶 token 的網址。
#
# commit 身分固定用 github-actions[bot]，不吃本機或使用者的 git config。
# 原因：這個 commit 會躺在公開網站的 repo 歷史裡，訪客點開就看得到。如果沿用
# 本機全域設定（例如作者本人的 email），只要那個 email 在 GitHub 帳號上是
# 已驗證的，GitHub 就會把這個 commit 連到真實帳號的個人頁面——不管顯示名稱
# 打的是什麼，等於在公開頁面上留了一條能一路點回真實身分的路徑。這正是這個
# 專案要換發布網址想避免的事，所以發布用的 commit 一律用機器人身分，不管是
# CI 自動跑還是本機手動跑。
#
# GH_PAGES_ADMIN_SUBDIR：設定時（例如 admin888），真正的網站內容發到這個子路徑，
# 網域根目錄與 .../viewer/ 都是同網域 iframe 轉發頁，內嵌 $admin_subdir/?access=viewer
# ——網址列停在根目錄／viewer/，訪客模式（訪客層級，見筆記 #37 三層權限）。
# 不設定 GH_PAGES_ADMIN_SUBDIR 時，連子路徑都不發，整個網域只有空白頁——舊網址
# （qwe953751.github.io/Investment/）就是這樣用，等於整個網站在那個網域上完全隱藏，
# 這次「復原根目錄預設訪客模式」只動有設定 admin_subdir 的網域，不影響這個舊網址。
#
# 2026-08-25 之前根目錄也是空白頁，理由是「拿子路徑當最高權限門檻，路過的人只看
# 得到空白頁」——但那時還沒有登入機制，訪客／監控者／最高權限現在是靠密碼分層
# （筆記 #37），子路徑只是不想讓網址列直接暴露 admin888 字樣，不是唯一防線，所以
# 根目錄改回顯示訪客內容是安全的。

set -euo pipefail

site=${1:-publish/site}
remote=${GH_PAGES_REMOTE:-$(git remote get-url origin)}
admin_subdir=${GH_PAGES_ADMIN_SUBDIR:-}

if [ ! -f "$site/index.html" ]; then
    echo "找不到 $site/index.html，請先執行 export。" >&2
    exit 1
fi

# 連交易日一起印出來。發佈的來源是「上一次 export 留下的檔案」，不是現在的資料庫，
# 所以 export 寫到別的地方（例如相對路徑落在 src/Invest.Web/publish/site）時，
# 這支腳本會安靜地把舊快照推上去。把日期擺在眼前，推錯才看得出來。
read -r version trade_date < <(python3 -c "
import json

manifest = json.load(open('$site/manifest.json'))

print(manifest['version'], manifest.get('latestTradingDate', '?'))
")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# 產生一頁同網域 iframe 轉發頁：網址列停在 $2，實際內容來自 $3（登入功能上線後
# 已經有真正的密碼驗證，這裡只是不想讓網址列直接暴露 $admin_subdir 這個字串）。
#
# 轉發頁自己的網址列 query string（例如長者友善連結 ?key=密碼）會原封不動轉貼到
# iframe 的 src 後面，這樣 .../viewer/?key=xxx 才能跟直接打 admin888/?key=xxx 一樣
# 觸發 site.js 的自動登入（見 site.js 內 AUTOLOGIN_QUERY 那段說明）；site.js 用完
# 這個 key 之後只會清掉「它自己那份網址」（iframe 內的 admin888/...）的 query
# string，轉發頁本身網址列上的 ?key= 不會被自動拿掉，分享出去的長者友善連結若含
# 密碼要自行避免外流，跟直接分享 admin888 連結風險相同。
write_iframe_page() {
    local dest="$1" title="$2" target="$3"
    mkdir -p "$dest"
    cat > "$dest/index.html" <<HTML
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>$title</title>
  <style>
    html, body { margin: 0; height: 100%; }
    iframe { display: block; width: 100%; height: 100%; border: 0; }
  </style>
</head>
<body>
  <iframe id="viewer-frame" title="Frank Investment 檢視頁面"></iframe>
  <script>
    var target = '$target';
    var forwarded = window.location.search.replace(/^\\?/, '');
    if (forwarded) {
      target += (target.indexOf('?') === -1 ? '?' : '&') + forwarded;
    }
    document.getElementById('viewer-frame').src = target;
  </script>
</body>
</html>
HTML
}

if [ -n "$admin_subdir" ]; then
    # 網域根目錄改回訪客模式（跟 .../viewer/ 用同一招同網域 iframe，網址列停在
    # 根目錄，不會暴露 $admin_subdir 這個字串）。筆記 #37 上線後已經有密碼登入，
    # 根目錄預設訪客只是初始畫面，訪客／監控者／最高權限仍然看登入狀態決定，
    # 不是靠網址本身擋人。
    write_iframe_page "$work" "Frank Investment" "$admin_subdir/?access=viewer"
else
    # 沒設定 $admin_subdir 的網域（例如舊網址 qwe953751.github.io/Investment/）
    # 維持完全空白，這個網域從沒真正發布過內容，不在這次「復原根目錄」範圍內。
    cat > "$work/index.html" <<'HTML'
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title></title>
</head>
<body></body>
</html>
HTML
fi

# 不讓 GitHub Pages 拿 Jekyll 處理這份產出，否則底線開頭的檔名會被吃掉。
touch "$work/.nojekyll"

if [ -n "$admin_subdir" ]; then
    content="$work/$admin_subdir"
    mkdir -p "$content"
    cp -R "$site/." "$content/"

    # 檢視權限給一個獨立、好記的網址（.../viewer/，跟 $admin_subdir 平級，不是
    # 巢狀在它底下）。內容不整份複製一份——$admin_subdir 底下光 data/ 就有三百多
    # MB，複製兩份會逼近 GitHub Pages 每個網站 1GB 的軟上限，而且會隨交易日累積
    # 越滾越大——改成同網域內用 iframe 內嵌 $admin_subdir/?access=viewer。
    #
    # 原本第一版用 location.replace 做整頁轉址，網址列會確實換成
    # .../$admin_subdir/?access=viewer；使用者回報這正是問題所在：分享「檢視
    # 網址」出去，對方複製網址列貼出來就會帶出 $admin_subdir 這個本來要藏的
    # 最高權限路徑。改用 iframe 後網址列全程停在 .../viewer/，不會再被複製走。
    # iframe 的 src 刻意用 JS 在頁面載入後才設定、不寫死在 HTML 裡，這樣連
    # view-source（純看原始碼、不執行 JS）都看不到 $admin_subdir 字樣，只有
    # 主動按 F12 開發者工具（Elements／Network）才挖得到。之前評估過 iframe 內嵌
    # 別的網域會在原始碼裡直接暴露目標網址（Investment-view 那次），但這裡是
    # 同網域內嵌、且 src 是執行期才寫入，不會有那個問題。根目錄的轉發頁用的是
    # 同一招（見上方 write_iframe_page）。
    #
    # 這仍然不是真正的存取控制：$admin_subdir/?access=viewer 這個網址一旦被挖
    # 出來，拿掉 ?access=viewer 還是能看到最高權限畫面——但筆記 #37 上線後，
    # 看得到畫面不等於能改資料或看見資產金額，那些頁籤與登入層級仍然要密碼。
    # 這裡要擋的只是「分享網址時，網址列本身就洩漏 $admin_subdir 路徑」這件事，
    # 不是防堵刻意打開開發者工具去找的人——跟這個專案其他地方的作法一致（見上面
    # GH_PAGES_ADMIN_SUBDIR 那段說明）。
    write_iframe_page "$work/viewer" "Frank Investment｜檢視" "../$admin_subdir/?access=viewer"
fi

# GitHub Pages 的 branch 發布會把 CNAME 放在來源分支；本腳本每次產生 orphan
# 快照，若不在這裡重建就會把已驗證的自訂網域洗掉。未設定時保持原有網址行為。
if [ -n "${GH_PAGES_CNAME:-}" ]; then
    printf '%s\n' "$GH_PAGES_CNAME" > "$work/CNAME"
fi

cd "$work"
git init -q -b gh-pages
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git add -A
git commit -qm "更新排行快照 $version"
git push -qf "$remote" gh-pages

if [ -n "$admin_subdir" ]; then
    echo "已發佈快照 $version（最新交易日 $trade_date），最高權限在 $admin_subdir/，根目錄與 viewer/ 為訪客模式轉發頁"
else
    echo "已發佈空白頁（無內容），未對外公開任何排行資料（最新交易日 $trade_date）"
fi
