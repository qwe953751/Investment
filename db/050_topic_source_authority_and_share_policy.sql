-- 筆記 #58：族群分類的權威來源改為 Supabase，支援新增節點。
--
-- (A) 表重新定位：topic_sheet_cache → topic_source
--     現在是族群基底資料的權威來源，Google Sheet 降為唯讀歷史備份。
--     Supabase `topic_edits` 累積用戶編輯，其中新增「新增」動作讓使用者建立族群。
--
-- (B) 族群編輯新增「新增」動作，供前端新增全新族群或概念。
--
-- 筆記 #59：分享連結時效與次數改為可設、可不限。
--
-- (A) expires_at 改 nullable：null = 永久
-- (B) max_uses 改 nullable：null = 不限次數
-- (C) 給 fortune@investment.local 設置 admin access_role

-- ===== 族群部分 =====

rename table topic_sheet_cache to topic_source;

comment on table topic_source is
  '族群分類的基底資料，JSON 格式存的是族樹與概念股的原始解析結果。'
  '此表為權威來源；Google Sheet 現在只當唯讀備份。' ||
  E'\n\n' ||
  '匯出流程：讀 topic_source（Supabase 來源） → 套用 JSON overrides → 套用 topic_edits → 輸出。' ||
  E'\n' ||
  '失敗時的備援：如果匯出失敗（或明確指定 Source=sheet），才會重新讀 Google Sheet 並覆寫此表。';

alter table topic_edits drop constraint if exists topic_edits_action_check;
alter table topic_edits
    add constraint topic_edits_action_check
        check (action in ('移到', '移除', '別名', '改名', '加入', '退出', '新增'));

-- ===== 分享連結部分 =====

alter table public.access_share_links alter column expires_at drop not null;

alter table public.access_share_links drop constraint if exists access_share_links_max_uses_check;
alter table public.access_share_links drop constraint if exists access_share_links_use_count_check;

alter table public.access_share_links alter column max_uses drop not null;

alter table public.access_share_links
    add constraint access_share_links_use_count_check
        check (use_count >= 0 and (max_uses is null or use_count <= max_uses));

comment on column public.access_share_links.expires_at is
  'null 代表永久，不會過期。有值時過期時間必須 > now()。';
comment on column public.access_share_links.max_uses is
  'null 代表不限使用次數。有值時 use_count 必須 <= max_uses。';

-- access_share_redeem() 的 where 條件改為：
--   (expires_at is null or expires_at > now())
--   and (max_uses is null or use_count < max_uses)

-- 財神也要能建立分享連結（之前只有 admin@investment.local 有 access_role）
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('access_role', 'admin')
where lower(email) = 'fortune@investment.local'
  and (raw_app_meta_data ->> 'access_role') is null;

insert into schema_migrations (filename) values ('050_topic_source_authority_and_share_policy.sql')
on conflict (filename) do nothing;
