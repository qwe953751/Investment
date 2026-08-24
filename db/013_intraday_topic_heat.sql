-- 盤中族群熱度：每一輪都用同一輪 MIS 報價，由 C# TopicHeatCalculator 算好後保存。
-- 這張表是 intraday_runs 的衍生快照；新交易日成功寫入時，舊盤中資料連同它一起刪除。

create table if not exists intraday_topic_heat (
    run_id                  bigint primary key references intraday_runs(id) on delete cascade,
    trade_date              date not null,
    captured_at             timestamptz not null,
    mapping_version         integer not null,
    mapping_label           text not null,
    has_sufficient_data     boolean not null,
    message                 text,
    rows                    jsonb not null default '[]'::jsonb
);

create index if not exists intraday_topic_heat_by_latest
    on intraday_topic_heat (trade_date desc, captured_at desc);

alter table intraday_topic_heat enable row level security;

drop policy if exists "public read" on intraday_topic_heat;
drop policy if exists "writer all" on intraday_topic_heat;

create policy "public read" on intraday_topic_heat for select to anon using (true);
create policy "writer all" on intraday_topic_heat for all to invest_writer using (true) with check (true);

drop view if exists intraday_topic_heat_latest;

-- 只看目前網站所讀的最新 MIS 輪次；若這輪的族群資料沒寫成功，寧可回空而不是顯示舊輪次假裝即時。
create view intraday_topic_heat_latest
with (security_invoker = true) as
select
    heat.trade_date,
    heat.captured_at,
    heat.mapping_version,
    heat.mapping_label,
    heat.has_sufficient_data,
    heat.message,
    heat.rows
from intraday_topic_heat heat
where heat.run_id = (
    select id
    from intraday_runs
    order by trade_date desc, captured_at desc, id desc
    limit 1
);

grant select on intraday_topic_heat to anon;
grant select on intraday_topic_heat_latest to anon;
grant select, insert, update, delete on intraday_topic_heat to invest_writer;

insert into schema_migrations (filename) values ('013_intraday_topic_heat.sql')
on conflict (filename) do nothing;
