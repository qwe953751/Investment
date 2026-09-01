-- 出入金金額不應由資料型別限制總位數或小數位數。
--
-- UI 以文字欄位輸入、即時加千分位，送出前仍只接受正數；這裡改成無 typmod 的
-- PostgreSQL numeric，保留既有 amount > 0 約束與所有既有數值，不截斷使用者資料。
-- db/030_asset_cash_flows.sql 必須已先套用。

alter table asset_cash_flows
    alter column amount type numeric
    using amount::numeric;

insert into schema_migrations (filename) values ('032_asset_cash_flows_unbounded_amount.sql')
on conflict (filename) do nothing;
