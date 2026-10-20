-- 完成公開筆記圖片複製後，移除限兩個隨機路徑的匿名上傳 policy。
drop policy if exists "private note image one-time import" on storage.objects;

insert into public.schema_migrations (filename) values ('069_private_note_image_import_cleanup.sql')
on conflict (filename) do nothing;
