-- 股癌 Podcast 來源：原本只存在瀏覽器 localStorage（invest.podcast.gooaye.sources.v1），
-- 兩台裝置匯入的內容完全看不到彼此。這張表把它改成跟 notes（db/015_notes.sql）、
-- topic_edits（db/017_topic_edits.sql）一樣的模式接上 Supabase。
--
-- 權限跟 notes／topic_edits 一樣是 anon 可寫，理由也一樣：純靜態網站沒有伺服器可以擋
-- 登入邊界，要做到「任何裝置打開網站就能編輯」，唯一的作法就是把匿名金鑰本身當成
-- 寫入權杖。這是使用者明確要求且已知情的取捨（見 015_notes.sql 檔頭）。
--
-- 欄位對應前端現有的資料形狀（podcastPreviewSourceFromInput），不是規劃文件裡
-- 尚未實作的 research_notes 修訂式 schema——目前只需要「把 localStorage 換成資料庫」，
-- 不需要版本歷史、document_hash 這些之後才會用到的欄位。

create table if not exists podcast_sources (
    id          uuid primary key default gen_random_uuid(),
    time        text not null,
    date        text not null,
    episode     text not null default '',
    analysis    text not null default '',
    generated   jsonb not null default '{}'::jsonb,
    updated_at  timestamptz not null default now()
);

create index if not exists podcast_sources_by_time on podcast_sources (time desc);

alter table podcast_sources enable row level security;

drop policy if exists "public read" on podcast_sources;
drop policy if exists "public write" on podcast_sources;
drop policy if exists "writer all" on podcast_sources;

create policy "public read" on podcast_sources for select to anon using (true);

-- 見檔頭說明：跟 notes 一樣故意讓 anon 可寫。
create policy "public write" on podcast_sources for all to anon using (true) with check (true);

create policy "writer all" on podcast_sources for all to invest_writer using (true) with check (true);

grant select, insert, update, delete on podcast_sources to anon;
grant select, insert, update, delete on podcast_sources to invest_writer;

insert into schema_migrations (filename) values ('039_podcast_sources.sql')
on conflict (filename) do nothing;
