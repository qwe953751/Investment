#!/usr/bin/env bash
#
# backup-bundle.py 的內部 SQL 匯出器；原始 SQL 不可直接放進公開 Git。
#
#   scripts/backup-supabase.sh [快照目錄]
#
# 備份範圍刻意不含 daily_quotes、intraday_* 與 monthly_revenue 的**內容**：
# 盤後行情的權威是 data/imports 的 JSON，月營收的權威是公開資訊觀測站，
# 資料庫都只是查詢副本。如果快照裡有一份三個月前的行情，還原時就有機會
# 拿舊資料蓋掉正確資料——這是正確性問題，不是省空間。
# 結構仍然會備份，還原後 sync（行情）或 revenue --backfill（營收）就能補滿。
#
# 另有兩類也刻意不備份，原因不是正確性而是隱私——這份備份會 commit 進公開 repo 的
# data 分支，進了 git 歷史就刪不掉（2026-10-23 使用者決定）：
#   device_sessions 的**內容**：各裝置的 IP 與瀏覽器資訊。裝置在線狀態還原後會自己
#     重新出現，備份它沒有用處。建表語句仍然備份。
#   private_notes、admin_bgm **整張表**：只有最高權限本人能讀的私密表，備份帳號
#     invest_writer 被刻意撤掉了讀取權（db/066、db/070），連 pg_dump 的鎖表都過不了，
#     整份備份會中止（2026-10-20 起連續多天沒有備份就是這樣）；也不能為了備份把讀取權開回去。
#     它們只存在於正式庫：備份不含、還原也不會建立或碰到它們，所以還原不會刪掉
#     正式庫現有的私人筆記。
#
# 排除某張表的內容時，指向它的表也必須一起排除，否則備份會帶著一堆孤兒外鍵，
# 還原到空資料庫時就會停在 violates foreign key constraint。這件事看不出來——
# 備份步驟本身照樣成功，要等每週的還原測試才會紅，所以下面有一段目錄查詢
# 會在備份當下就把「漏排除的下游表」找出來。
#
# 保留策略是 GFS：最近 5 份、每週 4 份、每月 6 份，合計約半年。
# 輪替掉的檔案只是從目錄消失，git 歷史裡永遠找得回來。

set -euo pipefail

if [ "${INVEST_BACKUP_INTERNAL:-}" != 1 ]; then
    echo '請改用 python3 scripts/backup-bundle.py create：原生 SQL 必須完整加密後才可保存。' >&2
    exit 2
fi

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

# psql 跟 pg_dump 同一包，所以拿 pg_dump 的目錄去找，版本一定對得起來。
psql=${PSQL:-$(dirname "$pg_dump")/psql}
if [ ! -x "$psql" ]; then
    psql=$(command -v psql || true)
fi
if [ -z "$psql" ] || [ ! -x "$psql" ]; then
    echo "找不到 psql（備份前的讀取權與外鍵檢查要用）。macOS 可用 brew install libpq。" >&2
    exit 1
fi

# 只列一次，pg_dump 的參數與後面的檢查都從這裡展開。
# 之前這份清單抄了兩份，加表的人只會想到自己那張，兩邊都不會更新。
excluded_tables=(
    daily_quotes
    intraday_quotes
    intraday_runs
    intraday_topic_heat
    monthly_revenue
    device_sessions
    # 由 backup-bundle.py 透過專用唯讀角色匯出、加密；公開 SQL 只保留結構。
    access_share_links
    asset_operation_group_columns
    asset_operation_snapshots
    asset_operation_sync_operations
    asset_operation_sync_state
    ocr_evaluations
    ocr_jobs
    ocr_user_routing
    ocr_workers
)

# 整張表都不備份，連建表語句都不留。新增這類表時加在這裡；漏了也不會悄悄壞掉：
# 下面「備份帳號讀不到」的檢查會在花時間 dump 之前就點名。
private_tables=(
    private_notes
    admin_bgm
)

excluded_csv=$(IFS=,; echo "${excluded_tables[*]}")
private_csv=$(IFS=,; echo "${private_tables[*]}")

exclude_args=()
for excluded in "${excluded_tables[@]}"; do
    exclude_args+=(--exclude-table-data="public.$excluded")
done
for private in "${private_tables[@]}"; do
    exclude_args+=(--exclude-table="public.$private")
done

mkdir -p "$snapshot_dir"

# 日期由 backup-bundle.py 在整輪備份開始時定好再交過來（INVEST_BACKUP_DATE），這裡不自己再問 date：
# 備份跨過午夜時，這裡晚一步算出的「今天」會是隔天，檔名就和 Python 預期的 <日期>.sql.gz 對不上，
# 整輪備份在最後一步才因找不到檔案而中止。沒帶（直接呼叫已被上面的 INVEST_BACKUP_INTERNAL 擋掉）才退回 date。
today=${INVEST_BACKUP_DATE:-$(date +%F)}
if ! [[ "$today" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "備份日期格式不對：$today" >&2
    exit 1
fi
target="$snapshot_dir/$today.sql.gz"
previous=$(ls -1 "$snapshot_dir"/*.sql.gz 2>/dev/null | grep -v "/$today.sql.gz\$" | tail -1 || true)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
plain="$work/dump.sql"

# --exclude-table-data 只擋內容，建表語句還在，所以還原出來是一套空的行情表。
# --exclude-table 連表一起拿掉，pg_dump 也就不會去鎖它（鎖表需要讀取權）。
# --enable-row-security：連線用的是 invest_writer，不是 superuser，
#   沒有這個旗標 pg_dump 會直接拒絕匯出有 RLS 的表。
# 下面三道檢查都在花時間 dump 之前先問資料庫，答案永遠比人腦裡的清單新。

# 備份帳號讀不到、又沒列在 private_tables 的表。pg_dump 一開始會把要備份的表用一句
# LOCK TABLE 全部鎖起來，鎖表需要 SELECT，只要有一張讀不到就整份中止，而且錯誤訊息
# 只說 permission denied for table X，看不出是哪一類問題。
# 排除延伸套件自己的表：pg_dump 本來就不會備份它們，也就不會去鎖。
unreadable=$("$psql" "$SUPABASE_DB_URL" -tAX -c "
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not has_table_privilege(c.oid, 'select')
      and c.relname <> all(string_to_array('$private_csv', ','))
      and not exists (
          select 1 from pg_depend d
          where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
    order by 1;")

if [ -n "$unreadable" ]; then
    echo "備份帳號沒有這些表的讀取權，pg_dump 會在鎖表時整份中止：" >&2
    echo "$unreadable" | sed 's/^/  /' >&2
    echo "只有最高權限本人能讀的私密表：加進本檔的 private_tables（整張不備份，備份會公開在 data 分支）。" >&2
    echo "其餘該備份的表：補 grant select 給備份帳號。" >&2
    exit 1
fi

# 指向 $1 這組表、自己卻不在 $2 這組表裡的表。
foreign_key_sources() {
    "$psql" "$SUPABASE_DB_URL" -tAX -c "
        select distinct child.relname
        from pg_constraint c
        join pg_class child on child.oid = c.conrelid
        join pg_class parent on parent.oid = c.confrelid
        join pg_namespace n on n.oid = child.relnamespace
        where c.contype = 'f'
          and n.nspname = 'public'
          and parent.relname = any(string_to_array('$1', ','))
          and child.relname <> all(string_to_array('$2', ','))
        order by 1;"
}

# 有表指向被排除內容的表卻自己沒被排除的話，備份會帶出孤兒外鍵。
# 自己是整張不備份的私密表就不在此限：它根本不會出現在備份裡。
orphan_sources=$(foreign_key_sources "$excluded_csv" "$excluded_csv,$private_csv")

if [ -n "$orphan_sources" ]; then
    echo "這些表指向被排除內容的表，但自己沒被排除：" >&2
    echo "$orphan_sources" | sed 's/^/  /' >&2
    echo "備份會帶出孤兒外鍵，還原時會停在 violates foreign key constraint。" >&2
    echo "把它們加進本檔的 excluded_tables，或改掉那條外鍵。" >&2
    exit 1
fi

# 整張不備份的私密表，連建表語句都不在備份裡；有別的表指向它，還原時外鍵會指向不存在的表。
private_referrers=$(foreign_key_sources "$private_csv" "$private_csv")

if [ -n "$private_referrers" ]; then
    echo "這些表指向整張不備份的私密表，但自己沒被排除：" >&2
    echo "$private_referrers" | sed 's/^/  /' >&2
    echo "備份會帶出指向不存在資料表的外鍵，還原時會停在 relation does not exist。" >&2
    echo "把它們也加進本檔的 private_tables，或改掉那條外鍵。" >&2
    exit 1
fi

dump_args=(--format=plain --schema=public --no-owner --enable-row-security)
if [ -n "${PG_DUMP_SNAPSHOT:-}" ]; then
    dump_args+=(--snapshot="$PG_DUMP_SNAPSHOT")
fi

"$pg_dump" "$SUPABASE_DB_URL" \
    "${dump_args[@]}" \
    "${exclude_args[@]}" \
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
for excluded in "${excluded_tables[@]}"; do
    if grep -q "^COPY public.$excluded " "$plain"; then
        echo "備份裡出現 $excluded 的資料，排除清單失效了。" >&2
        exit 1
    fi
done

# 私密表連名字都不該出現在備份裡（建表、資料、權限、政策、外鍵都算）。
# 出現就代表排除沒生效；這份檔案會公開在 data 分支，所以這裡在壓縮、寫進快照目錄之前就擋下。
for private in "${private_tables[@]}"; do
    if grep -Eq "public\.$private([^[:alnum:]_]|\$)" "$plain"; then
        echo "備份裡出現私密表 ${private}，排除失效了。" >&2
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
echo "已備份 ${target}（$(printf '%s' "$size" | awk '{printf "%.1f KB", $1/1024}')）"

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
