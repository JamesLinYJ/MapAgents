-- +-------------------------------------------------------------------------
--
--   地理智能平台 - 开发库平台数据重置脚本
--
--   文件:       reset_platform_data.sql
--
--   日期:       2026年05月21日
--   作者:       JamesLinYJ
--   协助:       OpenAI Codex:GPT-5.5
-- --------------------------------------------------------------------------
--
-- 显式清空平台运行数据。API 启动不会自动执行本脚本。
-- PostgreSQL 是结构化平台事实源；运行时对象与诊断载荷由
-- npm run reset:conversations 在同一次显式重置中清理。

DROP TABLE IF EXISTS platform_context_entries CASCADE;
DROP TABLE IF EXISTS platform_thread_context CASCADE;
TRUNCATE TABLE platform_artifacts;
TRUNCATE TABLE platform_meteorological_datasets;
TRUNCATE TABLE platform_meteorological_jobs;
DROP TABLE IF EXISTS platform_events CASCADE;
DROP TABLE IF EXISTS platform_runs CASCADE;
DROP TABLE IF EXISTS platform_threads CASCADE;
DROP TABLE IF EXISTS platform_sessions CASCADE;
