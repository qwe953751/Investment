-- 族群人工編輯新增「改名」動作：把一個族群換一個顯示名稱。
-- 沒有新增欄位——改名的新名字借用既有的 aliases（第一個元素），跟
-- TopicTreeOverrides.json 那份靜態備援本來就沒有「新名字」欄位的形狀對齊，
-- 也不需要另外改讀取端（TopicEditStore.LoadAsync 本來就整批把 aliases 傳下去）。

alter table topic_edits drop constraint if exists topic_edits_action_check;

alter table topic_edits
    add constraint topic_edits_action_check
        check (action in ('移到', '移除', '別名', '加入', '退出', '改名'));

insert into schema_migrations (filename) values ('038_topic_edits_rename_action.sql')
on conflict (filename) do nothing;
