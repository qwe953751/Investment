-- 收掉 db/011_turnover_audit.sql 建的兩張對照表。**這是它自己寫在檔頭的收尾步驟。**
--
-- 那兩張表是為了驗證「把盤中成交金額的來源換成玩股網」而收的每輪比對紀錄。
-- 驗證沒收成：玩股網擋 GitHub runner 的機房 IP，整場 403。六個交易日只留下一列，
-- 而且是 2026-08-21 從本機手動跑出來的（GitHub 上跑的那些全部 403）：
--
--   matched 1971／missing 1／compared 1956，我們合計 8,669.7 億 vs 對方 8,687.4 億，
--   逐檔誤差中位數 0.5132%、p90 2.0462%、最大 25%。
--
-- 那個 0.51% 跟後來 2026-08-28 用官方收盤值重算的 0.509% 對得上，可以互相佐證，
-- 所以這兩張表的資訊價值到此為止，數字留在這段註解裡就夠了。
-- 2026-08-29 改走不依賴外部網站的路——每一輪只把新增的量用當時的價計價再累加
-- （Infrastructure/MarketData/Intraday/IntradayTurnoverAccumulator.cs），
-- 誤差中位數從 0.509% 降到 0.155%。往後要驗準確度，比對對象是盤後官方收盤成交值，
-- 每天晚上免費拿得到，不需要任何對照表。
--
-- 表刪掉、011 的紀錄也要一起刪掉：db/ 底下已經沒有 011_turnover_audit.sql 這個檔了，
-- 留著紀錄不會有事（SchemaMigrations 只挑「有檔沒紀錄」的），但那筆紀錄會讓下次
-- 重建資料庫的人以為有一支 migration 找不到檔案。

drop table if exists turnover_audit_outliers;
drop table if exists turnover_audit_rounds;

delete from schema_migrations where filename = '011_turnover_audit.sql';

insert into schema_migrations (filename) values ('024_drop_turnover_audit.sql')
on conflict (filename) do nothing;
