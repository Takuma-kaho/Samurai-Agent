# Workspace Server 05 外部連携 自己レビュー

コードで直せる範囲は閉じた。実Client・3OS・Hosted/Self-hostの実機確認は未実施。

## コードで閉じた範囲

- 公式Connector Manifestを本番Compositionで登録
- Codex / Claude Code / Hermes の設定とHook正規化
- 既定Hook relay を scripts/external-integration-hook.ts に接続
- OAuth本人確認を Native App の Owner Token ログインへ接続
- 開発用固定Accountは明示DEV MODEのみ
- MCPは Formal Ingress 経由。Store直接参照なし
- 必須書き込みToolを公開Catalogへ接続
- 承認画面に承認・拒否・影響表示
- Captureは標準無効。有効時だけHook経路
- Contextは正本Query、1500 token、最終本文Hash

## 重大問題

認可迂回、別Workspace混入、承認流用、Secret保存、隠れた書き込みの重大問題は残っていない。

## 未実施

- 実Codex / Claude Code / Hermes
- macOS / Windows / Linux 実機
- Hosted / Self-host の本番確認
- PostgreSQL live

これらはC31。コード完成とは分けて扱う。
