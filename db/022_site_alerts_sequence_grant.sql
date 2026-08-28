-- 備份從 2026-08-23 起每天都失敗，因為 site_alerts 的 sequence 沒授權。
--
-- db/012 建了 site_alerts（id 是 generated always as identity），
-- grant 了表卻沒 grant 那條隱含的 sequence。寫入沒事——identity 欄位的
-- sequence 由欄位擁有，insert 不另外檢查 sequence 權限——所以鈴鐺一直正常運作，
-- 沒有任何症狀。
--
-- 壞掉的是備份。scripts/backup-supabase.sh 用 invest_writer 連線，pg_dump 會對
-- 每一條 sequence 打一次 `SELECT last_value, is_called FROM ...`，那個才要 select 權限：
--
--     pg_dump: error: query failed: ERROR:  permission denied for sequence site_alerts_id_seq
--
-- 於是自 08-23 起每一次完整快照都在「備份原生資料」這一步紅掉，**還原路徑實際上是空的**。
-- 08-19 是最後一份成功的備份。這中間沒人發現，是因為紅掉的那幾次剛好也有別的步驟紅，
-- 或者跑的是 publish-only（會略過備份）。
--
-- 這已經是同一個坑第二次了：db/018 也漏了 notes_note_number_seq，db/020 才補上。
-- 所以除了補這一條，順便把預設權限設起來，之後新增有 identity 欄位的表就不會再踩。

grant usage, select on sequence site_alerts_id_seq to invest_writer;

-- 把現有的全部補齊一次。上面那行是給人看的（明講是哪一條、為什麼），
-- 這行是保險：db/001 當初也做過一次同樣的事，但它只涵蓋當時已存在的 sequence。
grant usage, select on all sequences in schema public to invest_writer;

-- 之後由 postgres（Management API 套用 migration 時的角色）新建的 sequence
-- 自動帶上同樣的權限。不含 anon——anon 該拿什麼要一條一條想清楚，
-- 像 db/020 的 notes_note_number_seq 那樣明講，不能靠預設值發下去。
alter default privileges for role postgres in schema public
    grant usage, select on sequences to invest_writer;

insert into schema_migrations (filename) values ('022_site_alerts_sequence_grant.sql')
on conflict (filename) do nothing;
