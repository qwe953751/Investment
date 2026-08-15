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

set -euo pipefail

site=${1:-publish/site}
remote=${GH_PAGES_REMOTE:-$(git remote get-url origin)}

if [ ! -f "$site/index.html" ]; then
    echo "找不到 $site/index.html，請先執行 export。" >&2
    exit 1
fi

version=$(python3 -c "import json;print(json.load(open('$site/manifest.json'))['version'])")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cp -R "$site/." "$work/"

# 不讓 GitHub Pages 拿 Jekyll 處理這份產出，否則底線開頭的檔名會被吃掉。
touch "$work/.nojekyll"

cd "$work"
git init -q -b gh-pages
git add -A
git commit -qm "更新排行快照 $version"
git push -qf "$remote" gh-pages

echo "已發佈快照 $version"
