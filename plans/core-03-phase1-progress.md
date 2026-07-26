# Core03 Phase1 進捗・検証Evidence

更新日: 2026-07-26

## 判定

5つの問題は、コード上で修正済み。実装者による差分全体のセルフレビューと、担当Moduleのfocused test・typecheckを完了した。

| 問題 | 判定 | 根拠 |
| --- | --- | --- |
| 再開入力にToken・本文が保存される | 修正済み | `RunControl`は`submitted_at`と`has_input`だけをJournalへ記録し、本文・TokenをmetadataやEventへ保存しない。 |
| `sessionPolicy`・`execution_owner`が飾り | 修正済み | Registryが宣言と実装を検証し、`TurnExecutor`はSession方針と`host`所有Toolだけを実行判断に使う。失敗後は`degraded`として受付を止める。 |
| Eventが自由なデータ箱 | 修正済み | Event種類ごとのdiscriminated unionを追加し、新規Journal・Store保存時にSchemaを通す。既存履歴は読み取り互換を維持する。 |
| Codexが空回答でも成功する | 修正済み | JSONL本文を優先し、本文がない場合だけ公式`--output-last-message`を`text_delta`へ変換する。unknown JSON・stderr・raw stdoutは回答にしない。 |
| Tool Bridgeが専用台帳・Token保存を持つ | 修正済み | 専用Serviceへ移し、Tokenはprocess内だけで保持。書き込みは既存Domain Commandの冪等性を使い、EventはHostの記録入口からJournalへ流す。 |

## 実行経路

- 初回実行・再開・同期・復旧は、すべて1つの`TurnExecutor`から同じBackend Event Journalへ到達する。
- Session IDは初回保存・同一ID維持・異なるIDの`backend_session_conflict`停止を共通処理する。
- native resumeにSession IDがない場合はBackendを呼ばず、既存Settlementで失敗確定する。
- 同期・復旧ではHost所有Toolを再実行しない。

## 過剰実装を避けた範囲

- 新しい承認、Sandbox、再接続基盤、専用監査Frameworkは追加していない。
- migration version 6は新設せず、既存ローカルDBの旧表も破壊していない。
- 読み取りToolの専用結果キャッシュや、Backend Eventの再生用メモリ台帳は追加していない。

## 最終ローカル確認

- `core-schemas` focused test: 29 tests passed
- `workspace-store` focused test: 1 test passed
- `agent-backends` focused test: 43 tests passed
- `runtime` RunControl focused test: 14 tests passed
- `runtime` Bridge・streaming integration spot: 2 tests passed
- 対象4パッケージのtypecheck: すべてexit code 0
- `git diff --check`: exit code 0
- 全テスト、全build、外部CLI probe、PR CI待機: Phase1対象外
- package-wide `runtime.test.ts`には、Core03外のdetached Background Review 2件のtimeoutが残るため、Phase1完了根拠には使っていない。
