-- db/026 建了 us_watchlist 跟兩條 RLS policy，但漏了資料表本身的 grant——
-- RLS 只負責「篩選看得到哪幾列」，角色要先有 select/insert/update/delete
-- 權限才輪得到 RLS 判斷，兩者缺一不可。結果本機第一次跑 backfill-us
-- 就撞牆：
--
--     Npgsql.PostgresException: 42501: permission denied for table us_watchlist
--
-- 這跟 db/022 是同一個坑：001 的「grant all tables」只涵蓋當時已存在的表，
-- 之後新增的表都要自己補一次。022 已經幫 sequence 設了 default privileges，
-- 這裡把 table 也一併設起來，往後新增的表就不會再重演這齣。

grant select on us_watchlist to anon;
grant select, insert, update, delete on us_watchlist to invest_writer;

-- 之後由 postgres（Management API 套用 migration 時的角色）新建的表
-- 自動帶上同樣的寫入權限。不含 anon——理由同 db/022：anon 該拿什麼
-- 要一張表一張表想清楚，不能靠預設值發下去。
alter default privileges for role postgres in schema public
    grant select, insert, update, delete on tables to invest_writer;

insert into schema_migrations (filename) values ('027_us_watchlist_grants.sql')
on conflict (filename) do nothing;
