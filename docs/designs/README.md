# 個別設計書

ここには、機能領域ごとの現行設計を置く。正本は`PRODUCT.md`と`ARCHITECTURE.md`であり、個別設計書はその範囲を具体化する。

## 読み方

作業時は正本2つを確認し、今回の変更に関係する設計書だけを読む。

設計書は利用者の明示指示がある場合だけ作成・更新する。ここに名前があっても、ファイルが存在するとは限らない。

## 現在の設計書

現在の個別設計書はありません。作成した設計書はこの一覧へ追加します。

## 作成候補

- `organization.md`：Organizationとメンバー管理
- `workspace-room.md`：Workspace、Room、権限
- `client-api-events.md`：Client APIとEvent
- `runtime.md`：Agent実行と復旧
- `knowledge-learning.md`：Activity、Knowledge、Skill
- `native-app.md`：Native Appの体験と接続
- `external-connections.md`：外部アプリとGateway

作成時は`<domain>-<topic>.md`の形式で、現在の仕組みを示す安定した名前を付ける。

## 最小構成

1. 目的
2. 責務と対象範囲
3. データと処理の流れ
4. 外部との接続
5. 失敗時の扱いと検証
6. 未決定事項
