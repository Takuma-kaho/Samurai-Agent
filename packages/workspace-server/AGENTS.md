# Workspace Server

- 責務：PostgreSQL上のWorkspace、認可、RLS、Migration、履歴、復元を担当する。
- 参照：`ARCHITECTURE.md`と、Workspace・Room・API・Eventに関係する設計書を読む。
- 検証：typecheckとSchema testを行い、Migration・RLS・復元は実PostgreSQLでも確認する。
