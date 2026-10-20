-- 僅供本次將兩張公開筆記圖片複製至私有 bucket；路徑為一次性隨機名稱。
-- 緊接著由 db/069_private_note_image_import_cleanup.sql 撤銷此 anon INSERT policy。
create policy "private note image one-time import"
    on storage.objects
    for insert
    to anon
    with check (
        bucket_id = 'private-note-images'
        and name in (
            'private/44675e96-d6f1-449b-b3f7-8e84f95d7ab2/76f8bc70-e6df-4c81-b833-4e4c0598cf17.png',
            'private/44675e96-d6f1-449b-b3f7-8e84f95d7ab2/6891754c-e741-40f5-a922-b69e645834ea.png'
        )
    );

insert into public.schema_migrations (filename) values ('068_private_note_image_import.sql')
on conflict (filename) do nothing;
