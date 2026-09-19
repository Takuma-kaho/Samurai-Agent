# Native UI・メニュー改善の実装・検証

実施開始: 2026-09-19。開始commit: `6888502`。状態: 実装・検証中。

対象: [実装計画](../../plans/native-ui-menu-refinement-plan.md)R1〜R15。利用者から実装、サブエージェント分担、実画面撮影と目視評価を明示依頼された。branch作成・commit・push・設計書変更は対象外。

実装中の利用者回答: デザイン修正を優先し、右クリック新操作はUIのみ（機能接続は後続）。同名Workspaceも名前だけ表示。Knowledge・学習の既存中央画面への入口は実装する。この範囲変更を今回の完成条件へ適用する。

## 採用したデザイン指針

2026-09-19に[awesome-design-skills](https://github.com/bergside/awesome-design-skills)、[Codex SKILL.md](https://github.com/bergside/awesome-design-skills/blob/main/skills/codex/SKILL.md)、[DESIGN.md](https://github.com/bergside/awesome-design-skills/blob/main/skills/codex/DESIGN.md)を確認。導入済み`/Users/kahotakuma/.codex/skills/codex/SKILL.md`も読んだ。意味別の配色、文字階層、4px基準の余白、明示的な操作状態、控えめな装飾を採用する。3テーマと既存日本語フォントを優先し、OpenAI公式UI仕様とは扱わない。

## 変更前の目視

実行中macOS Electron `Samurai Agent`（renderer `http://127.0.0.1:5187/`）をCUAで撮影。左上ロゴ、Workspaceラベル、横並び検索・通知、ヘッダーとbannerと入力欄で重複する未設定案内、文字記号の添付・パネル操作を確認した。添付Codex／Buzzでは細い文字、小さな線画アイコン、控えめな区切りが会話の読みやすさを支えている。コピーすべき操作仕様としては扱わない。

## 作業分担

`.codex/agents/`のreaderで検証経路を調査。coderをShell／Roomメニュー・参加者／会話・入力欄／共通style・設定の4責務に分ける。統合後にreviewerとcompletion_judgeで独立確認する。

## 検証状況

静的検査、focused test、実Server保存、実Client状態保持、3テーマ・幅別の画面比較は実施後に追記する。過去の検証を今回の成功証拠に流用しない。
