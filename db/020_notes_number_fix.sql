-- 補 db/018_notes_number.sql 的兩個洞。這裡不改 018 本身：它已經套用過了，
-- 改掉等於竄改跑過的歷史，之後對不出真正跑了什麼。
--
-- 一、sequence 的使用權沒有明講。
--     018 只 grant 了 notes 這張表，沒有 grant 這條 sequence。今天新增筆記
--     能拿到編號，是因為 note_number 的 default 走 nextval，而 Supabase 預設
--     把 public schema 的 sequence 權限給了 anon——那是別人的預設值，不是我們
--     寫下來的約定。哪天預設變了，新增筆記會直接噴權限錯誤。這裡補明。
--
-- 二、setval 在空表時會把編號退回 #1。
--     018 用 setval(seq, greatest(max(note_number), 1), exists(...))：
--     筆記全刪光時 max 是 null，greatest(0, 1) = 1、is_called = false，
--     下一個 nextval 就會再發一次 #1。這和 018 檔頭寫的「刪除後不回收」矛盾。
--     重跑 018 才會踩到，但 018 通篇是 if not exists 的可重跑寫法，
--     踩到只是時間問題。
--
--     下面改成「取 max(note_number) 與 sequence 目前已發出的號碼，兩者取大」，
--     所以只會往前不會往後。兩者都是 0（全新安裝、還沒發過任何號）時，
--     setval 的值不能是 0（低於 minvalue 會直接錯），改用 (1, false)，
--     讓第一個 nextval 拿到 #1。

grant usage, select on sequence notes_note_number_seq to anon;
grant usage, select on sequence notes_note_number_seq to invest_writer;

with issued as (
    select greatest(
        coalesce((select max(note_number) from notes), 0),
        (select case when is_called then last_value else last_value - 1 end
           from notes_note_number_seq)) as last_issued
)
select setval(
    'notes_note_number_seq'::regclass,
    greatest(last_issued, 1),
    last_issued > 0)
from issued;

insert into schema_migrations (filename) values ('020_notes_number_fix.sql')
on conflict (filename) do nothing;
