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
- Web: `http://localhost:5174`
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

---

## 今回のNative UI移行検証（2026-09-15）

### 対象と差分

- ブランチ: `codex/native-openclaw-ui`
- 計画作成時の基準HEAD: `cd020837f0ab58c6d5140b44ebe10f753d67dd88`
- 検証時のHEAD: `59b3b69e445e8b9e0dd3857406ecfae7f0c01c6f`
- 作業差分: tracked 17ファイル変更、未追跡5ファイル（この設計書と実装4ファイル）。行数は検証時の`git diff --stat`で確認した。
- 主な実装: `NativeApp`、`app.css`、`NativeProfileMenu`、テーマ設定、`RoomNavigator`、`RoomWorkSurface`、`use-native-app`、Workspace bridge、Artifact panel。
- 本番DB、通常利用のDesktop profile、秘密の既存identityファイルは対象にしていない。
- 過去の2026-09-14環境確認結果は、この新UIの完成証拠として再利用していない。

### 今回の検証環境

- データ・profile: `/private/tmp/samurai-native-openclaw-ui-20260914`
- PostgreSQL: `127.0.0.1:55432/samurai_ui_verify`
- Workspace Server: `http://127.0.0.1:4320`
- Web origin: `http://127.0.0.1:5174/`
- Browser確認: CUA。`agent-browser`の成功記録ではない。
- `127.0.0.1`による先行基礎確認では実接続用credentialを利用できず、実Workspace/Room/Agent/Gemini/文書E2Eは未実施だった。その後、`localhost`経路で隔離DBの実接続を確認した。

### 実行済みの静的検査・focused test

| 実行コマンドまたは操作 | 結果 | 確認したこと |
| --- | --- | --- |
| `pnpm exec vitest run`（変更関連focused 10ファイル） | pass、184 tests | テーマ、Room Work投影、target/generation保護、成果物scope、bridge正規化、既存Native状態 |
| `pnpm --filter @samurai-agent/web run typecheck` | pass | Web TypeScriptの型整合性 |
| `pnpm lint` | pass（`format_checked 954`、`lint_checked 835`） | source quality / lint |
| `pnpm --filter @samurai-agent/web run build` | pass | 本番Web bundle。JS `1,160.55 kB`のchunk size warningのみ |
| `pnpm desktop:build` | pass | Desktop buildとartifact verification |
| `git diff --check` | pass | 差分の空白エラーなし |
| 隔離Server + PostgreSQL health確認 | pass | 実装環境のhealth。通常DB・Docker環境は変更していない |

### 実施したCUA UI確認

- 実施URL: `http://127.0.0.1:5174/`
- 初期テーマがC（ダーク）で表示されることを確認。
- 本人メニューからB（ライト）、A（特別版）、C（ダーク）を選択できることを確認。
- Aを選択後にreloadし、Aが復元されることを確認。
- 本人メニューをEscapeで閉じ、トリガーへフォーカスが戻ることを確認。
- 390px幅でSidebar drawerを開き、背景クリックで閉じることを確認。
- 1024px幅でShellの`scrollWidth=clientWidth=1024`を確認。
- desktop幅でmobile toggleが非表示であることを確認。

これらは`127.0.0.1`による先行基礎UI確認（テーマ、drawer、Shell寸法）であり、実Workspace・実Room・実Agent・実Gemini・実文書を使ったE2Eの代替ではない。後段の`localhost`経路で隔離DBの実接続を別途確認した。

### 未実施・未完了の確認

この先行基礎確認の時点では実接続用credentialがなく、以下は未実施であった。focused testや静的Markupの成功で実E2E済みとは扱わない。後述の追加実接続CUAとは記録を分ける。

- E2: 入力中、引用返信中、文書編集中、Agent実行中のテーマ変更後も状態が保持されること。
- E3: 実Workspace切替、Room選択・作成、Agent閲覧、Agent DM。
- E4: Geminiへの実送信、Work/Assignment/Runの照合、非空の実返答本文の表示、reload後の履歴。
- E5: 同じWorkへの返信、新規Workとの分離、履歴の重複防止。
- E6: 実ファイル添付、アップロード失敗、送信失敗時の入力保持。
- E7〜E8: Room切替中の遅延応答、切断・復旧・再読み込み。
- E9〜E11: 実成果物の表示、保存、再取得、履歴、ダウンロード、修正依頼、未保存・版競合。
- E12: 閲覧専用・実行不可の実Account/Roomでの操作境界。
- E13: 3テーマ、長文、日本語入力、右パネルを含む完全な通常幅・1024px・390px操作。
- E14: 隔離profileを使ったmacOS Electron実Client。

### 2026-09-15実接続E2E追加確認

先行の`http://127.0.0.1:5174/`による基礎CUA記録は置換せずに残し、以下は別に実施した実接続確認である。

- 条件: workspace-server `4320`、Vite `5174`、CUA、隔離DBと既存検証データ。
- 実施URL: `http://localhost:5174/`。
- Cを初期表示し、B/A/C切替とAのreload後の保持を確認した。現行実データに保存された過去Gemini返答も表示された。
- 同じWorkへの返信状態と下書きがBテーマへの切替後も保持されることを確認し、送信せずに返信状態を解除して下書きを消去した。
- Agent一覧/DMで既存Agentの役割、Backend、利用可否、DM、プロフィール表示を確認した。
- 隔離DB内の既存AgentのDMを開き、`PRIVATE AGENT DM`と「あなたとこのAgentだけが参加できます。」を確認してから`General`へ戻った。
- Room作成ダイアログは既存Agent選択だけで、新規Agent同時作成・Room権限入力がないことを確認し、作成せず閉じた。
- 1024x768と390x844でShellの`clientWidth === scrollWidth`を確認し、390pxでナビゲーションの開閉を確認した。

判定範囲:

- E2/E3/E13: 上記のテーマ、下書き・返信状態、既存Agent/DM/プロフィール、Room作成導線、Shell寸法の部分実施。
- E4/E5: 新規Gemini送信・新規返信は未実施。過去のGemini本文が現行UIに表示されreload後も可視であることのみ確認した。
- E6〜E12、E14: 未実施。

### 試作品比較の制限

P0で試作品READMEは確認できたが、計画に記載された`dist/app.js`、`dist/openclaw-chat.js`、`dist/openclaw-chat.css`は確認時に存在しなかった。そのため、今回のCUA確認は本体の要件・実装に対する確認であり、試作品の正確なDOM・画像・視覚差分の証拠ではない。試作品の再取得と比較は未調査として残す。

### 判定

静的検査、focused test、Web/Desktop build、隔離Server/PostgreSQL health、先行基礎CUA、追加実接続CUAは成功した。追加実接続CUAでE2/E3/E13の一部を確認したが、新規送信・返信を含むE4/E5、E6〜E12、E14は未実施であり、今回の記録だけでNative UI移行全体のE2E完了とは判定しない。

### P5独立読み取りレビュー

独立した読み取りレビューでは、read-only Agentプロフィールの欠落、通常Room作成画面への新Agent作成・権限UIの露出、Workspace切替後の古いプロフィール残留をmust-fixとして検出した。各項目を修正し、最終再レビューでmust-fixなしを確認した。これは静的な実装レビューの結果であり、実接続E2E未完了の結論は変更しない。

---

## 2026-09-15実接続E2E追加確認（後続）

上記の先行記録を置換せず、`workspace-server:4320`、Vite `5174`、CUA、隔離DB・既存検証データを使い、`http://localhost:5174/`で追加確認した。`127.0.0.1`の先行基礎UI確認とは分離して記録する。

### E4: 実送信・実返答・Work照合

- `General`からGeminiへ`UI E2E確認です。日本語で一言返してください。`を送信し、非空の実応答`はい、検証用の対話を継続します。何か確認したいことはありますか？`を確認した。
- 同一Work（`room_work_acf717...`）へ`同じWorkへの追加指示です。短く「追記を受け取りました」と返してください。`を送り、`追記を受け取りました。`を確認した。
- 別新規Workは初回に`provider 503 temporary_unavailable`となり、再試行は完了した。DB照合で同一Workのassignment/run、失敗Work（`room_work_92f...`、`provider_failed`）、再試行Work（`room_work_dde...`、`completed`、`run_b93...`）を確認した。

### E5: 返信・独立Work・reload

- 返信解除、独立Work作成、新規Workと返信の分離、reload後の履歴に重複がないことを確認した。

### E6: 添付・送信失敗

- `/private/tmp/samurai-native-openclaw-ui-20260914/e2e-attachment.txt`をUIから添付し、ResourceRef `attachments/6104caf3-4fc5-475e-b894-77ab2129865d-e2e-attachment.txt v 1`を確認した。
- 意図的にServerを停止して送信を失敗させ、入力`送信失敗時の下書き保持確認です。`と失敗表示を確認した。reload後の永続下書きまでは未確認である。

### E7〜E8: Room/DM切替・切断復旧

- General実行中にDMへ切り替え、DM下書き`DM下書き保持確認です。送信しません。`が保持され、Generalの応答がDMへ混入しないことを確認した。
- 送信後に意図的にServerを停止し、切断表示、復旧/reload、GeneralのWork数7と履歴復元、重複なしを確認した。実行中Workは意図的切断によりfailedとなった。完全な再開ではなく部分確認である。

### E9〜E11: 成果物・保存・競合

- Gemini生成Artifact `Native UI E2E Artifact`とDM Artifact `DM UI E2E Document`を右パネルで表示し、close/reopenした。Agent修正依頼は既存返信下書きへの追加後に明示送信した。Geminiは別Artifact `Native UI E2E Artifact (v2)`を作成しており、元Artifactのrev2証拠ではない。
- E2Eで`canEdit`投影欠落とArtifact operation ID契約不整合を発見し修正した。DM Documentを直接`v1\nv2: direct save verification`へ保存してrevision 2とし、再取得、版履歴、比較画面で本文を確認した。ファイルも隔離storageのrevision 2/blobに存在した。DownloadはUIクリックでエラーなしだったが、in-app browserがdownload eventを提供せず、実ファイル取得のE2E証跡は限定的である。
- revision 1を結果カードから開き、未保存draftでパネルを閉じた際の「成果物の未保存下書きがあります」と、キャンセル後の値保持を確認した。古いrevision 1から`v1\nv3: stale conflict verification`を保存し、`artifact_revision_conflict:409`、draft保持、revision 2比較表示を確認した。

### E1〜E3、E12〜E14の範囲

- E1/E2/E3は、C/B/A選択・復元、返信下書きのテーマ保持、既存Agent/DM/Room導線を実接続で部分確認した。E2の文書編集中・実行中のテーマ変更、E3の実Room作成は未実施である。
- E12は専用の別Account/read-only実権限fixtureを使った確認を実施しておらず、focused UI/Coreテストのみで未完了である。
- E13は1024x768/390x844の横溢れなし、390pxナビ、長い日本語入力のC/B/A変更後保持、profile Escapeを確認した。390pxの右パネル操作は未実施で部分確認である。
- E14はDesktop buildのみで、隔離profileの実Electron送受信・Document確認はidentity秘密情報を読まない方針のため未実施である。

### 追加修正と検証

- Roomの`canEdit`をPostgreSQL Store→Domain API→bridge/Native modelまで正しく投影し、`false`も維持するよう修正した。
- Artifact保存/復元のoperation IDを`artifact_operation_<uuid>`へ局所正規化し、再試行の安定性を維持した。
- Completion ActivityのoperationId検証をouter共通opaque ID契約へ合わせ、Completion所有IDの厳格性を維持した。数字開始UUIDのfocused testを追加した。
- 初回実装のfocused 10 files / 184 tests、Web typecheck、lint、Web build、Desktop build、diff checkはpass。追加修正後はArtifact panel focused 17 tests / Web typecheck / diff check、Completion focused 12 tests / Workspace Server typecheck / diff checkがpassした。

### 最終判定

E4〜E11は記載範囲の実接続確認を追加できたが、E6のreload後永続下書き、E8の完全再開、E10の実ファイルDownload証跡には限定・未確認が残る。E2/E3/E12/E13は部分実施、E14は未実施である。したがって、今回の記録は実接続範囲を拡大した証拠であり、Native UI移行のE2E全体完了を意味しない。

---

## 2026-09-15追加確認（E3/R3・E2・E14）

既存の実接続記録を置換せず、同じ隔離Server・隔離DB・CUA環境で追加確認した結果を記録する。

### E3/R3: 新規Roomの実行権限投影

- UIで既存Agent `Gemini検証Agent`を選び、隔離新規Room `E2E Theme Run Room`を作成した直後、送信欄が「実行可否を確認できません」となり送信disabledになる不具合を実E2Eで再現した。
- 原因は、StoreのcreateRoom後SELECTが`can_manage`/`can_edit`/`can_execute`を返していなかったこと、および`DesktopWorkspaceRoom`に`canExecute`型がなかったことだった。
- Server正本から`canExecute`を返し、`false`も保持するよう修正し、Domain/API、bridge、Native modelまで伝播させた。
- 隔離Server再起動後、同じ新規Roomで`接続済み`、`既定AGENT Gemini検証Agent`、入力有効を確認した。`新規Roomの実行権限確認です。日本語で一言返してください。`を送信し、完了と実応答`承知いたしました。権限の確認が完了し、正常に動作しております。いつでもお声がけください。`を確認した。
- E3を実行権限を含む範囲へ強化した。Workspace複数切替はfixture不足のため未実施である。

### E2: 実行中テーマ・成果物editor下書き保持

- `General`でWork `テーマ変更中の実行保持確認です。日本語で一言返してください。`を送信した。
- 実行中にCからBへ切り替え、成果物editorの未保存draft `v1\nE2 theme draft survives`を保持したままBからAへ切り替え、editor draftと実行中状態が維持されることを確認した。
- 再確認後、実返答`はい、何でしょうか？お気軽にお話しください。`を確認した。
- E2のテーマ切替中のeditor/Agent実行保持を実接続で確認した。文書編集中・その他の状態は引き続き全範囲確認ではない。

### E14: 隔離Electronのrenderer確認

- 最初に`pnpm run dev -- --user-data-dir=...`を試したが、pnpm scriptの引数配置により`user-data-dir`がアプリ引数として扱われ通常profileを使おうとしたため、通信・送信・UI操作前に直ちに停止した。秘密情報は読んでいない。
- 正しく`pnpm --filter @samurai-agent/desktop exec electron --user-data-dir=/private/tmp/samurai-native-openclaw-ui-20260914/desktop-profile .`を実行し、隔離profileでDesktop共通rendererを起動した。
- CからBへのテーマ選択と、`Super+R` reload後のB復元を確認した。
- 隔離profileには認可identityがなく、`Workspace Serverに接続してください` / `接続設定`で停止した。送受信・Documentは未実施である。通常profileを使った初回試行も即停止済みである。

### 最新の検証結果

- Web focused: 9 files、183 passed。
- Core/API focused: 次の4 filesで96 passed。
  `pnpm exec vitest run packages/workspace-server/src/workspace-server-store.test.ts packages/workspace-server/src/workspace-completion-service.test.ts packages/domain-api/src/index.test.ts apps/server/src/workspace-server/organization-api-contract.test.ts`
- Web / Workspace Server / Domain API / Serverのtypecheck：pass。
- `pnpm lint`：pass（`format_checked 954`、`lint_checked 835`）。
- Web build：pass（1.16MBのchunk size warningのみ）。
- Desktop build：pass。
- `git diff --check`：pass。
- Artifact operation ID / Core opaque ID変更の独立再レビュー：must-fixなし、対象focused 47 passed。

### 最終判定の更新

E3は新規Roomの実行権限投影を含めて強化確認し、E2は実行中テーマとeditor draftの保持を追加確認した。E14は隔離Electronのテーマ・renderer確認までで、実接続送受信・Documentは未実施である。E12は未実施、E13は390px右パネル操作未実施、Downloadの実ファイルE2E証跡は限定的である。したがって、未実施範囲を成功扱いせず、Native UI移行のE2E全体完了とは判定しない。

---

## 2026-09-15 最終追加確認（E12・E14）

既存の記録を置換せず、同じ隔離PostgreSQL・Workspace Server・Vite・macOS Electron profileで実施した。

### E14: 隔離Electronの実送信・返答・文書

- 新規の隔離Owner identityをElectronの正規Import画面でOS保護領域へ読み込み、通常profileや既存identityを使わなかった。
- CからBへのテーマ切替とreload後のB復元を確認した。
- ElectronからGeminiへ実送信した。最初の1回はproviderの一時的な503で失敗したが、同じ隔離環境での再試行は完了し、実返答本文`Electron E2E 成功`を画面とServerのWork記録の両方で確認した。
- 実機で本文が完了ラベルだけになったため、Electron main bridgeが公開済みの`assignees[].result.summary`を除外していたことを確認し、公開結果だけをSchema検証して通すよう修正した。秘密、Session、credentialは引き続きRendererへ渡さない。Desktopを再bundle・再起動後、返答本文がreload後の会話に表示された。
- 選択Roomヘッダーの「成果物」から右パネルを開き、保存済み文書`E14 Desktop 文書`と本文を表示した。Downloadは操作していない。

### E12: 隔離Guestの権限境界

- 別の新規Guest identityを別の隔離Electron profileへ正規Importし、確認後にクリップボードを空にした。キー本文は画面・ログ・本レポートへ出していない。
- Guest UIには許可された読み取り専用Roomだけが表示され、送信欄と送信ボタンは無効であることを確認した。
- Guestの「成果物」パネルには、許可Room内に成果物がないことだけが表示され、Owner側の別Room文書は一覧に出なかった。
- fixtureの正規API確認では、Guestの書込みは403、別Room成果物の直接取得は404、実行不可Agentは`can_execute: false`であることを確認済みである。

### 最終静的検査

- `pnpm exec vitest run`（Desktop Room Work、Native App、Room Work、Artifact、theme/profile関連の8ファイル）: 148 passed。
- `pnpm --filter @samurai-agent/web run typecheck`: pass。
- `pnpm --filter @samurai-agent/web run build`: pass。1.16MB chunk size warningのみ。
- `pnpm --filter @samurai-agent/desktop run build`: pass。
- `pnpm lint`: pass（`format_checked 954`、`lint_checked 835`）。
- `git diff --check`: pass。
- 最終追加のElectron結果公開とヘッダー成果物入口の独立再レビュー: must-fixなし。

### 判定

E12とE14は隔離実Clientで完了した。E10の実ファイルDownloadは利用者の明示指示により未完了として扱う。E13の390px右パネルは、Electronが最小幅980pxであり、利用可能なCUA Browserに認可済みの390px環境を用意できないため未確認である。これはアプリの失敗ではなく検証環境の制約であり、静的テストで代替していない。既存記録にあるWorkspace複数切替、reload後の永続下書き、完全な実行再開、試作品distとの正確な視覚比較も未確認のまま残る。

---

## 2026-09-15 追加E2E（E3・E8・E10）

既存記録を置換せず、同じ隔離PostgreSQL・Workspace Server・Vite・macOS Electron profileで、利用者が今回実行を指示した残項目を確認した。通常profile、本番DB、秘密値は使っていない。

### E3: Workspace複数切替

- 認可済みの隔離Owner Desktop bridgeを使い、検証専用の第2Workspaceを作成した。これはfixture準備であり、UIからWorkspaceの新規作成を行ったものではない。
- RendererをreloadしてWorkspace一覧が再取得されることを確認した後、profile menuから元Workspaceと第2Workspaceを往復切替した。
- 第2Workspaceには既定Roomだけが表示され、元Workspaceへ戻ると既存Roomと完了済みWorkの履歴が表示された。切替対象の混在は確認されなかった。

### E8: Client切断後の結果復元

- ElectronからGeminiへ新規Workを送信し、画面上で受付済みになったことを確認した。
- Serverを停止せず、Electron Clientだけを終了してから、同じ隔離profileで再起動した。
- 受付済みWorkはServer側で完了しており、再起動したClientに実返答本文と履歴が表示された。さらにreloadしてもWork数は増えず、同じWorkが重複作成されなかった。
- これはClientの切断・復帰を対象にした確認であり、Server自体を停止した既存の失敗試験とは区別する。

### E10: 実ファイルDownload

- Electronの「成果物」から保存済み文書を開き、native Save dialogで隔離tmp配下へDownloadした。Finderは使っていない。
- Download済みファイルと成果物の元blobをバイト単位で比較し、一致を確認した。

### Artifact editorの実行時不具合修正

- E10操作中、Artifact panelを開くとReactの親子状態更新が循環し、`Maximum update depth exceeded`が繰り返される不具合を検出した。
- `ArtifactSurfacePanel`の再取得・保存callbackを安定化して、editor controller再通知による循環更新を止めた。
- `pnpm exec vitest run apps/web/src/native-app/ArtifactSurfacePanel.test.ts`（17 passed）、Web typecheck、Web build、`pnpm lint`、`git diff --check`はpass。Web buildは既知の1.16MB chunk size warningのみ。
- ElectronでConsoleを消去後に成果物パネルと文書を開き、同じエラーが新たに出ないことを確認した。

### 追加確認: 未送信下書きのreload

- 未送信のcomposer入力を置いたままElectronをreloadしたところ、入力は復元されなかった。
- これはE6で確認済みの「送信失敗画面で入力を保持する」とは別の挙動である。永続下書きを新たな要件として追加する実装は、今回行っていない。

### 今回後回しにした項目

- E13の390px右パネル操作。
- 試作品の指定distとの正確な視覚比較。

これらは利用者の明示指示により後回しとし、成功扱いしていない。

---

## 2026-09-15 最終E2E（E2・E13・試作品比較）

同じ隔離PostgreSQL、Workspace Server、Vite、macOS Electron profileを使い、後回しにしていた確認を実施した。通常profile、本番DB、秘密値は使っていない。

### E2: テーマ切替中の状態保持

- 実Workへの返信対象、未送信の日本語本文、小さな添付ファイルを置いた状態で、C→B→A→Cを切り替えた。返信対象、本文、添付済み表示は維持された。
- Geminiへ実Workを1件だけ送信し、`受付済み`から`実行中`の間にC→B→Aを切り替えた。Work数は3件から4件へ一度だけ増え、接続切断表示や追加送信は観測されなかった。完了後、実返答本文と成果物`Samurai Agentの利点と活用ガイド`を表示した。
- 同じ隔離記録で、成果物editorの未保存draftもテーマ切替後に維持されることを確認済みである。テーマ値でReact subtreeを作り直さず、実行・editor・入力を再実行しない実装である。

### E13: 390pxを含む表示幅と右パネル

- 通常幅（比較用の論理1366px）、1024px、390pxでC/B/Aを本人メニューから切り替えた。各選択はアクセシビリティ上の選択状態で確認した。
- 390pxではナビゲーションdrawerの開閉、長い日本語の未送信入力、成果物一覧、実文書`Samurai Agentの利点と活用ガイド`の本文・版履歴・Download入口、`仕事へ戻る`による元Chatへの復帰を確認した。復帰後も未送信入力は保持された。
- 横幅の実測は390pxで`innerWidth = documentScrollWidth = bodyScrollWidth = 390`、1024pxで同値1024だった。入力欄と送信操作は表示範囲内に残った。
- 390pxはElectronの最小ウィンドウ幅980pxを変更せず、同じ認可済み隔離Electron RendererのDevTools表示幅だけを390pxにして確認した。したがって物理ウィンドウを390pxへ縮小した証拠ではないが、実Desktopの同一Renderer・実Server・実データでレスポンシブ経路を確認した証拠である。

### 試作品との視覚比較と修正

- 利用者提供のC/B/Aスクリーンショットと、固定した試作品の1366px基準画面を、同じ論理1366pxの実Renderer画面と比較した。
- 計画で許可された差分である「外側の大きな丸角余白を除き全面Shellにする」「試作の上部比較バーを移さない」「架空データ・未接続操作を移さない」は差分として扱わなかった。
- 比較で確認した修正必須は2件だった。A特別版の星が不透明なShellの背後に隠れていたこと、会話ヘッダーと仕事選択帯が試作品より高く会話開始を押し下げていたことを修正した。星は会話面の非操作背景へ移し、Sidebar幅、ヘッダー、仕事選択帯、会話開始位置をOpenClaw型の密度へ揃えた。
- 修正後にC/B/Aの通常幅画面、Aの390px Chatと成果物パネルを再撮影し、星は操作を遮らず、右パネルと元Chatへの復帰に回帰がないことを確認した。実データ量と意図的な差分があるため、ピクセル単位またはDOM単位の完全一致を主張するものではない。

### 最終静的検査

- `pnpm exec vitest run apps/web/src/native-app/NativeProfileMenu.test.ts apps/web/src/lib/native-app-theme-preferences.test.ts apps/web/src/native-app/NativeApp.test.ts apps/web/src/native-app/RoomWorkSurface.test.ts apps/web/src/native-app/ArtifactSurfacePanel.test.ts apps/web/src/native-app/native-artifact-workspace.test.ts`: 6 files / 85 passed。
- `pnpm --filter @samurai-agent/web run typecheck`: pass。
- `pnpm --filter @samurai-agent/web run build`: pass。1.16MB chunk size warningのみ。
- `pnpm lint`: pass（`format_checked 954`、`lint_checked 835`）。
- `git diff --check`: pass。

### 判定

今回の計画で未完了としていたE2、E13、試作品との視覚比較を完了した。E10 Downloadも前節の実ファイル比較で完了済みである。Windows/Linux、Hosted、本番デプロイ、Codex/Claude Code公式認証など、計画で対象外とした確認はこの判定に含めない。

---

## 2026-09-15 最終独立レビュー後の修正

視覚比較とE13を終えた後、独立レビューで3件を集約して修正した。E2Eの途中には修正を挟んでいない。

- 390pxでRoomヘッダーがナビゲーションボタンに近付きすぎる問題を、mobile時だけ56pxの左余白を確保して修正した。再撮影でボタンとRoom名が重ならないことを確認した。
- ライトテーマのArtifact本文・編集欄が暗い半透明背景を引き継ぐ問題を、theme tokenの背景へ統一して修正した。390pxの実文書で本文と操作欄の明暗を確認した。
- 閉じたmobile Drawerが視覚的に隠れるだけでキーボード対象に残る問題を、700px以下で`aria-hidden`と`inert`を切り替えるよう修正した。閉じた状態ではAX treeにSidebar項目がなく、開くと再び現れることを確認した。

再検証結果:

- `pnpm exec vitest run`（theme/profile、Native App、Room Work、Artifactの6 files）: 85 passed。
- Web typecheck、Web build、`pnpm lint`、`git diff --check`: pass。Web buildは1.16MB chunk size warningのみ。
- 修正差分の独立再レビュー: must-fixなし。
- Electronを通常起動し直した最終画面: `innerWidth=1320`、`documentScrollWidth=1320`、`bodyScrollWidth=1320`。

### 最終判定

計画の完了条件に対する実装と、E1〜E14の記録済み実接続確認を完了と扱う。390pxは上記のとおり同じ隔離Electron Rendererの表示幅検証であり、物理的に390pxのElectron windowを作った証拠ではない。未送信下書きのreload後永続化は、今回の計画に追加していない別の製品判断として残る。

---

## 2026-09-16 試作品骨格への再同期と最終E2E

### この追加記録の範囲

利用者の追加指示により、今回のUIは試作品のHTML/CSS/JSを画面骨格の参照元として再確認した。旧来の「画面全体を平坦な2分割にする」判断は採用せず、外側のテーマ背景、透明Sidebar、内側の角丸Chatウィンドウという試作品の構成へ揃えた。

この節は過去の記録を削除しない。現在の未コミット差分に対して実行した検査とE2Eだけを記録する。通常利用のDesktop profile、本番DB、秘密値は使っていない。

### E2Eの途中で集約して直した事項

E2Eを一通り進めた後、次の2件をまとめて修正した。

1. 同じRoomに複数のWorkがあると、選択中の1件だけが会話に表示されていた。RoomのWork一覧後に、既存のroom.work.viewで同じRoomの各詳細を取得し、対象・版・世代を保ったまま会話へ投影するようにした。
2. 1024px程度の成果物パネルで一覧と詳細が狭すぎ、案内文が縦に崩れ、見出しが重複していた。内側の見出しを除き、狭いパネルでは一覧と詳細を縦積みにするコンテナクエリへ変更した。

いずれも新しいAPIやDB schemaを作らず、既存の公開取得・保存経路を使っている。

### Browser E2E

隔離PostgreSQL、Workspace Server、Viteを使い、http://localhost:5174/ をCUAで操作した。

| ID | 実操作 | 結果 |
| --- | --- | --- |
| E1 | C/B/Aの選択、再読み込み | 3テーマの選択表示とCへの復帰を確認。上部比較バーは表示されない。 |
| E2 | 入力・返信対象・成果物editorの未保存内容・実行中Workの途中でテーマを変更 | C/B/A切替後も対象と内容が維持された。テーマ変更による追加送信・再接続は観測しなかった。 |
| E3 | Room、Agent一覧、プロフィール、DM | 実Agentの表示、プロフィール、既存DM、既存Agent選択だけのRoom作成導線を確認。作成・編集・Room設定・権限UIは通常導線に表示されない。 |
| E4 | GeneralからGeminiへ通常送信 | 実返答「確認済み」と、別Workの実返答「表示確認済み」を会話に表示した。 |
| E5 | 同じWorkへ返信 | 実返答「返信表示確認済み」を同じRoomの会話履歴に表示した。途中で失敗状態になった別試行はあったが、同じ検証環境で最終返信が正常完了したため、失敗を成功表示へ置換していない。 |
| E6 | 小さなテキストファイルを添付して送信 | 実ResourceRefと実返答「添付確認済み」を確認した。 |
| E7/E8 | Room/DMの下書き分離、reload | RoomとDMで異なる下書きを保持し、reload後も初期依頼、返信、添付参照、Gemini返答が同じRoomに重複なく表示された。 |
| E9/E11 | 保存済み文書、版履歴、パネル復帰 | 実文書の内容・revision 2・版履歴を開き、未保存editor内容のテーマ切替保持と取消を確認した。 |
| E13 | 1024pxと390px、Drawer、成果物パネル | clientWidth、scrollWidth、bodyScrollWidthはいずれも各幅と一致した。390pxでDrawerの開閉、成果物一覧、仕事へ戻る導線を確認した。 |

E10の実ファイルDownloadは、今回のBrowser自動化ではBlob保存イベントを取得できなかった。利用者の明示指示に従い、この確認は未完了のまま今回の完了判断から除外した。Download入口そのものは実文書パネルに接続されたままである。

### 隔離Electron E2E

最終のDesktop build後、認可済みOwner profileと別のGuest profileを、それぞれ隔離した一時profileだけで起動した。

- Owner: 現行rendererでE14 Desktop Workを開き、保存済みの実Gemini返答と成果物一覧を表示し、成果物パネルを開いた。
- Guest: 許可された読み取り専用Roomだけが表示され、入力欄と送信ボタンがdisabledであることを確認した。成果物パネルには許可Roomに確認可能な成果物がないことだけが表示された。

この追加実行では、Ownerから新たなGemini依頼を送信していない。BrowserでE4/E5/E6の実送信を確認し、Electronでは共通renderer、bridge表示、成果物、読み取り専用境界を再確認した範囲である。

### 静的検査

- Web focused test: 9 files / 192 passed。
- Core/API focused test: 5 files / 106 passed。
- pnpm --filter @samurai-agent/web run typecheck: pass。
- pnpm --filter @samurai-agent/web run build: pass。既知のchunk size warningのみ。
- pnpm lint: pass。
- pnpm desktop:build: pass。Desktop typecheck、bundle、artifact verificationを含む。

### 現在の限定範囲

- 実ファイルDownloadの今回の自動E2Eは、利用者指示により非必須として未完了。
- 390pxはBrowserの実Renderer幅で確認した。Electron物理ウィンドウの最小幅は変更していない。
- 未送信composer下書きのreload後永続化は、今回の完了条件に含めていない。

### 差分基準と独立レビュー

- 確認したHEAD: 59b3b69e445e8b9e0dd3857406ecfae7f0c01c6f。検証対象は、このHEADに対する未コミットのNative UI移行差分である。
- 最終の読み取り専用レビューは、計画、正本、試作品骨格、現行差分、上記E2E記録を照合した。
- 修正必須: なし。同一Roomの複数Work履歴、実Agent結果、返信、成果物参照、透明Sidebarと角丸main、未接続管理UIを表示しない境界に、今回の完了を妨げる根拠は見つからなかった。
- 390pxの物理Electron幅と今回のBrowser Download自動取得は限定範囲として残す。どちらも利用者指示と今回の完了条件に照らして、追加修正の必須事項にはしない。
