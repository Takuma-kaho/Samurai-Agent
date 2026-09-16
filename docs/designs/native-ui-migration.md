# Native UI移行

## 状態と目的

2026-09-16時点の実装説明である。Samurai Native Appを、試作品のOpenClaw型Chat-first UIを土台にして、既存のWorkspace、Room、Agent、Work、成果物へ接続する。

今回の目的は、既存の管理画面をChatに並べることではない。試作品の情報密度と導線を先に固定し、既存の処理を意味を変えずに接続できる範囲だけを表示することである。実行・認可・保存の責務は引き続きWorkspace CoreとRuntimeにある。

### 視覚上の基準

試作品の次の実装を視覚骨格の参照元とした。

- /Users/kahotakuma/Developer/Samurai-UI-Prototypes-20260911/reports/ui-design-prototypes/prototype/dist/app.js
- /Users/kahotakuma/Developer/Samurai-UI-Prototypes-20260911/reports/ui-design-prototypes/prototype/dist/styles.css
- /Users/kahotakuma/Developer/Samurai-UI-Prototypes-20260911/reports/ui-design-prototypes/prototype/dist/openclaw-chat.css

合意後の利用者指示に従い、現在の外枠は「外側のテーマ背景、透明Sidebar、内側の角丸Chatウィンドウ」で構成する。計画P1にある全面Shellという古い表現より、この試作品コードと最新指示を優先する。これは機能範囲を広げず、画面骨格だけを試作品へ再同期した扱いである。

## 画面構成

### 共通Shell

NativeAppは次の順で画面を組み立てる。

1. 外側のテーマ背景
2. 実Workspaceと実Roomを表示するSidebar
3. 角丸のメインChatウィンドウ
4. 開いている場合だけ表示する成果物パネル

SidebarはRoomとDMを別の一覧として表示し、Roomの階層は実データから描画する。狭幅ではSidebarをDrawerにし、閉じている間はキーボード操作対象から外す。成果物はChatを置換せず、メインウィンドウ内のパネルとして開き、狭幅では「仕事へ戻る」でChatへ戻る。

関連実装: [NativeApp.tsx](../../apps/web/src/native-app/NativeApp.tsx)、[RoomNavigator.tsx](../../apps/web/src/components/RoomNavigator.tsx)、[app.css](../../apps/web/src/styles/app.css)。

### 3テーマと本人メニュー

左下の本人メニューだけがテーマの入口である。許可値はCのダーク、Bのライト、Aの特別版の3つに限定し、この端末のClient設定として保存する。不正・欠落した値はCへ正規化する。テーマ変更はReact subtreeを作り直さないため、入力、返信対象、実行、成果物editorの状態を維持する。

Aの星は操作を遮らない装飾であり、機能やデータを示すものではない。試作品上部のA/B/C比較バーは本体へ移さない。

関連実装: [NativeProfileMenu.tsx](../../apps/web/src/native-app/NativeProfileMenu.tsx)、[native-app-theme-preferences.ts](../../apps/web/src/lib/native-app-theme-preferences.ts)、[app.css](../../apps/web/src/styles/app.css)。

## 実データへの接続

主要経路は次のとおりである。

NativeApp → useNativeApp → Browser bridge または Electron preload → 公開API → Workspace Core / Runtime

Clientは表示と利用者操作だけを担う。Room、Work、成果物の対象識別、認可、版・世代・操作IDの検証は既存の公開APIとCoreの契約を利用する。今回、DB schema、認可規則、Runtime、Agent実行契約を新設していない。

### Roomと会話

RoomWorkSurfaceは、同じRoomの実Workに含まれるInstruction、Assignment、添付参照を時刻と版で会話へ投影する。Room一覧を取得した後、useNativeAppは既存のroom.work.viewで同じRoomの各Work詳細を取得し、古いRoomや古い一覧への遅延応答は捨てる。これにより、選択中のWorkだけでなく、同じRoomに残る初期依頼、追加指示、実行結果をreload後も読める。

返信は該当Workへの追加Instructionとして送る。返信解除後の送信は新規Workである。添付は既存アップロードでResourceRefを得たものだけを送信対象にする。

関連実装: [RoomWorkSurface.tsx](../../apps/web/src/native-app/RoomWorkSurface.tsx)、[use-native-app.ts](../../apps/web/src/native-app/use-native-app.ts)、[workspace-browser-bridge.ts](../../apps/web/src/lib/workspace-browser-bridge.ts)。

### Agent、DM、Room作成

通常画面のAgent導線は、既存Agentの一覧、プロフィール、既存DM、既存Agentを選ぶRoom作成だけに絞る。Agent作成・編集、Room設定、既定Agent変更、権限操作は、この移行UIには表示しない。DMは共有Roomと区別して表示する。

関連実装: [NativeApp.tsx](../../apps/web/src/native-app/NativeApp.tsx)、[RoomNavigator.tsx](../../apps/web/src/components/RoomNavigator.tsx)。

### 成果物パネル

ヘッダーと実行結果カードから、認可されたRoomの成果物を開く。今回の表示対象は既存の文書成果物で、閲覧、編集、保存、取消、版履歴、比較、Download、Agentへの修正依頼を既存契約へ接続する。選択したresource、revision、Roomを照合し、未保存editorの保護も既存の仕組みを使う。

一覧と詳細は狭い右パネルで縦積みに切り替わる。通常一覧の重複見出し、Generated Surfaceの仮一覧、説明だけの管理画面は置かない。

関連実装: [NativeArtifactWorkspace.tsx](../../apps/web/src/native-app/NativeArtifactWorkspace.tsx)、[ArtifactSurfacePanel.tsx](../../apps/web/src/native-app/ArtifactSurfacePanel.tsx)。

## 状態保護

| 条件 | 現在の扱い |
| --- | --- |
| テーマ変更 | 許可テーマだけを保存し、入力・返信対象・実行・editorを再作成しない。 |
| Room / Workspaceの切替 | connection、Workspace、Room、一覧世代を照合し、古い非同期応答を現在画面へ混ぜない。 |
| 同一Roomの複数Work | 既存詳細を対象ごとに取得してマージし、重複を除いて時系列表示する。 |
| 権限不足 | 実行・編集を無効にする。UIで権限を補ったり、別Roomの成果物を表示したりしない。 |
| 成果物の保存 | resourceとrevisionを照合し、保存中、保存失敗、版競合、未保存下書きを区別する。 |
| 試作品にだけある操作 | @メンション、投稿コメント、Room全体停止などを意味の異なる既存操作へ変換しない。 |

## 試作品との対応表

この表の「本体」は今回確認したNative Appの画面・接続範囲を指す。バックエンド全体を監査した結論ではない。

| 機能 / 画面 | 試作品 | 本体の既存接続 | 新UIへの反映状況 | 今回の扱い | コード / 証拠 |
| --- | --- | --- | --- | --- | --- |
| 外側背景、透明Sidebar、角丸Chatウィンドウ | あり | NativeAppとCSS | 反映済み | 最新の試作品骨格に合わせた | [NativeApp.tsx](../../apps/web/src/native-app/NativeApp.tsx)、[app.css](../../apps/web/src/styles/app.css) |
| C / B / Aテーマと本人メニュー | あり | 端末内theme preference | 反映済み | 比較バーは移さず、本人メニューに限定 | [NativeProfileMenu.tsx](../../apps/web/src/native-app/NativeProfileMenu.tsx) |
| Workspace、Room、DMの移動 | あり | 既存queryとselect / open操作 | 反映済み | 実データだけを表示 | [RoomNavigator.tsx](../../apps/web/src/components/RoomNavigator.tsx) |
| 既存AgentによるRoom作成、Agent閲覧、DM | あり | 既存Room create、Agent / DM操作 | 反映済み | 管理操作は表示しない | [NativeApp.tsx](../../apps/web/src/native-app/NativeApp.tsx) |
| Roomの依頼、返信、実行結果、添付 | あり | sendRoomWork、Room Work view、upload | 反映済み | 同じRoomの複数Work履歴を会話へ表示 | [RoomWorkSurface.tsx](../../apps/web/src/native-app/RoomWorkSurface.tsx)、[use-native-app.ts](../../apps/web/src/native-app/use-native-app.ts) |
| 文書成果物の右パネル | あり | Artifact query / save / revision | 反映済み | 実文書だけを一覧・詳細・履歴へ接続 | [NativeArtifactWorkspace.tsx](../../apps/web/src/native-app/NativeArtifactWorkspace.tsx)、[ArtifactSurfacePanel.tsx](../../apps/web/src/native-app/ArtifactSurfacePanel.tsx) |
| 上部のA/B/C比較バー、通知、架空の参加者 | あり | 対応する実接続を今回確認していない | 試作品にあるが本体にない | ダミーや比較用の導線を移さない | 試作品コード、計画P1 / P2 |
| @メンション、投稿単位コメント、Room全体停止 | あり | 本体にはWork単位の近い概念がある | 両方にあるが意味が異なる / 今回保留 | 保存先・対象・権限が変わるため接続しない | [RoomWorkSurface.tsx](../../apps/web/src/native-app/RoomWorkSurface.tsx) |
| Knowledge、Collection、招待、Room権限、Agent編集など | 今回の試作品にはない | 本体には既存のAPI / 画面がある | 本体にあるが試作品にない | APIや保存データを削除せず、通常導線へ追加しない | [NativeApp.tsx](../../apps/web/src/native-app/NativeApp.tsx) |
| Memory専用画面 | 今回の試作品にはない | 今回の移行範囲に専用画面はない | どちらにもない | UI移行に追加しない | [PRODUCT.md](../../PRODUCT.md)、[ARCHITECTURE.md](../../ARCHITECTURE.md) |
| 本体全体の未読API、管理API、学習機能の網羅判定 | 未調査 | 未調査 | 未調査・判断不能 | このUI移行を全機能監査へ広げない | [計画](../../plans/native-openclaw-ui-migration-plan.md) P6 |

## 検証と未決定事項

実行したE2E、静的検査、隔離Electron確認、現在の限定範囲は[検証記録](../../reports/native-openclaw-ui-verification/report.md)に分離する。設計書は現在の構造を説明し、過去のログを完成証拠として複製しない。

今回の移行で保留する設計判断は次のとおりである。

- 投稿単位コメント、/comment、@メンション、Room全体停止をWork単位の契約とどう区別するか。
- Knowledge、Collection、確認待ち、Room管理をChat-first画面から必要時に開く正式な導線。
- 未送信下書きをreload後にも永続化するか。今回の完了条件には追加していない。
