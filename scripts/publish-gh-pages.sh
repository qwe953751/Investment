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
# GH_PAGES_PUBLISH_ROOT：設定時，真正的網站內容直接發到網域根目錄——網站只有
# 單一網址，訪客層級是唯一預設值（見 site.js 的 URL_ACCESS），監控者／最高權限
# 一律要密碼登入才能拿到，不再靠路徑當防線。不設定時整個網域只發空白頁——舊網址
# （qwe953751.github.io/Investment/）就是這樣用，等於整個網站在那個網域上完全隱藏。
#
# 2026-09-01 之前這裡曾經是「根目錄放轉發頁、真正內容藏在 admin888/ 子路徑」的
# 過渡設計，用意是不讓網址列直接暴露子路徑字樣；但子路徑從來不是真正的存取控制
# （筆記 #37 的密碼登入才是），多一層轉發只讓維護變複雜，所以收掉這兩個網址，
# 改成單一網址＋登入分層。

set -euo pipefail

site=${1:-publish/site}
remote=${GH_PAGES_REMOTE:-$(git remote get-url origin)}
publish_root=${GH_PAGES_PUBLISH_ROOT:-}

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
cleanup_work() {
    local result=$?
    for attempt in 1 2 3; do
        if rm -rf "$work"; then return "$result"; fi
        sleep 1
    done
    echo "::warning::暫存發布目錄未清乾淨：$work（runner 結束時會清除）" >&2
    return "$result"
}
trap cleanup_work EXIT

if [ -n "$publish_root" ]; then
    # 網站內容直接發到網域根目錄，不再經過子路徑或 iframe 轉發——訪客／監控者／
    # 最高權限一律看登入狀態決定，網址本身不再是任何一層防線。
    cp -R "$site/." "$work/"
else
    # 沒設定 $publish_root 的網域（例如舊網址 qwe953751.github.io/Investment/）
    # 維持完全空白，這個網域從沒真正發布過內容。
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

# GitHub Pages 的 branch 發布會把 CNAME 放在來源分支；本腳本每次產生 orphan
# 快照，若不在這裡重建就會把已驗證的自訂網域洗掉。未設定時保持原有網址行為。
if [ -n "${GH_PAGES_CNAME:-}" ]; then
    printf '%s\n' "$GH_PAGES_CNAME" > "$work/CNAME"
fi

# 容量守門：推送前量「真正要推出去的內容」（$work，含 .nojekyll／CNAME），過大就中止、什麼都不推。
# 量這裡而不是 $site，是因為舊網址只發一頁空白頁，不該被正式站的大小擋下。
#
# GitHub Pages 的網站上限是 1 GB（官方只寫「no larger than 1 GB」，沒說是 10^9 還是 2^30，
# 保守照 10^9 bytes 算）。actions/deploy-pages 只檢查壓縮後的 artifact——2026-10-24 正式站是
# 948 MB，artifact 只有約 184 MB——所以網站超過上限之前不會有任何警告，等到超過的那一次發布
# 才失敗。排行檔占 88%，已事先 gzip 成 .json.gz（StaticSiteExporter.WriteGzipJsonAsync）；
# 週／月 K 隨行情累積每年約 +18 MB，門檻不必因此調整。
#
# data/ 裡若又出現未壓縮的排行檔（.json），代表 export 的輸出目錄沒清乾淨、新舊格式一起被帶上來，
# 容量會變回兩倍，所以直接擋下，不是只印警告。
size_limit=${GH_PAGES_SIZE_LIMIT_BYTES:-900000000}
size_warn=${GH_PAGES_SIZE_WARN_BYTES:-700000000}

python3 -I - "$work" "$size_limit" "$size_warn" <<'PY'
import os
import re
import sys

root = sys.argv[1]

try:
    limit, warn = int(sys.argv[2]), int(sys.argv[3])
except ValueError:
    print('GH_PAGES_SIZE_LIMIT_BYTES／GH_PAGES_SIZE_WARN_BYTES 必須是整數（bytes）。', file=sys.stderr)
    sys.exit(1)

ranking = re.compile(r'data/(?:single-)?\d+-\d{4}-\d{2}-\d{2}\.json(?P<gzip>\.gz)?')
categories = ['排行檔', 'data/kline', 'data/etf', 'data/market-structure', '其他']
totals = {name: [0, 0] for name in categories}  # [檔數, bytes]
uncompressed = []

for directory, subdirectories, names in os.walk(root):
    subdirectories[:] = [name for name in subdirectories if name != '.git']

    for name in names:
        path = os.path.join(directory, name)
        relative = os.path.relpath(path, root).replace(os.sep, '/')
        size = os.lstat(path).st_size
        match = ranking.fullmatch(relative)

        if match:
            category = '排行檔'

            if match.group('gzip') is None:
                uncompressed.append(relative)
        elif relative.startswith('data/kline/'):
            category = 'data/kline'
        elif relative.startswith('data/etf/'):
            category = 'data/etf'
        elif relative.startswith('data/market-structure/'):
            category = 'data/market-structure'
        else:
            category = '其他'

        totals[category][0] += 1
        totals[category][1] += size

total = sum(size for _, size in totals.values())
count = sum(files for files, _ in totals.values())

print(f'容量守門：準備推送 {count} 個檔案，合計 {total / 1e6:.1f} MB（警告 {warn / 1e6:.0f} MB、上限 {limit / 1e6:.0f} MB）')
for name in categories:
    files, size = totals[name]
    print(f'  {name:<22} {size / 1e6:8.1f} MB  {files:5d} 檔')

# 管線裡 stdout 是整塊緩衝、stderr 不是；不先 flush，Actions 的 log 會變成錯誤訊息在表格之前。
sys.stdout.flush()

if uncompressed:
    print(
        f'::error::data/ 裡有 {len(uncompressed)} 個未壓縮的排行檔（例如 {uncompressed[0]}）。'
        '排行檔應該全部是 .json.gz；請用乾淨的輸出目錄重新 export，不要把新舊格式混在一起發布。',
        file=sys.stderr)
    sys.exit(1)

if total >= limit:
    print(
        f'::error::網站 {total / 1e6:.1f} MB 已達發布上限 {limit / 1e6:.0f} MB（GitHub Pages 硬上限 1 GB），'
        '不推送。請先看上面各類別的大小再瘦身，不要直接調高上限。',
        file=sys.stderr)
    sys.exit(1)

if total >= warn:
    print(
        f'::warning::網站 {total / 1e6:.1f} MB 已超過警告線 {warn / 1e6:.0f} MB，'
        f'離發布上限 {limit / 1e6:.0f} MB 剩 {(limit - total) / 1e6:.1f} MB；再加資料類型前先量容量。')
PY

cd "$work"
git init -q -b gh-pages
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git add -A
git commit -qm "更新排行快照 $version"
git push -qf "$remote" gh-pages

# 變數一律加大括號：macOS 內建的 bash 3.2 在 UTF-8 locale 下，會把緊接在 $trade_date 後面的全形括號
# 當成變數名稱的一部分，set -u 之後整支腳本在推送完成後才以 unbound variable 失敗。
if [ -n "$publish_root" ]; then
    echo "已發佈快照 ${version}（最新交易日 ${trade_date}）到網域根目錄，訪客模式為預設，監控者／最高權限需登入"
else
    echo "已發佈空白頁（無內容），未對外公開任何排行資料（最新交易日 ${trade_date}）"
fi
