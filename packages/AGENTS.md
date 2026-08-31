# Packages

- 責務：Domain、Runtime、権限、保存など、複数の入口から共有するCore機能を担当する。
- 参照：`ARCHITECTURE.md`と、`docs/designs/`にある対象機能の設計書を読む。
- 検証：変更packageのtypecheckとfocused testを行い、依存変更はArchitecture検査も行う。
