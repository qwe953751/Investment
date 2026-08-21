-- 營收儲存格彈窗使用的最近 20 個月摘要。
--
-- monthly_revenue 是原始資料，繼續只給 invest_writer 讀取；
-- revenue_history 則是 revenue 指令使用 C# RevenueSummaryCalculator 算好的公開唯讀結果。
-- 前端不重算 YoY / MoM，只在點擊單一標的時讀取最多 20 列。

create table if not exists revenue_history (
    ticker      text not null,
    month       date not null,
    revenue     bigint not null,
    yoy         double precision,
    mom         double precision,
    updated_at  timestamptz not null default now(),
    primary key (ticker, month)
);

alter table revenue_history enable row level security;

drop policy if exists "public read" on revenue_history;
drop policy if exists "writer all" on revenue_history;

create policy "public read" on revenue_history for select to anon using (true);
create policy "writer all" on revenue_history
    for all to invest_writer using (true) with check (true);

grant select on revenue_history to anon;
grant select, insert, update, delete on revenue_history to invest_writer;

insert into schema_migrations (filename) values ('009_revenue_history.sql')
on conflict (filename) do nothing;
