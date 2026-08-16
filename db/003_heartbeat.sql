-- 自動流程的心跳。貼進 Supabase 的 SQL Editor 執行即可，可重複執行。
--
-- 兩個目的：
--   1. 每天寫一列，讓 Supabase 有活動紀錄。免費方案七天沒動靜就會被暫停。
--   2. 留下「誰在什麼時候跑過」的痕跡。流程整個沒跑（例如排程被 GitHub 停用）
--      不會有任何錯誤訊息，只能靠最後一次心跳的日期看出來。
--
-- 保留 180 天，跟備份涵蓋的期間一致。

create table if not exists heartbeat (
    id      bigint generated always as identity primary key,
    ran_at  timestamptz not null default now(),
    source  text not null,
    note    text
);

create index if not exists heartbeat_ran_at on heartbeat (ran_at desc);

alter table heartbeat enable row level security;

drop policy if exists "public read" on heartbeat;
drop policy if exists "writer all" on heartbeat;

create policy "public read" on heartbeat for select to anon using (true);
create policy "writer all" on heartbeat for all to invest_writer using (true) with check (true);

grant select on heartbeat to anon;
grant select, insert, update, delete on heartbeat to invest_writer;
grant usage, select on sequence heartbeat_id_seq to invest_writer;

insert into schema_migrations (filename) values ('003_heartbeat.sql')
on conflict (filename) do nothing;
