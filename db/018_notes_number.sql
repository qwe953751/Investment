-- 筆記清單的永久編號。
--
-- 編號由資料庫 sequence 配發，不由瀏覽器排序或計算；刪除後不回收，
-- 多裝置同時新增也不會拿到相同編號。既有筆記依目前可用的時間欄位
-- （updated_at）補號，之後只由 sequence 往後累加。

alter table notes
    add column if not exists note_number bigint;

create sequence if not exists notes_note_number_seq;

alter sequence notes_note_number_seq owned by notes.note_number;

alter table notes
    alter column note_number set default nextval('notes_note_number_seq'::regclass);

with numbered as (
    select
        id,
        row_number() over (order by updated_at asc, id asc)
            + coalesce((select max(note_number) from notes), 0) as next_number
    from notes
    where note_number is null
)
update notes
set note_number = numbered.next_number
from numbered
where notes.id = numbered.id;

select setval(
    'notes_note_number_seq'::regclass,
    greatest(coalesce((select max(note_number) from notes), 0), 1),
    exists (select 1 from notes where note_number is not null)
);

alter table notes
    alter column note_number set not null;

create unique index if not exists notes_note_number_unique
    on notes (note_number);

insert into schema_migrations (filename) values ('018_notes_number.sql')
on conflict (filename) do nothing;
