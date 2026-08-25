-- 族群分類的人工編輯。使用者要能在網站上直接改「族群」與「個股對應什麼族群」。
--
-- 為什麼要一張表而不是繼續往 repo 裡的 JSON 加：那兩份 JSON（TopicTreeOverrides、
-- TopicMemberOverrides）要重新編譯才會生效，使用者手上是一個純靜態網站，
-- 改分類這件事不該每次都得經過我。所以畫面上改的東西寫進這裡，
-- 下一次匯出時讀出來、照跟 JSON 一樣的規則套到樹上。
--
-- 欄位刻意跟那兩份 JSON 用同一套詞彙（動作／節點／父節點／個股／說明），
-- 三個地方講同一種話，之後要把某一筆編輯「定案」成 repo 裡的 JSON 才不用翻譯。
--
-- 權限跟 notes 一樣是 anon 可寫，理由也一樣：純靜態網站沒有伺服器可以擋登入邊界，
-- 要做到「任何裝置打開網站就能編輯」，唯一的作法就是把匿名金鑰本身當成寫入權杖。
-- 這是使用者明確要求且已知情的取捨（見 015_notes.sql 檔頭）。

create table if not exists topic_edits (
    id          uuid primary key default gen_random_uuid(),

    -- 移到／移除／別名 動的是樹的形狀，加入／退出 動的是某個節點的成員。
    action      text not null check (action in ('移到', '移除', '別名', '加入', '退出')),

    -- 被改的節點，用名稱不用 Id：Id 是名稱雜湊出來的，改個名字就對不上了，
    -- 而使用者在畫面上選的、腦子裡想的也都是名稱。
    node        text not null,

    -- 只有「移到」用得到。搬到哪個父節點底下；空字串代表搬成頂層大類。
    parent      text not null default '',

    -- 只有「加入」「退出」用得到。一次可以帶好幾檔，因為使用者是整批挑的。
    tickers     text[] not null default '{}',

    -- 只有「別名」用得到。
    aliases     text[] not null default '{}',

    -- 為什麼這樣改。會原樣顯示在人工編輯頁的紀錄裡。
    note        text not null default '',

    -- 停用而不是刪除：改錯了要看得到「曾經這樣改過又收回」，
    -- 直接刪掉的話下次再看到同樣的怪現象，會想不起來自己試過了。
    enabled     boolean not null default true,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

-- 套用的順序就是建立的順序：後面那一筆蓋前面那一筆，跟人一路改過來的直覺一致。
create index if not exists topic_edits_by_created on topic_edits (created_at);

alter table topic_edits enable row level security;

drop policy if exists "public read" on topic_edits;
drop policy if exists "public write" on topic_edits;
drop policy if exists "writer all" on topic_edits;

create policy "public read" on topic_edits for select to anon using (true);

-- 見檔頭說明：跟 notes 一樣故意讓 anon 可寫。
create policy "public write" on topic_edits for all to anon using (true) with check (true);

create policy "writer all" on topic_edits for all to invest_writer using (true) with check (true);

grant select, insert, update, delete on topic_edits to anon;
grant select, insert, update, delete on topic_edits to invest_writer;

insert into schema_migrations (filename) values ('017_topic_edits.sql')
on conflict (filename) do nothing;
