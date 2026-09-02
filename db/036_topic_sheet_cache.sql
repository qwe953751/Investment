-- 族群樹（F:J）與概念股分頁的最近一次成功讀取結果，純粹當「讀不到 Google Sheet 時」的備援。
--
-- 族群分類的權威來源仍然是 Google Sheet（見 GoogleSheetTopicClient.cs 檔頭），這張表不是
-- 拿來取代它，也不是給前端讀的——匯出流程每次都照樣直接打 Google Sheet，成功就覆寫這裡；
-- 失敗（網路、分享權限被改、Sheet 結構調整到抓不到）才退回讀這張表上次成功的原始內容，
-- 再照平常的規則重新跑一次 TopicCatalogBuilder（結構調整、補分類、產業別兜底、人工編輯都
-- 還是會套用），避免整個族群頁在 Sheet 一時讀不到時直接開天窗。
--
-- 只存兩列，kind 分別是 tree（族群樹 F:J 路徑）與 concepts（概念股分頁），
-- 存的是解析後的原始資料（TopicTreeParser／ConceptSheetParser 的輸出），不是算好的族群結果，
-- 這樣快取生效時還是會套用當下最新的 TopicTreeOverrides.json／TopicMemberOverrides.json，
-- 不會凍結在存快取那一刻的分類規則。

create table if not exists topic_sheet_cache (
    kind         text primary key check (kind in ('tree', 'concepts')),
    captured_at  timestamptz not null,
    payload      jsonb not null
);

alter table topic_sheet_cache enable row level security;

drop policy if exists "public read" on topic_sheet_cache;
drop policy if exists "writer all" on topic_sheet_cache;

create policy "writer all" on topic_sheet_cache for all to invest_writer using (true) with check (true);

-- 這張表只供後端匯出流程使用；前端不直接讀取，避免再增加公開 PostgREST 面積。
revoke all on topic_sheet_cache from anon, authenticated;
grant select, insert, update, delete on topic_sheet_cache to invest_writer;

insert into schema_migrations (filename) values ('036_topic_sheet_cache.sql')
on conflict (filename) do nothing;
