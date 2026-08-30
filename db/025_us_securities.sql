-- securities.market 只允許 TWSE/TPEX，美股回補（backfill-us）寫入時會直接被
-- constraint 擋掉。放寬成允許 'US'，讓 SecurityCatalog 能正常 upsert 美股代碼。

alter table securities drop constraint if exists securities_market_check;

alter table securities
    add constraint securities_market_check check (market in ('TWSE', 'TPEX', 'US'));

insert into schema_migrations (filename) values ('025_us_securities.sql')
on conflict (filename) do nothing;
