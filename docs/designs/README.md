# 個別設計書

ここには、機能領域ごとの設計を置く。正本は`PRODUCT.md`と`ARCHITECTURE.md`であり、個別設計書はその範囲を具体化する。

## 読み方

作業時は正本2つを確認し、今回の変更に関係する設計書だけを読む。

設計書は利用者の明示指示がある場合だけ作成・更新する。実装済みの説明と実装前の合意済み設計は、文書の状態欄で明確に区別する。ここに名前があっても、ファイルが存在するとは限らない。

## 現在の設計書

- [organization.md](organization.md)：任意のOrganization設計。Workspaceとの責務分離、Membership、招待、追加・解除、移行を扱う。
- [native-app.md](native-app.md)：Workspace-firstのNative App設計。第11〜15章にナビ・検索・通知・共有の画面一覧と操作、本人設定の全画面、Room設定の右パネル、入力・保存・復帰の詳細を定義する。未実装部分を含む目標設計。
- [workspace-context.md](workspace-context.md)：今回のUI改善・記憶管理・共有の基本設計。Workspace／Room／Agentの責務、権限、通知範囲、独立コピーの意味、操作別権限、画面状態図、要件から確認条件までの対応を定義する。実装前。
- [workspace-context-data.md](workspace-context-data.md)：基本設計に対応するデータ設計。資源のAgent帰属、共有物・取り込み・通知のテーブル、制約、本文保存、廃止と復元を定義する。実装前。
- [workspace-context-api.md](workspace-context-api.md)：基本設計に対応するAPI・処理詳細設計。検索・通知・共有の入出力、認可、状態遷移、再送、停止競合、別Serverへの取り込みを定義する。実装前。
- [artifact-surface.md](artifact-surface.md)：成果物の表示・直接編集・Agent修正、版と出所、型付きの入力保存、実データのグラフ、承認要求との接続、生成HTMLの隔離を扱う。製品範囲は合意済み、詳細は実装前の設計案。
- [room-agent-work.md](room-agent-work.md)：RoomとAgentの共同作業設計。既定Agent、仕事と担当、依頼とコメントの区別、委譲・停止・指示変更、DMと共有を扱う。目標設計であり未実装部分を含む。
- [agent-backends.md](agent-backends.md)：Samurai Native / Codex / Claude Codeの接続設計。provider選択・認証、共通契約、文脈の分離、継続・停止・承認、実行先と復旧、検証担当を扱う。目標設計であり実Agentの完成確認は別途必要。
- [native-ui-migration.md](native-ui-migration.md)：試作品コードを骨格にしたNative AppのChat-first UI、3テーマ、実Workspace/Room/Agent導線、同一RoomのWork会話投影、成果物パネル、保留範囲を扱う。2026-09-16時点の現行実装を記録する。

## 作成候補

- `workspace-room.md`：Workspace、Room、権限
- `client-api-events.md`：Client APIとEvent
- `runtime.md`：Agent実行と復旧
- `knowledge-learning.md`：Activity、Knowledge、Skill
- `external-connections.md`：外部アプリとGateway

作成時は`<domain>-<topic>.md`の形式で、現在の仕組みを示す安定した名前を付ける。

## 最小構成

1. 目的
2. 責務と対象範囲
3. データと処理の流れ
4. 外部との接続
5. 失敗時の扱いと検証
6. 未決定事項
