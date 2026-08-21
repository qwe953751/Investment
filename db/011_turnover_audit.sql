-- 盤中成交金額準確度的對照紀錄。**這是暫時的，驗完就刪。**
--
-- 我們盤中的成交金額是「現價 × 累計成交量」推算的（證交所 MIS 只給累計量不給累計值），
-- 盤後回測誤差中位數 0.47%、最大 6.06%。玩股網那支 all-quote-info 給的是真正的累計金額，
-- 2026-08-21 收盤後比對官方 1,956 檔：誤差中位數 0.02%、全市場合計只差 0.0003%。
--
-- 但那是「收盤後比一次」。要把盤中的來源換掉之前，得先確認它整場都撐得住：
-- 會不會中途斷線、會不會有幾檔查不到、會不會某個時段整批停止更新。
-- 所以這兩張表收的是**每一輪的比對結果**，收滿至少六個完整交易日再下判斷。
--
-- 只存摘要與離群值，不存全市場逐檔：
-- 1,975 檔 × 一天約 55 輪 × 6 天 ≈ 65 萬列，光這個驗證就會吃掉資料庫十分之一的空間。
-- 摘要每輪一列、離群值每輪最多 50 列，六天下來不到 2 萬列。
--
-- 驗證結束、盤中來源換好之後，用這兩行清掉：
--
--   drop table if exists turnover_audit_outliers;
--   drop table if exists turnover_audit_rounds;
--   delete from schema_migrations where filename = '011_turnover_audit.sql';
--
-- 三行要一起做：留著 migration 紀錄卻沒有表，下次有人重建資料庫就會少這兩張表；
-- 反過來刪了紀錄卻留著表，schema_migrations 的比對會說有一支沒套用而讓所有指令 exit 1。

create table if not exists turnover_audit_rounds (
    id                  bigserial primary key,
    captured_at         timestamptz not null unique,
    trade_date          date not null,

    -- 玩股網自己回報的資料時間。用來看它有沒有整段停止更新——
    -- captured_at 一直往前走但這個停住不動，就是那邊的資料卡住了。
    reference_time      timestamptz,

    -- 我們的股票池裡，對方也查得到的檔數，以及查不到的檔數。
    matched_count       integer not null,
    missing_count       integer not null,

    -- 兩邊都大於零、真的拿來算誤差的檔數。沒成交的個股不算在內。
    compared_count      integer not null,

    -- 合計都只加總「有對到的那些檔」，否則兩個數字不在同一個母體上。單位是元。
    our_total           numeric(20, 2) not null,
    reference_total     numeric(20, 2) not null,

    -- 逐檔誤差的絕對值分布，單位是百分點。compared_count 為 0 時是 null。
    median_error_percent numeric(10, 4),
    p90_error_percent    numeric(10, 4),
    max_error_percent    numeric(10, 4),

    elapsed_ms          integer not null
);

create index if not exists turnover_audit_rounds_trade_date_idx
    on turnover_audit_rounds (trade_date, captured_at);

-- 誤差超過門檻、或是對方查不到的個股。查不到的那些 reference_value 與 error_percent 是 null。
create table if not exists turnover_audit_outliers (
    round_id        bigint not null references turnover_audit_rounds (id) on delete cascade,
    ticker          text not null,
    our_value       numeric(20, 2) not null,
    reference_value numeric(20, 2),
    error_percent   numeric(10, 4),
    primary key (round_id, ticker)
);

-- 這兩張表只給收集程式自己寫、自己讀，前端完全不碰，所以不開 anon。
alter table turnover_audit_rounds enable row level security;
alter table turnover_audit_outliers enable row level security;

drop policy if exists "writer all" on turnover_audit_rounds;
drop policy if exists "writer all" on turnover_audit_outliers;

create policy "writer all" on turnover_audit_rounds
    for all to invest_writer using (true) with check (true);
create policy "writer all" on turnover_audit_outliers
    for all to invest_writer using (true) with check (true);

grant select, insert, update, delete on turnover_audit_rounds to invest_writer;
grant select, insert, update, delete on turnover_audit_outliers to invest_writer;
grant usage, select on sequence turnover_audit_rounds_id_seq to invest_writer;

insert into schema_migrations (filename) values ('011_turnover_audit.sql')
on conflict (filename) do nothing;
