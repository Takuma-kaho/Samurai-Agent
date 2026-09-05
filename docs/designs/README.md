# 個別設計書

ここには、機能領域ごとの設計を置く。正本は`PRODUCT.md`と`ARCHITECTURE.md`であり、個別設計書はその範囲を具体化する。

## 読み方

作業時は正本2つを確認し、今回の変更に関係する設計書だけを読む。

設計書は利用者の明示指示がある場合だけ作成・更新する。実装済みの説明と実装前の合意済み設計は、文書の状態欄で明確に区別する。ここに名前があっても、ファイルが存在するとは限らない。

## 現在の設計書

- [organization.md](organization.md)：任意のOrganization設計。Workspaceとの責務分離、Membership、招待、追加・解除、移行を扱う。
- [native-app.md](native-app.md)：Workspace-firstのNative App設計。既定Agentとの仕事、専門Agentの制御、コメント、Agent一覧・Room作成・DM、Electron、実機確認を扱う。
- [room-agent-work.md](room-agent-work.md)：RoomとAgentの共同作業設計。既定Agent、仕事と担当、依頼とコメントの区別、委譲・停止・指示変更、DMと共有を扱う。目標設計であり未実装部分を含む。
- [agent-backends.md](agent-backends.md)：Samurai Native / Codex / Claude Codeの接続設計。provider選択・認証、共通契約、文脈の分離、継続・停止・承認、実行先と復旧、検証担当を扱う。目標設計であり実Agentの完成確認は別途必要。

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
