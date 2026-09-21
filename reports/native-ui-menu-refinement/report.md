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

## 2026-09-20 上部クローム実装の検証

対象は作業ツリー（ベースcommit `8cceb41`）の変更。既存の角丸メイン画面とWorkspace/Roomのデータ経路を維持し、次を追加した。

- Buzz型の上部クローム（サイドバー開閉、同一Workspace内の戻る／進む）を`NativeApp`へ接続。
- 依存追加なしのインラインSVGでサイドバー、戻る、進むアイコンを実装。
- macOS Electronではネイティブタイトルバーを隠し、traffic lightの位置を上部クロームに合わせる設定を追加。
- 同一WorkspaceのRoom／Agent一覧だけを履歴対象にし、Draft navigation guardを経由させた。

実行結果:

- `pnpm lint` — passed（format 1019、lint 900、issues 0）。
- `pnpm test` — passed（223 files passed、1 skipped、1715 tests passed、6 skipped）。
- `pnpm --filter @samurai-agent/web typecheck` — passed。
- `pnpm --filter @samurai-agent/desktop typecheck` — passed。
- `pnpm --filter @samurai-agent/web build` — passed。
- `pnpm --filter @samurai-agent/desktop build` — passed。
- `pnpm desktop:verify` — passed。
- `git diff --check` — passed。
- Browser rendererの`http://127.0.0.1:5173/`をCUAで確認。上部クローム高さ40px、borderなし、メイン面の角丸14px、サイドバー閉じるとメイン領域が全幅になること、SVGボタンのアクセシブル名とdisabled状態を確認した。

追加修正として、Buzzの`AppTopChrome`／`DrawerPanelIcon`とコード比較し、折りたたみSVGを24×22 viewBoxの外枠＋塗り矩形へ、矢印を24×24 viewBoxへ統一。矢印ボタン幅を24px、macOSナビ位置を左80px・下3px、両アイコンのCSS表示を16pxへ調整した。常駐Electron画面でも修正後の縮小されたアイコンを目視確認した。

未検証:

- Dockerがsandboxから`docker.sock`へ接続できず、検証用Self-host Serverを起動できなかったため、実Server保存、実データを使ったRoom／Agent履歴、常駐Electronの実ウィンドウ表示は未確認。
- 3テーマ、390px Browser renderer、IME入力、実Agent実行は未確認。静的型検査・build・Browser rendererの確認をElectronや実Serverの成功証拠とは扱わない。

## 2026-09-20 上部クロームのフルスクリーン配置修正

Buzzの上部クロームは、macOSの通常ウィンドウ時だけ信号ボタンを避け、フルスクリーンではその余白と縦補正を外す。Samuraiはこの状態分岐を持たず、常に通常ウィンドウ用の左80px・下3pxを適用していた。

- Electron Mainが`enter-full-screen`／`leave-full-screen`をrendererへ通知し、現在値を読む限定IPCを追加した。
- preloadはフルスクリーン状態の取得・購読だけを公開し、Workspaceや認可の契約は変更していない。
- `NativeTopChrome`は通常macOSだけ`is-mac-desktop`を付与する。通常時は左80px・下3px、フルスクリーン時は既定の左12px・縦補正なしになる。
- BuzzのTauriにあるtraffic lightの`y`値はElectronと同じ座標契約ではないため、Electron側のネイティブ位置は変更しなかった。

実行結果:

- `pnpm exec vitest run apps/web/src/native-app/NativeApp.test.ts apps/desktop/src/preload.test.ts` — passed（2 files、41 tests）。
- `pnpm --filter @samurai-agent/web run typecheck` — passed。
- `pnpm --filter @samurai-agent/desktop run typecheck` — passed。
- `pnpm --filter @samurai-agent/web run build` — passed（Viteの500KB超chunk警告のみ）。
- `pnpm --filter @samurai-agent/desktop run build` — passed。
- `pnpm lint` — passed（issues 0）。
- `pnpm desktop:verify` — passed。
- `git diff --check` — passed。
- ローカル検証用Self-host ServerとElectronを再起動後、CUAで通常ウィンドウの信号ボタンを避ける配置、macOSフルスクリーンで左12px・縦補正なしへ切り替わること、通常表示へ戻ることを確認した。

未検証:

- SamuraiにはBuzzのCommunity Rail相当がないため、BuzzのRailあり（左32px）分岐は実装していない。
- 3テーマ・狭幅・IME入力・実Agent実行はこの配置修正では再確認していない。

## 2026-09-20 ホバー時の白い枠線修正

対象は、Workspace選択、Agent、検索、通知、Workspaceポップオーバー項目などのホバー状態。ホバー時に`--native-accent`／`--native-line`を枠線へ適用していた指定を外し、背景色だけで状態を示すようにした。キーボード操作時の`focus-visible`リングは残し、選択状態や既存の操作経路は変更していない。

実行結果:

- `git diff --check` — passed。
- `pnpm lint` — passed（issues 0）。
- `pnpm test -- apps/web/src/native-app/use-native-sidebar-width.test.ts apps/web/src/components/RoomNavigator.test.tsx apps/web/src/components/RoomNavigator.focused.test.ts apps/web/src/native-app/NativeApp.test.ts` — passed（4 files、29 tests）。
- `pnpm --filter @samurai-agent/web run typecheck` — passed。
- `pnpm --filter @samurai-agent/web run build` — passed（Viteの500KB超chunk警告のみ）。
- ローカルElectron（`http://127.0.0.1:5187/`）でWorkspace選択を開き、トリガー周辺の白いホバー枠線が消えたことを目視確認した。

未検証:

- 3テーマ・狭幅・IME入力・実Agent実行はこのCSS修正では再確認していない。

## 2026-09-21 PR CI失敗の最小修正

PR #40の失敗は、実装変更後も残ったRoomNavigatorの旧DOM期待と、`use-native-workspace-navigation-history.ts`末尾の空行だった。

- 深いRoom階層は廃止済みの`--native-room-depth`ではなく、入れ子の`native-room-children`を確認するようテストを更新した。
- Room／Agent DMの表示は廃止済みの文字マーカーではなく、現行SVGアイコンのclassを確認するようテストを更新した。
- 末尾の余分な空行を削除した。

実行結果:

- `pnpm test -- apps/web/src/components/native-app-components.test.ts --pool=forks --maxWorkers=1` — passed（25 tests）。
- `git diff --check` — passed。
- `CI=true pnpm test -- --pool=forks --maxWorkers=4` — passed（227 files、1737 tests、6 skipped）。
- `CI=true pnpm run backend:release:verify -- --json` — passed（required gates）。

未検証:

- 今回はCI失敗を直すテスト・空白だけの変更であり、実Server、Electron、3テーマの画面操作は再実行していない。
