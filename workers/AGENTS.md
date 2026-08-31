# Workers

- 責務：学習や最適化などの非同期処理を、再実行できるJobとして担当する。
- 参照：`ARCHITECTURE.md`と、対象Job・Knowledge・Runtimeの設計書を読む。
- 検証：focused testに加え、重複実行・中断・再開・失敗時の状態を確認する。
