-- 盤中族群熱度改為非同步衍生資料：原始 intraday_runs 先公開，
-- topic worker 完成後再以自己的 topic-latest.json／DB view 追上。
--
-- 這個 view 不再要求族群熱度必須等於「目前最新 raw run」。
-- 若最新 raw run 尚在計算，先回傳最近一份已完成的族群熱度，
-- 讓前端能以 run_id 顯示「計算中」而不是清空整頁。

drop view if exists intraday_topic_heat_latest;

create view intraday_topic_heat_latest
with (security_invoker = true) as
select
    heat.run_id,
    heat.trade_date,
    heat.captured_at,
    heat.mapping_version,
    heat.mapping_label,
    heat.has_sufficient_data,
    heat.message,
    heat.rows
from intraday_topic_heat heat
order by heat.trade_date desc, heat.captured_at desc, heat.run_id desc
limit 1;

grant select on intraday_topic_heat_latest to anon;

insert into schema_migrations (filename) values ('057_intraday_topic_async.sql')
on conflict (filename) do nothing;
