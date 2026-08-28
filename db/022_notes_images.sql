-- 筆記圖片附件。
--
-- 圖片不塞進 notes.content；檔案放在 Supabase Storage，notes.attachments 只保存
-- 檔案路徑與顯示用的基本資訊。因為目前筆記頁仍是純靜態站，沿用 notes 的已知
-- anon 可讀寫模型；note-images 是公開 bucket，請不要上傳含有帳號、密碼或敏感
-- 金融資訊的原始截圖。真正的個人權限要等登入／白名單模型完成後再收緊。

alter table notes
    add column if not exists attachments jsonb not null default '[]'::jsonb;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'note-images',
    'note-images',
    true,
    5242880,
    array['image/jpeg', 'image/png', 'image/gif', 'image/webp']::text[]
)
on conflict (id) do update set
    name = excluded.name,
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "note images anonymous upload" on storage.objects;
drop policy if exists "note images anonymous cleanup select" on storage.objects;
drop policy if exists "note images anonymous delete" on storage.objects;

create policy "note images anonymous upload"
on storage.objects
for insert to anon
with check (
    bucket_id = 'note-images'
    and (storage.foldername(name))[1] = 'notes'
    and storage.extension(name) in ('jpg', 'jpeg', 'png', 'gif', 'webp')
);

-- 公開 bucket 的下載不需要 SELECT policy；這個 SELECT 只讓 Storage API 的
-- remove/delete_many 取得刪除權限，同時不開放 anon 列出整個 bucket。
create policy "note images anonymous cleanup select"
on storage.objects
for select to anon
using (
    bucket_id = 'note-images'
    and storage.allow_any_operation(array['storage.object.delete_many', 'storage.object.delete'])
);

create policy "note images anonymous delete"
on storage.objects
for delete to anon
using (
    bucket_id = 'note-images'
    and (storage.foldername(name))[1] = 'notes'
);

insert into schema_migrations (filename) values ('022_notes_images.sql')
on conflict (filename) do nothing;
