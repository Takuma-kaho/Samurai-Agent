# 個別設計書

ここには、機能領域ごとの現行設計を置く。正本は`PRODUCT.md`と`ARCHITECTURE.md`であり、個別設計書はその範囲を具体化する。

## 読み方

作業時は正本2つを確認し、今回の変更に関係する設計書だけを読む。

## 分類

- `organization.md`：Organizationとメンバー管理
- `workspace-room.md`：Workspace、Room、権限
- `client-api-events.md`：Client APIとEvent
- `runtime.md`：Agent実行と復旧
- `knowledge-learning.md`：Activity、Knowledge、Skill
- `native-app.md`：Native Appの体験と接続
- `external-connections.md`：外部アプリとGateway

設計書は必要になった時点で作成し、現行設計だけを残す。

## 最小構成

1. 目的
2. 責務と対象範囲
3. データと処理の流れ
4. 外部との接続
5. 失敗時の扱いと検証
6. 未決定事項
