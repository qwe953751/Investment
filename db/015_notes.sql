-- 筆記：使用者要求做成「多裝置能互動」，所以從 localStorage 改成直接讀寫 Supabase。
--
-- 這張表刻意打破本專案「anon 只能 select，寫入一律走 invest_writer」的慣例：
-- 讓 anon 角色直接擁有 insert/update/delete。原因是這是純靜態網站，沒有伺服器
-- 可以幫忙擋登入邊界，要做到「任何裝置打開網站就能編輯」，唯一的作法就是把
-- 匿名金鑰本身當成寫入權杖。這代表任何人只要知道網站網址與 anon key
-- （原本就寫在 manifest.json 裡，公開可見），就能新增、修改、刪除筆記。
--
-- 這是使用者明確要求且已知情的取捨，範圍只鎖在這張表，不影響其他表的
-- anon 唯讀慣例。如果之後要收回這個權限，必須先有真正的登入機制頂上，
-- 不能只是把這張表的政策改回唯讀（那樣筆記功能就直接壞掉)。

create table if not exists notes (
    id          uuid primary key default gen_random_uuid(),
    note_number bigint,
    title       text not null default '',
    category    text not null default '功能' check (category in ('功能', 'Bug', '待驗證', '完成')),
    status      text not null default '待處理' check (status in ('待處理', '處理中', '待確認', '已完成')),
    content     text not null default '',
    updated_at  timestamptz not null default now()
);

create index if not exists notes_by_updated on notes (updated_at desc);

alter table notes enable row level security;

drop policy if exists "public read" on notes;
drop policy if exists "public write" on notes;
drop policy if exists "writer all" on notes;

create policy "public read" on notes for select to anon using (true);

-- 見檔頭說明：這是唯一一張 anon 可以寫入的表，故意的。
create policy "public write" on notes for all to anon using (true) with check (true);

create policy "writer all" on notes for all to invest_writer using (true) with check (true);

grant select, insert, update, delete on notes to anon;
grant select, insert, update, delete on notes to invest_writer;

insert into schema_migrations (filename) values ('015_notes.sql')
on conflict (filename) do nothing;
