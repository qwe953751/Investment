-- 最先貼的一份：建立寫入用的角色，以及記錄「哪幾份 SQL 已經貼過」的表。
--
-- 建表語句都是手動貼進 Supabase SQL Editor 的（寫入用的 invest_writer
-- 沒有 create 權限，也不該有）。手動的流程一定會有漏貼的一天，
-- 而漏貼的症狀是幾天後某個指令突然說「relation ... does not exist」，
-- 那時候已經很難想起來到底少貼了哪一份。
--
-- 每份 SQL 的最後一行都會把自己記進 schema_migrations，
-- `verify` 與 `status` 會比對目錄裡的檔案跟這張表，少了就直接說出檔名。

-- 寫入用的專用帳號。不用內建的 postgres 是因為它的密碼重設後不會同步到
-- connection pooler，連不上；順便也讓寫入權限只限於 public schema 這幾張表。
-- 連線時的使用者名稱要寫成 invest_writer.<專案代號>。
do $$
begin
    if not exists (select from pg_roles where rolname = 'invest_writer') then
        create role invest_writer with login password '換成你的密碼';
    end if;
end
$$;

grant usage on schema public to invest_writer;

create table if not exists schema_migrations (
    filename    text primary key,
    applied_at  timestamptz not null default now()
);

alter table schema_migrations enable row level security;

drop policy if exists "public read" on schema_migrations;
drop policy if exists "writer all" on schema_migrations;

create policy "public read" on schema_migrations for select to anon using (true);
create policy "writer all" on schema_migrations for all to invest_writer using (true) with check (true);

grant select on schema_migrations to anon;
grant select, insert, update, delete on schema_migrations to invest_writer;

insert into schema_migrations (filename) values ('000_migrations.sql')
on conflict (filename) do nothing;
