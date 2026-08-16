#!/usr/bin/env bash
#
# 把 Supabase 的「原生資料」備份成一份可以自己重建資料庫的 SQL。
#
#   scripts/backup-supabase.sh [快照目錄]
#
# 備份範圍刻意不含 daily_quotes 與 intraday_* 的**內容**：
# 盤後行情的權威是 data/imports 的 JSON，資料庫只是查詢副本。
# 如果快照裡有一份三個月前的行情，還原時就有機會拿舊資料蓋掉正確資料——
# 這是正確性問題，不是省空間。結構仍然會備份，還原後直接 sync 就能補滿。
#
# 保留策略是 GFS：最近 5 份、每週 4 份、每月 6 份，合計約半年。
# 輪替掉的檔案只是從目錄消失，git 歷史裡永遠找得回來。

set -euo pipefail

snapshot_dir=${1:-data/snapshots}

: "${SUPABASE_DB_URL:?請先設定 SUPABASE_DB_URL}"

pg_dump=${PG_DUMP:-$(command -v pg_dump || true)}
if [ -z "$pg_dump" ]; then
    pg_dump=$(ls -d /opt/homebrew/Cellar/libpq/*/bin/pg_dump 2>/dev/null | tail -1 || true)
fi
if [ -z "$pg_dump" ]; then
    echo "找不到 pg_dump。macOS 可用 brew install libpq。" >&2
    exit 1
fi

mkdir -p "$snapshot_dir"

today=$(date +%F)
target="$snapshot_dir/$today.sql.gz"
previous=$(ls -1 "$snapshot_dir"/*.sql.gz 2>/dev/null | grep -v "/$today.sql.gz\$" | tail -1 || true)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
plain="$work/dump.sql"

# --exclude-table-data 只擋內容，建表語句還在，所以還原出來是一套空的行情表。
# --enable-row-security：連線用的是 invest_writer，不是 superuser，
#   沒有這個旗標 pg_dump 會直接拒絕匯出有 RLS 的表。
"$pg_dump" "$SUPABASE_DB_URL" \
    --format=plain \
    --schema=public \
    --no-owner \
    --enable-row-security \
    --exclude-table-data='public.daily_quotes' \
    --exclude-table-data='public.intraday_quotes' \
    --exclude-table-data='public.intraday_runs' \
    > "$plain"

# 第一層：內容看起來像不像一份完整的 dump。
# pg_dump 中途死掉會留下一個沒有結尾標記的半截檔案，大小卻可能很正常。
if ! grep -q '^-- PostgreSQL database dump complete' "$plain"; then
    echo "備份不完整：找不到 pg_dump 的結尾標記。" >&2
    exit 1
fi
if ! grep -q 'CREATE TABLE public.securities' "$plain"; then
    echo "備份內容不對：沒有 securities 的建表語句。" >&2
    exit 1
fi

# 排除清單失效的話（例如表被改名）行情就會偷偷混進備份裡，這裡直接擋下來。
for excluded in daily_quotes intraday_quotes intraday_runs; do
    if grep -q "^COPY public.$excluded " "$plain"; then
        echo "備份裡出現 $excluded 的資料，排除清單失效了。" >&2
        exit 1
    fi
done

gzip -9 -c "$plain" > "$target"

# 第二層：壓完的檔案本身能不能解開。
if ! gzip -t "$target"; then
    echo "壓縮檔損毀：$target" >&2
    rm -f "$target"
    exit 1
fi

size=$(wc -c < "$target" | tr -d ' ')
rows=$(grep -c '^INSERT INTO\|^COPY public' "$plain" || true)
echo "已備份 $target（$(printf '%s' "$size" | awk '{printf "%.1f KB", $1/1024}')）"

# 第三層：跟上一份比大小。原生資料只會慢慢長大，突然縮水通常代表刪錯東西。
if [ -n "$previous" ]; then
    previous_size=$(wc -c < "$previous" | tr -d ' ')
    if [ "$previous_size" -gt 0 ] && [ $((size * 100 / previous_size)) -lt 70 ]; then
        echo "警告：比上一份 $(basename "$previous") 小了三成以上（$previous_size → $size），請確認資料沒有被誤刪。" >&2
    fi
fi

# GFS 輪替。日期都在檔名裡，直接按檔名分組就好。
python3 - "$snapshot_dir" <<'PY'
import os, re, sys
from collections import OrderedDict
from datetime import date

snapshot_dir = sys.argv[1]
pattern = re.compile(r'^(\d{4})-(\d{2})-(\d{2})\.sql\.gz$')

files = {}
for name in os.listdir(snapshot_dir):
    m = pattern.match(name)
    if m:
        files[date(*map(int, m.groups()))] = name

if not files:
    sys.exit(0)

ordered = sorted(files, reverse=True)
keep = OrderedDict((d, '最近') for d in ordered[:5])

def keep_newest_per(group_of, limit, label):
    """每個週／月留最新的一份。已經被留下的那幾週不算在名額裡，
    否則「最近 5 份」會把本週本月的名額吃掉，實際涵蓋期間比預期短一大截。"""
    newest_of_group = OrderedDict()
    for d in ordered:
        newest_of_group.setdefault(group_of(d), d)

    added = 0
    for d in newest_of_group.values():
        if added == limit:
            break
        if d not in keep:
            keep[d] = label
            added += 1

keep_newest_per(lambda d: d.isocalendar()[:2], 4, '每週')
keep_newest_per(lambda d: (d.year, d.month), 6, '每月')

for d in ordered:
    if d not in keep:
        os.remove(os.path.join(snapshot_dir, files[d]))
        print(f'輪替掉 {files[d]}')

print('保留 ' + '、'.join(f'{d}({label})' for d, label in sorted(keep.items(), reverse=True)))
PY
