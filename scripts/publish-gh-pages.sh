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
# GH_PAGES_ADMIN_SUBDIR：設定時（例如 admin888），真正的網站內容改發到這個
# 子路徑，網域根目錄只留一頁看不到任何內容的空白頁。不設定時，連子路徑都不發，
# 整個網域只有那頁空白頁——舊網址（qwe953751.github.io/Investment/）就是這樣用，
# 等於整個網站在那個網域上完全隱藏。用子路徑當最高權限的門檻，跟原本的
# ?access=viewer 一樣本來就不是真正的存取控制，只是讓路過的訪客看到空白頁，
# 知道網址、故意去找的人才看得到內容。

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

# 網域根目錄一律只放空白頁，不含任何排行資料或版面——這是刻意的行為，不是
# 漏推：真正的內容只會出現在 GH_PAGES_ADMIN_SUBDIR 指定的子路徑之下；沒設
# 子路徑時，這個網域完全不發布內容。
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
    # 同網域內嵌、且 src 是執行期才寫入，不會有那個問題。
    #
    # 這仍然不是真正的存取控制：$admin_subdir/?access=viewer 這個網址一旦被挖
    # 出來，拿掉 ?access=viewer 還是能看到最高權限畫面（沒有登入機制）。這裡要
    # 擋的是「分享檢視網址時，網址列本身就洩漏最高權限路徑」這件事，不是防堵
    # 刻意打開開發者工具去找的人——跟這個專案其他地方的作法一致（見上面
    # GH_PAGES_ADMIN_SUBDIR 那段說明）。
    mkdir -p "$work/viewer"
    cat > "$work/viewer/index.html" <<HTML
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Frank Investment｜檢視</title>
  <style>
    html, body { margin: 0; height: 100%; }
    iframe { display: block; width: 100%; height: 100%; border: 0; }
  </style>
</head>
<body>
  <iframe id="viewer-frame" title="Frank Investment 檢視頁面"></iframe>
  <script>
    document.getElementById('viewer-frame').src = '../$admin_subdir/?access=viewer';
  </script>
</body>
</html>
HTML
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
    echo "已發佈快照 $version（最新交易日 $trade_date），最高權限在 $admin_subdir/，根目錄為空白頁"
else
    echo "已發佈空白頁（無內容），未對外公開任何排行資料（最新交易日 $trade_date）"
fi
