# Native OpenClaw UI 検証環境確認

## 対象

- 実施日: 2026-09-14
- ブランチ: `codex/native-openclaw-ui`
- 確認時のコミット: `cd020837f0ab58c6d5140b44ebe10f753d67dd88`
- コード変更: なし
- Docker: 既存のE2E環境には触れず未使用
- データ保存先: repo外の一時ディレクトリ `/private/tmp/samurai-native-openclaw-ui-20260914`

## 起動条件

- PostgreSQL: `127.0.0.1:55432/samurai_ui_verify`
- Workspace Server: `http://127.0.0.1:4320`
- Web: `http://127.0.0.1:5174`
- Workspace Serverは`self_host`、DB接続は`ok`、RLS必須設定で起動
- Gemini Provider（`gemini/gemini-3.5-flash`）を検証用Serverプロセスにだけ設定した。APIキーの値は保存・表示していない

## 実施内容と結果

1. 一時PostgreSQLへマイグレーションを適用した。`{"ok":true,"action":"migrate"}`。
2. `GET http://127.0.0.1:4320/api/health`を実行し、`ok: true`、`storage: postgresql`、`db.ok: true`を確認した。
3. 検証用Accountを登録した。
4. `workspace_native_openclaw_verify`（表示名: `OpenClaw UI検証`）を作成した。
5. 作成時の既定Room `room_b30f5f6324002cbe0cf7810e88ee708e1d547e78`（`General`）を確認した。
6. クリーンなBrowser origin（`http://localhost:5174`）から検証用接続を設定した。
7. 本体画面を表示し、Workspace `OpenClaw UI検証`、Room `General`、接続状態`接続済み`を確認した。
8. 検証用ワーカーAccountを登録してCompletion maintenance identityへ設定し、Serverのワーカーが`running`になることを確認した。
9. `Gemini検証Agent`（Backend: `Samurai Native`）を作成し、`General`へ追加して既定Agentに設定した。
10. `検証です。日本語で一言返してください。`を送信し、Room Workが`completed`／UIが`完了確認済み`になることを確認した。Runtimeの応答は`はい、承りました。検証用のチャットですね。`。
11. ブラウザのエラー／警告ログは空配列、エラーオーバーレイなし、主要な操作要素の描画を確認した。

## 未検証範囲

- Organization、招待、Realtime、成果物、Knowledgeなどの各導線は未検証。
- `agent-browser` CLIが利用できなかったため、同等のCUAブラウザ操作で確認した。
