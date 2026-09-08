# Native App・Artifact・Surface 実装プラン — Phase 5残作業・7

- 作成日: 2026-09-07
- 更新日: 2026-09-08。旧Vueの機能評価を反映し、Phase 5の範囲・工程・完了条件を補強
- 状態: 置換方針と成果物の製品範囲は会話で合意済み。機能評価に基づく実装前の技術プラン。個別の画面配置は設計案であり、コード実装・実機検証は未実施
- 調査基準: 初回HEAD `a7a8c174243bf7ee20d6b367afca821284b81ff9`。更新時は現行sourceを再確認し、既存の本プラン・簡略版・関連設計3文書の差分を継続して編集
- 対象: 元のNative AppロードマップのPhase 5の残作業とPhase 7
- 簡略版: [非エンジニア向けプラン](native-artifact-surface-overview-plan-phase5-7.md)
- 詳細設計: [Artifact・Surface](../docs/designs/artifact-surface.md)、[Native App](../docs/designs/native-app.md)

## 1. 目的・背景

Phase 0・1・2・3・4・6が完了したという利用者の申告を今回の開始条件とする。今回それらのPhase全体を再監査して完了判定を変更するものではない。

Phase 5では、今の製品設計に必要な操作をReact Appで完結させ、旧Vueの画面・専用処理・依存を整理する。旧Vueの全機能や画面構成を再現することは目的にしない。必要な機能を評価して採用し、不要な機能は移植せず廃止する。

Phase 7では、RoomでAgentが作った文書・表・画像・PDF・HTMLを開き、内容を確認して修正・保存できる体験を完成させる。必要なときに表やフォーム、グラフ等の画面が開き、人が入力したデータもWorkspaceに残るようにする。

既存React/Electronを継続する。「React Native App」という旧ロードマップの表記を、モバイル向けReact Nativeフレームワークへの移行と解釈しない。既に動くWorkspace・Room・Agent・仕事・接続の基盤を活用し、不足する管理・確認・設定の操作を加える。Reactが起動すること、Phase 7のパネルができることだけではPhase 5完了にしない。

本書のPhase番号は利用者提示の元ロードマップを指す。[Workspace-first・Organization再設計](workspace-first-organization-realignment-master-plan.md)のPhase番号とは別である。実装順序は本書内の工程A–Fで表し、元Phaseを改番しない。

## 2. 禁止事項

- 合意済みのWorkspace所有、Room認可、Session内部化、既定Agent・専門Agentの仕事モデルを変更しない。
- 文書・表・HTML等を単にJSONやファイル名として表示するだけで、プレビュー・編集・入力保存が完成したと扱わない。
- 全てを新設せず、既存のDomain契約、PostgreSQL adapter、Revision、File Transaction、Surface定義を調べて再利用する。
- VueのSession依存や未接続の旧APIを、そのままReactの新しい主経路にしない。
- 旧Vueとの全機能一致、旧画面の再現、Vueを予備画面として残すことを完了条件にしない。共有Core・API・保存データをVue専用と決め付けて削除しない。
- Word・Excel互換編集、画像・PDFの手動編集、汎用画面ビルダー、Phase 8の学習再設計、Phase 9の外部Client製品化、Phase 10のCompute・署名・配布へ広げない。
- 利用者が所有する任意ファイルを、Agentの出力という理由だけで読み出し・登録しない。対象Roomの実行と認可された出力を関連付ける。
- 参照OSSの製品階層・認証・保存方式・画面全体をコピーしない。参考にする体験は会話で合意した範囲に限る。
- 型を広げるだけ、テスト専用経路、成功表示の固定、検証の弱体化で要件を満たしたことにしない。
- 既存差分を消さない。文書作成の承認をbranch作成、コード実装、commit、push、PR作成の承認として扱わない。
- 未実行・失敗・skipを成功扱いしない。同じ条件の重い検証を繰り返さない。

## 3. 正本と確定事項

### 3.1 正本・関連文書

- [PRODUCT.md](../PRODUCT.md)、[ARCHITECTURE.md](../ARCHITECTURE.md)
- [Artifact・Surface設計](../docs/designs/artifact-surface.md)、[Native App設計](../docs/designs/native-app.md)
- [RoomとAgentの共同作業](../docs/designs/room-agent-work.md)、[Agent Backend](../docs/designs/agent-backends.md)
- [Phase 3・4・6プラン](room-agent-collaboration-plan-phase3-4-6.md)

### 3.2 会話で合意した仕様

| 項目 | 合意 |
| --- | --- |
| 対象の成果物 | 文書・表・画像・PDF・HTML |
| 修正 | Agentへの修正依頼と、文章・表データの直接編集 |
| 画像・PDF | 閲覧・保存・Agentへの修正依頼。手動編集は不要 |
| Surface | 表示・絞り込み・フォーム入力・データ保存を含む |
| Office互換 | Word・Excelファイルの互換編集は必須にしない |
| 体験の参考 | MulmoClaudeを中心に、Codex、OpenClaw、Buzzの該当体験を参考にする |
| 進め方 | Phase 5の残りとPhase 7をまとめ、プランと必要な設計書を先に作る |
| Phase 5の評価基準 | 今の設計に必要な機能を評価して採用する。旧Vueの全機能は移植しない |
| 旧Vueの扱い | 採用機能はReactでの成立確認後に削除。不要機能は参照・依存確認後に移植せず削除。共有処理は用途を確認して活用する |

### 3.3 今回の技術提案

以下は上記を実現する具体案であり、利用者がライブラリ・内部schema・API名まで指定したという意味ではない。

- Markdown文書、構造化した表データ、既存Generated Surfaceを主な編集・表示モデルにする。
- Chat横のパネル、Roomの成果物一覧、手動保存、版比較と復元を既存構造から具体化する。
- Surfaceの保存先は既存ArtifactまたはCollection等のDomain資源へ固定する。
- Clientを共通Domain APIへ接続し、本文の大きさ・binary配信は認可されたFile APIと分担する。
- 個々の検証担当は既存Backend設計を引き継ぎ、Native+Geminiを実装担当、公式認証のCodex/Claude Codeと操作感を利用者担当とする。
- Phase 5の採用範囲は4.1の評価表を実装基準にする。Knowledge/Skillの基本管理、Room管理、検索、必要な設定、実行確認、自動化の基本管理を加える。学習アルゴリズムや専用業務アプリ群は追加しない。
- 各補助機能はRoomの文脈から必要時に開く。旧Vueの常設メニュー群を再現せず、Chatと補助パネルに戻れる導線を揃える。

## 4. 現行実装と不足

これはsourceの読み取り結果であり、実動作の証明ではない。

| 責務 | 確認したファイルと事実 | 今回必要な作業 |
| --- | --- | --- |
| React起動 | `apps/web/src/main.ts`は`NativeApp`を起動。`apps/web/vite.config.ts`はReactのみをproduction entryに指定 | Vue部品の存在を現在のUI実装と数えず、対象機能をReactへ接続 |
| Room Work UI | `apps/web/src/native-app/RoomWorkSurface.tsx`、`use-native-app.ts`、`types.ts`に仕事・担当・添付・Evidenceの経路がある | 仕事の結果とArtifact/Surfaceの参照、開く・修正・保存を接続 |
| 旧表示部品 | `apps/web/src/components/WorkspaceCanvas.vue`、`GeneratedSurfaceFrame.vue`、`CustomViewFrame.vue`、`apps/web/src/lib/use-surface-workspace.ts` | 操作の参考として使い、Vue状態管理・Session前提を持ち込まない |
| Artifact契約 | `packages/core-schemas/src/index.ts`にArtifact/Revision。`packages/domain-operations/src/operations/artifact/`にcreate/revise/restore/view/list等 | 直接編集・履歴・ダウンロードの不足するQueryと型を追加。初期版と空内容も扱う |
| 実保存 | `apps/server/src/adapters/runtime/postgres-artifact.ts`にRoom付き取得、版競合、immutable revision、blob、File Transaction復旧 | read/write/Eventまで同じ保存結果を指すことを確認し、binary登録・配信を完成 |
| 公開API | `apps/server/src/workspace-server/domain-api-v1.ts`はArtifact作成・修正・復元とlist/viewを実装 | Surface・履歴等の必要契約を公開入口へ接続。既存契約の単なる登録を実行可能と扱わない |
| Bridge | `apps/web/src/lib/workspace-browser-bridge.ts`と`apps/desktop/src/main.ts`にArtifact/Surface経路 | Artifactの構造化内容とSurfaceには旧workspace API経路が残る。新UIを共通契約へ揃える |
| Surface保存・操作 | `apps/server/src/adapters/runtime/postgres-generated-surface.ts`に生成物保存、版、状態、出力、action処理 | Roomからの一覧・再表示・更新通知、actionの固定対象・入力検証・再送・承認を一貫させる |
| 実Agent tool | `apps/server/src/workspace-server/http-server.ts`の`createPostgresRuntimeToolExecutionPort`の通常executeはcreate_artifact/artifact.createを受け付ける | Artifact修正・生成Surfaceの作成/修正を、実RuntimeとBackendのtool受付へ接続 |
| Surface target | 同ファイルの`createPostgresGeneratedSurfaceTargetCommand`はArtifact作成とCollection操作等を分岐する | UIが宣言できる操作と実装済みのtargetを一致させ、必要な修正操作を接続 |
| sandbox | `packages/runtime/src/presentation/generated-surface.ts`にbundle/CSP検査。Generated HTML内の`form`要素も現在は禁止 | 入力・保存をaction bridgeで成立させる。禁止を一括解除しない |
| binary表示 | `PostgresArtifact.get`は画像/PDFをbase64で返す。旧content routeはJSON以外をtext/plainで返す | binary、encoding、MIMEを明示し、表示とダウンロードで実byteを保持 |
| 検証 | `postgres-artifact.test.ts`はFakeFiles/FakeCommandsによる復旧test | 実PostgreSQL・File Store・Electronの証拠を別に取得 |

### 4.1 Phase 5の機能評価と処置

2026-09-08の読み取り調査では、Vueの画面・部品15ファイルとVueをimportする状態管理10ファイルが残っていた。次は旧画面への到達や実動作の証拠ではなく、sourceと現在のReact入口・APIを照合した評価である。工程Aで初めて要否を決めるのではなく、この表を開始時の実装基準とし、sourceの変化と依存関係だけを更新する。

| ID | 現行source・機能 | 評価と今回の処置 | 到達先・要件 |
| --- | --- | --- | --- |
| V01 | `App.vue`、`AppWorkspace.vue`、`AppSidebar.vue`のSession一覧、新規会話、Backend選択中心の構成 | 旧構成を廃止。現行Workspace→Room→仕事・Agentの構成を使う。Session管理を利用者へ戻さない | Phase 5 / R01・R11・R17 |
| V02 | `WorkspaceConnectionSettings.vue`、旧Chat・添付・stream制御 | Reactの接続、Room Work、返信・コメント添付は実装あり。旧経路を重複移植せず、現在の導線の不足・回帰だけを直す | Phase 5 / R11・R17 |
| V03 | `WorkspacePanels.vue`、`ManagementSurfaces.vue`のMemory閲覧・Wiki編集と、`WorkspaceLearningPanel.vue`のKnowledge作成・編集・履歴・根拠・AI更新固定 | 基本管理を採用。Room知識とWorkspace共通知識を区別し、複数の知識画面を必要時に開く導線へ整理する。保存形式や資源IDは統合しない | Phase 5 / R12 |
| V04 | `ManagementSurfaces.vue`のSkill本文編集、有効・無効化、Chatで参照 | 再利用手順を人が管理する操作として採用。現行Completion resource APIと版制御を利用 | Phase 5 / R12 |
| V05 | `SkillOptimizationCard.vue`の改善候補・評価点・採用/見送り、学習Engineの詳細設定 | 改善ループのUIはPhase 8で再評価し、旧Vue部品を温存しない。Phase 5では現行学習の有効状態・Room上書きなど基本管理に絞る。既存Core/履歴は保持 | Phase 8へ機能を引継ぎ / R14・R17 |
| V06 | `WorkspaceCanvas.vue`の文書・画像・PDF表示、フォーム・表入力、chart枠 | 表示と入力部品の考え方を採用。汎用文書editorは新たに接続。旧chartはタイトル・参照情報の表示だけで、完成したグラフではない | Phase 7 / R02–R06 |
| V07 | `GeneratedSurfaceCard.vue`、`GeneratedSurfaceFrame.vue`、`CustomViewFrame.vue`のHTML表示・action・pin・書出し | 既存bundle/契約を活用し、Reactの隔離表示と現在のDomain APIへ接続し直す | Phase 7 / R06・R08 |
| V08 | `CollectionWorkspaceView.vue`の表・gallery・calendar・kanban、追加・編集・削除、検索・sort・filter | Collectionの型付き入力・更新・検索処理を活用。今回の必須は表/フォームと宣言済みaction。専用calendar/kanban/gallery画面の一括復活はしない | Phase 7 / R03・R06・R17 |
| V09 | `WorkspaceRoomTree.vue`の子Room作成・移動、人間メンバーの権限変更と影響確認 | 採用。Reactは階層表示とAgent権限管理があるが、人間のRoom権限と移動の導線が不足。現在の親Room制約・最後のOwner保護を引き継ぐ | Phase 5 / R13 |
| V10 | `AppWorkspace.vue`、`WorkspacePanels.vue`の検索 | 認可された現在のRoomから履歴・成果物・知識を探して開く導線を採用。Sessionを開く旧処理を仕事/資源参照へ変更 | Phase 5 / R14 |
| V11 | `ContextDrawer.vue`、`use-work-summary.ts`、`use-approval-workflow.ts`の文脈・実行履歴・変更確認・承認・復元 | 仕事から根拠と必要な確認を開く目的を採用。旧承認/汎用rollback APIは未接続なので再利用しない。復元は対象資源に定義された操作だけを使う | Phase 5・7 / R04・R15 |
| V12 | `ManagementSurfaces.vue`の自動化一覧・停止/再開・次回予定・実行履歴 | 既存のRoomの自動化を確認・停止/再開する基本管理を採用。scheduler新設、汎用スケジュールeditorは対象外 | Phase 5 / R16 |
| V13 | `WorkspacePanels.vue`、`settings-storage.ts`の言語・保存方針・接続設定 | 表示/出力言語、接続・Agentの設定/認証状態、学習の基本状態を整理。旧Memory/Wiki/Skill別の設定群をそのまま再現しない | Phase 5 / R11・R14 |
| V14 | `use-message-actions.ts`、`use-resizable-layout.ts`、`use-chat-scroll.ts`等の小操作 | コピー・scroll・幅変更・フォーカスは必要な箇所だけReactで実装。旧評価ボタンはlocal stateのみで、学習機能として数えず廃止 | Phase 5 / R11・R17 |
| V15 | Vue依存、型宣言、Vitest設定、旧CSSとテスト | 参照元を調べ、採用挙動のtestを移した後に削除。`app.css`はReact入口もimportしているためファイル全体を削除しない | Phase 5 / R17 |

`collection-view-state.ts`、`workspace-room-tree.ts`等のVueに依存しない処理や、共通`api.ts`・Desktop/Browser bridge・Server側の保存処理は再利用候補である。ファイル名に旧用語があることだけで削除しない。採用しない専用画面の削除は保存済みデータの削除を伴わず、Collection等は汎用の表示/データ操作から参照できるようにする。

### 4.2 接続の不足と過去の証拠

- `api.ts`の`runSurfaceOperation`はCollectionと`artifact.request`を扱う一方、旧form.submit/table.patch/chart.request/custom_view.actionは未接続の拒否へ落ちる。`updateMessagePresentationViewState`も未接続。旧入力欄の存在を保存済み機能と数えない。
- 同ファイルの旧approve/deny/rollbackは入力を使わず拒否する。Phase 5/7で必要な承認は現在のCoreの要求・判断・実行結果へ接続し、旧関数を呼ぶボタンだけを作らない。
- 現在の公開v1にはRoom/仕事/Agent/Artifact等があるが、Knowledge・検索・自動化等は既存workspace bridgeに処理がある。R12–R16に必要な公開Query/Operation/Eventの不足も今回の作業に含める。API整備をPhase 9任せにしてReactを旧専用経路へ戻さない。
- [Phase 3・4・6の検証記録](../reports/room-agent-collaboration-phase3-4-6/report.md)には実Electron・Native+Gemini・隔離PostgreSQLで依頼/返信/委譲/成果物保存を確認した記録がある。本改訂で実行した検証ではなく、R11の再利用基盤の証拠である。公式Codex/Claude Code、Hosted、操作感の未検証を引き継ぐ。

## 5. 対象・対象外

### 対象

- 4.1で採用したReactの基本導線、Knowledge/Skill、Room管理、検索・設定、実行確認、自動化の基本管理。
- 旧Vueの要否評価・必要処理の抽出・採用挙動の検証・不要コード/依存/旧テストの整理。
- 文書・表・画像・PDF・HTMLの表示、実ファイルのダウンロード、Roomからの再表示。
- 文書本文・表データの直接編集、保存、競合表示、履歴確認、旧版からの復元。
- 対象の版と選択箇所を付けたAgentへの修正依頼。
- 組込みform/table/chartと生成HTMLを表示し、入力・絞り込み・永続保存を行う。
- 必要なDomain API、Public Event、Client bridge、Runtime tool、保存・復旧・Export/Restoreの接続。
- 初回接続から日常利用、再接続、既存データ再表示までのReact/Electronの完成確認。

### 対象外

- Word/Excel互換編集、数式エンジン・マクロ、画像/PDFの手動編集。
- ドラッグ操作による汎用UI設計ツール、HTML/CSS/JavaScript専用IDE、全形式への描画式注釈。
- 同時共同編集のカーソル表示やCRDT。既存の版競合制御で変更を保護する。
- 自動学習や評価の高度化、外部Clientの製品化、専用Compute、Computer Use、課金、配布物の署名・自動更新。
- 参照OSS全体の移植、新規provider契約や課金サービスの導入。
- 旧Vueの全画面再現、Session一覧・Session単位の操作、専用Collectionアプリ群の一括移植。
- Knowledge/Memory/Wikiの保存形式統合や既存データの一括変換。Phase 5では表示・管理導線を整理する。

## 6. 守る設計境界

1. 全ての参照・変更をconnection/workspace/Roomへ束縛し、DMと共有Roomの境界も守る。
2. Artifact/Surfaceを元の仕事・担当・Operation・版へ結び付ける。ClientへSession入力を要求しない。
3. Human編集とAgent編集を同じDomain認可・版制御へ通す。修正依頼と既存仕事の制御権限を混同しない。
4. immutableな本文履歴と、現行版へのpointerを分ける。初回版、空内容、失敗後の復旧を扱う。
5. Surfaceのコードの版と、入力先データの版を分ける。入力値で対象や権限を広げない。
6. iframeへcredential、Node、親origin、Desktop bridge、任意ネットワークを渡さない。純表示の操作とWorkspace変更を分ける。
7. Public Eventは保存済みの変更を通知し、履歴再取得で復元する。出力の存在・保存成功・操作成功をモデルの文章だけで判断しない。
8. 既存のPostgreSQL record、File Transaction、Workspace Bundleを使う。保存先の二重化を避ける。
9. Knowledge・Skill・検索結果・自動化・設定にも同じtarget/認可/版/再送の境界を適用する。知識画面の統合を保存資源の自動統合と解釈しない。
10. Room移動・メンバー変更はServerの現在の権限と版で再検査する。事前の影響確認を権限証明にしない。DMを通常の共有Roomに変換しない。
11. Coreの承認と外部Backendの入力待ちを型で区別し、仕事・担当・要求ID・期限と対応付ける。親画面のbuttonや`confirmed: true`だけを永続した承認と扱わない。

## 7. 要件と工程の対応

| 要件 | 元Phase | 実装工程 | 完了証拠 |
| --- | --- | --- | --- |
| R01 既存移行範囲の対応表とReact接続 | 5 | A・C・F | V01–V15の処置、採用機能のReact到達、production entry、旧画面への依存なし |
| R02 仕事から全対象形式を開いて再表示 | 5・7 | B・C | 実ElectronからDB・fileまでの照合 |
| R03 文書・表の直接編集と保存 | 7 | B・D | 人の入力、保存、再読込、型・空値保持 |
| R04 版競合・履歴・復元 | 7 | B・D | 人/Agent競合、初回版、旧版参照と新しい復元版 |
| R05 対象と箇所を指定したAgent修正 | 7 | B・D | 対象版・指示・Run・新revision・元仕事の関係 |
| R06 操作できるSurfaceと入力保存 | 7 | B・E | 実入力→Domain→DB→再表示、二重送信防止 |
| R07 Room・DM・Server認可 | 5・7 | B–F | 権限外拒否、失効、遅延応答の混入防止 |
| R08 隔離表示と失敗の扱い | 7 | C・E | sandbox/bridge拒否、fallback、下書き保持 |
| R09 再接続・再起動・移植 | 5・7 | B・E・F | Event replay、再起動、隔離Export/Restoreとhash |
| R10 実使用と既存機能回帰 | 5・7 | F | Backend別・Client別・配置別の結果と利用者確認 |
| R11 日常利用できるReact App | 5 | C・F | 初回接続、Workspace/Room/Agent、依頼・添付・返信・コメント・委譲・停止、設定/復旧へ到達 |
| R12 Knowledge・Skillの基本管理 | 5 | B・C・F | 一覧/本文/出所/履歴、編集・保管/復元・AI更新固定または有効状態、競合と再表示 |
| R13 Room構造と人間の権限管理 | 5 | B・C・F | 子Room作成・移動・影響確認、参加/解除・role変更、親制約・最後のOwner・DM拒否 |
| R14 検索と必要な設定 | 5 | B・C・F | 認可済みRoom内の検索→仕事/資源、言語・学習基本状態の保存、切替後の混入なし |
| R15 仕事の証拠・承認/入力待ち | 5・7 | B・C・E・F | 要求取得→本人の応答→Domain/Run結果、期限切れ/取消/二重応答/再接続 |
| R16 自動化の基本管理 | 5 | B・C・F | Roomの予定・状態・履歴、既存jobの停止/再開とServer再取得 |
| R17 Vue専用コードと依存の整理 | 5 | A・C・F | 採用挙動の検証、不要経路の参照解消、Vue専用source/設定/依存削除、clean install相当のbuild/test成立 |

工程A–Fは上記の実装順序であり、元Phaseの要件を統合して消すための番号ではない。

2026-09-07版のR01–R10と工程A–Fは全て維持する。R01の対象を評価済みApp全体へ広げ、R11–R17で不足を追加した。旧Cの成果物表示はC.2へそのまま対応し、C.1にAppの補強、C.3とFに整理・完了確認を追加する。D/Eの成果物編集・Surface要件は削減しない。

## 8. 実装工程

### 工程A: 対応表と接続契約の確定

**目的:** 既存実装を再利用する範囲と、未接続経路を明確にする。

**対象:** 本書4章の現行ファイル、`packages/domain-operations/src/operations/`、`packages/domain-api/src/index.ts`、`packages/ui-protocol/src/index.ts`、既存台帳・生成script。

**実装前の作業:**

1. 開始時のHEAD・既存差分を記録し、4.1のV01–V15とR01–R17を現在のsourceへ照合する。採用/廃止/後続の判断を一から利用者へ聞き直さず、未分類の実コードや範囲を変える新事実だけを追記する。
2. 9章の参照資料・対象コードを読み、表示と保存の分離、編集下書き、iframe分離だけを今回へ適用する。
3. Artifactの本文/バイナリ、表データ、Generated Surface bundle、Room Workへの出所参照の型を確定する。
4. 公開Query/Operation/Eventの不足を、実装済みのものと分けて列挙する。新しいAPI名は既存命名・生成手順に従う。
5. Markdown/PDF/chart部品の必要条件を確認する。表示品質、保守性、ライセンス、bundleへの影響を評価し、既存部品で足りる部分には依存を増やさない。
6. 各Vに「現行入口→Reactの配置→Query/Operation/Event→共有保存処理→旧呼出し元→削除条件→検証」を記入する。`rg`でsource、test、script、package、型宣言、CSS、生成物の参照を追う。4.1の採用範囲に入口またはAPIがない場合はB/Cの実装項目にする。
7. Room管理、Knowledge/Skill、検索、設定、自動化、承認/入力待ちの公開契約を既存サービスへ対応付ける。Surface用の承認UIはR15を共用し、画面ごとに別の承認状態を作らない。

**境界:** Office互換や任意のアプリ構築へ広げない。HTML生成を学習ループと結合しない。

**検証・セルフレビュー:** 全てのRに入口、保存先、参照元、確認方法があるかを文書で照合する。未確定の技術選定を実装済みと書かない。

**完了・次工程条件:** 必須経路の未分類がない。製品範囲を変える問題があれば先に相談し、それ以外の実装判断は担当が具体化してBへ進む。

### 工程B: Domain・Runtime・保存の接続

**目的:** 人・Agent・Surfaceから同じ成果物とデータを安全に変更できる状態にする。

**対象:** `packages/core-schemas/src/index.ts`、`packages/domain-operations/src/operations/artifact/`と`generated_surface/`、`packages/domain-api/src/index.ts`、`apps/server/src/workspace-server/domain-api-v1.ts`、`http-server.ts`、`postgres-artifact.ts`、`postgres-generated-surface.ts`、`postgres-runtime-chat.ts`。大きなserverファイルから切り出す場合は最も近い既存責務へ置く。

Phase 5の接続元は`packages/workspace-server/src/workspace-completion-service.ts`、`apps/server/src/adapters/runtime/postgres-knowledge-memory.ts`、`postgres-knowledge-wiki.ts`、`postgres-knowledge-skill.ts`、`postgres-runtime-settings.ts`、`postgres-runtime-automation.ts`と、既存Domainのroom/search/settings/automation操作である。必要な公開接続を追加し、各サービス自体の全面的な作り直しはしない。

**実装:**

1. Artifact一覧・本文・履歴・過去版取得、Generated Surface一覧・detail・bundle・操作・state・exportを共通公開契約へ接続する。大きなbinaryの配信は認可済みFile APIへ分担し、Surface用の権限を別管理しない。
2. 初期版を含むArtifact履歴と現在版の取得を揃える。新しい人/Agent編集はbase revision/expected versionを必須にし、空内容・同時更新・復元・途中復旧を処理する。
3. PDF/画像について、生成・添付・既存ファイル登録のencodingと実byteを区別する。対象Runの許可された出力だけ登録し、MIME、拡張子、hashを照合する。textのkindだけをpdf/imageへ変えて登録しない。
4. Runtime toolの新規作成だけの経路を拡張し、Artifact修正、Generated Surface生成・修正を実Backendのtool受付から呼べるようにする。必要なcatalog、provider tool宣言、出力schema、event decoder、settlementも合わせる。
5. source Work/Assignee/Runと結果refを保存する。Agentの修正依頼は既存Room Workの契約へ接続し、再送で同じ仕事・版を重複作成しない。
6. Surface actionの宣言、入力schema、固定対象、現在版、target commandをServerで照合する。親Clientからの入力でRoom/対象/command/承認を差し替えられないようにする。
7. human/Agent/Surfaceの変更をPublic EventとActivityに反映し、再送時の保存と通知の欠落・重複を検査する。既存互換入口は同じサービスを使い、台帳で移行状態を管理する。
8. R12–R16の既存サービスを公開Query/Operation/Eventへ接続する。対象はKnowledge/Skill本文・版・根拠・状態、Room作成/移動/人間membership、認可済み検索、設定、jobの状態/履歴。既存workspace APIを独立した別正本として残さず、公開入口と同じ認可・サービスを呼ぶ。
9. 承認要求/入力待ちの取得、応答、取消・期限切れ、結果再照会を、現在のCore/Run Controlへ接続する。永続したrequest・operation・run・decisionの対応と現在の権限をServerで検証する。旧approve/deny/rollbackの拒否関数や、iframeからの自己申告を新経路の実装に使わない。
10. 追加schema/Migrationは既存recordに不足する関係・版・履歴だけに限定する。Knowledge/Wiki/Memoryの一括変換や、Vue削除に合わせたDB/file削除は行わない。旧資源を現在のRoomから読めるQuery adapterを用意し、編集不可の形式はその理由と参照方法を示す。

**検証:** Artifact/Domain/RuntimeとR12–R16のfocused test、型検査、実PGで初期版・競合・再送・中断復旧・認可拒否・binaryの往復を確認する。Room影響確認後の版変更、承認の二重応答、検索結果への非許可情報の混入も対象とする。

**セルフレビュー:** schemaが存在するだけで未接続のcommandを広告していないか。target commandとイベントが同じoperationを指すか。初回保存前の内容が失われないか。

**完了・次工程条件:** R03–R09・R12–R16のServer側経路が実DB・fileで成立し、C/D/Eが使う契約を固定できる。既存サービスの未変更部分は再実装せず、不足する公開接続を閉じる。画面完成とはまだ判定しない。

### 工程C: Reactの成果物表示とPhase 5接続

**目的:** 現行設計で日常利用できるReact Appを完成させ、同じAppから成果物の確認・編集へ進めるようにする。

**対象:** `apps/web/src/native-app/NativeApp.tsx`、`RoomWorkSurface.tsx`、`use-native-app.ts`、`types.ts`、`apps/web/src/components/`、`apps/web/src/lib/api.ts`、`workspace-browser-bridge.ts`、`apps/desktop/src/main.ts`、`preload.cts`、`preload-sanitizers.ts`、Artifact/Surface request builder。

#### C.1 Phase 5のApp導線と管理・確認操作

1. Workspace/Room選択、Agent一覧・設定、Roomの仕事、任意Organization管理、接続設定を既存Reactから使う。初回/未接続/空/読取専用/失敗/再認証待ちを区別し、復旧先へ到達できる。Backendのprovider/model・認証状態と既存の設定/公式認証導線を接続し、接続済みと実行成功を混同しない。
2. Roomの補助メニューからKnowledge/Skill、検索、自動化、管理を必要時に開く。Chatへ戻っても同じ仕事と入力draftを保持する。常設の内部ID一覧や旧Sessionメニューは再現しない。画面分割・hook・Query adapterを責務ごとに分け、`NativeApp.tsx`や`use-native-app.ts`へ全機能を追加しない。
3. Knowledge/Skillは一覧、本文、保存先、出所、変更履歴を表示する。既存資源の編集、保管/復元、KnowledgeのAI更新固定、Skillの有効状態変更を現在のDomainへ通す。Knowledge新規作成は既存Completion resourceを使う。異なる保存形式は資源種別とIDで区別し、同名のMemory/Wiki/Knowledgeを勝手に結合しない。旧Memoryは閲覧・保管を基本とし、汎用編集のために変換しない。
4. 読んだ版で保存し、競合・失敗時にdraftを保持する。Knowledge/Skillを仕事へ添える操作は認可済みの資源refを入力に追加し、他Roomへのコピーや自動共有にしない。学習の生成・評価・最適化アルゴリズムは変更しない。
5. Room設定へ子Roomの作成、移動先選択と影響確認、人間メンバーの参加/解除・role変更を追加する。Agentの参加権限と分け、許可された名前だけを表示する。親Room制約・最後のOwner保護・版競合・DMの非公開制約をServerで再検査し、更新後はナビゲーションを再取得する。
6. 現在のRoomで認可された仕事/履歴・成果物・知識を検索し、該当仕事または資源を開く。旧Session検索結果はServerで対応するRoom/仕事へ解決し、対応不能な履歴はRoomの読取表示へ案内する。結果の抜粋も認可し、切替・遅延応答・削除済み結果を処理する。検索対象を全Serverへ広げない。
7. 設定は表示/出力言語、接続・Agent、学習の現在状態とWorkspace標準/Room上書きの確認・有効化/解除を扱う。保存先のscopeを示し、旧設定項目の全復活をしない。学習Engine/model/予算の高度な編集はPhase 8で扱う。
8. 仕事の詳細から、実行状態、利用した知識、ツール/変更の要約、承認/入力待ちを開く。要求の対象・影響・期限と許可された選択肢を表示し、応答→受付→実行結果を分ける。再起動後はServerの未解決要求を読み、停止後・期限切れ・他人/別Runへの応答を拒否する。資源を持たない旧汎用「元に戻す」は表示しない。
9. Roomの既存自動化を一覧し、次回予定・有効状態・最近の実行結果を確認して停止/再開できるようにする。予約停止と実行中の仕事の停止を区別し、後者は現在のRun Controlへ案内する。新しいschedulerやjob作成editorは作らない。
10. 依頼・返信・コメントの添付、コピー、scroll、keyboard、フォーカス復帰、読み込み/失敗表示を確認する。狭い画面や長いRoom一覧・履歴でも通常の操作に到達できる。UIだけで有効になる架空の承認/学習feedbackは置かない。

#### C.2 成果物の表示とPhase 7への接続

1. 仕事の結果カード、Roomの成果物一覧、Chat横の表示パネルをReactで実装する。個別renderer・controllerを分け、既存の大きいhookへ全責務を集中させない。
2. Markdown、表、画像、PDF、chart、生成HTMLを種類に応じて表示する。HTMLを親DOMへ挿入しない。対応不能・破損・大きすぎる結果は原因と安全なダウンロード/fallbackを示す。
3. Desktop/Browser双方のbridgeへ必要なQuery/Operationを実装し、表示開始時のconnection/workspace/Roomを固定する。非同期応答が別の選択へ混入しないようにする。
4. 閉じる・再表示・狭い画面・keyboard操作を用意する。編集中はAgentの新しい成果物が表示を奪わない。
5. ダウンロードは実byte・適切なfilename/MIMEを使う。Object URL、iframe、購読を切替・権限失効・終了時に解放する。
6. production entryとbuild graphを確認し、対象導線が旧Vue画面へ戻らないことを確かめる。

#### C.3 Vue整理の開始

V01–V15ごとに採用機能のReact入口と検証結果を記録する。共有する純粋関数をVue hookから分離し、不要な旧画面は参照を解消した単位で削除する。D/Eで利用する抽出前の処理は必要な部分を先に移し、Vueを保険用画面として残さない。最終的な依存・test設定・CSS・型宣言の整理と削除後の検証はFで閉じる。

**検証:** Component/bridge test、Web/Desktop typecheck・build。C.1は管理操作・draft・権限表示・承認状態・検索の切替を確認し、C.2は対象形式を確認する。実Electronの統合確認は10章のP5/P7シナリオへまとめる。

**セルフレビュー:** ファイル名だけの成功表示、base64の誤表示、一覧と現在版の不一致、未保存状態の表示奪取がないか。

**完了・次工程条件:** R01/R02・R11–R16の対象導線と保存への接続がReactで成立し、D/Eを同じAppへ接続できる。R17は処置状況を更新し、Fで削除後のgateを通すまで未完了とする。

### 工程D: 人の編集とAgentへの修正依頼

**目的:** 人とAgentの変更を版と出所付きで残す。

**対象:** 工程Cのrenderer/controller、Room Work入力、工程BのArtifact Query/Operation、関連test。

**実装:**

1. 文書の本文編集とプレビュー、表のセル編集を用意する。表の値の型・空値を保ち、保存先schemaを越えた変更をUIから要求しない。
2. 明示保存、キャンセル、未保存状態、保存中、失敗、競合を表示する。IME中・再取得・他者更新でdraftを上書きしない。
3. revision一覧と内容比較、過去版からの復元を実装する。復元も新しいrevisionとして保存する。
4. 「Agentに修正を依頼」で対象と版を入力欄へ渡す。文書の選択文章、表の行/列を指せるようにする。送信前に対象と依頼文を確認できる。
5. 元の仕事を制御できる人はその仕事への追加指示を使う。それ以外は既存権限に従う別の依頼とし、DM共有や仕事の制御を迂回しない。
6. 保存成功・Agent修正成功はDB/file/新revisionの確定後に表示する。Backendが未対応なら対応不可を返し、元の内容を保つ。
7. 修正要求に指定した版が既に古い場合は、現在版への黙った読替え・選択箇所の誤適用を避ける。対象と新旧版を示して再確認へ戻す。構造化した表は列ID/row IDを保持し、行番号だけで別行を更新しない。

**検証:** 空文書、型付きセル、IME、保存失敗、切替、二人とAgentの競合、対象版指定の修正、復元をComponentと実Client/PGで確認する。

**セルフレビュー:** 人の編集をLLM経由にしていないか。選択箇所が別revisionへ誤適用されないか。画像・PDFに直接編集が紛れていないか。

**完了・次工程条件:** R03–R05が成立し、元の内容と変更履歴・出所を照合できる。

### 工程E: Surfaceの生成・操作・永続化

**目的:** Agentが作った画面と人の入力が、実際のWorkspaceデータへつながる。

**対象:** Reactのform/table/chart/Generated Surface renderer、`packages/ui-protocol/src/index.ts`、`packages/runtime/src/presentation/generated-surface.ts`、`generated-surface-action-ingress.ts`、`apps/server/src/adapters/runtime/postgres-generated-surface.ts`、Domain API/Eventとbridge。

**実装:**

1. 保存済みのbundleと認可された入力データを読み、隔離iframeへ渡す。古いServerのpreview URLをそのまま使わない。
2. frameのsource、世代、Surface/revision/actionを固定したmessage bridgeを実装する。action payload/result/errorの型とサイズを検証する。
3. フォーム入力・表データ変更を宣言済みDomain Operationへ接続し、保存後の結果をframeと親画面へ返す。純粋な絞り込みはClient内で完結させる。
4. 既存Approval Lifecycleに必要な確認は親画面で扱う。古い版、archive、権限失効、未宣言action、別対象への入力改ざんを拒否する。
5. 生成・修正・pin/unpin/archive・再表示・HTML/ZIPの書出しを接続する。ピン留めしていない保存済みの成果物も、元の仕事から再び開けるようにする。
6. actionとデータのschema/版が変わったら古い操作を失効させ、最新データを再取得する。入力済みデータをSurfaceコードの再生成で消さない。
7. 生成失敗・検証失敗・preview失敗に対するfallbackを実装する。成功したように別の固定画面を出さない。
8. 旧form.submit/table.patch等の未接続経路を経由せず、実装済みの保存commandに対応する入力部品だけを提供する。必須の文書/表/フォームは未対応表示で完了にせず、Bの接続を完成させる。Collectionの入力変換・型・版制御を再利用し、専用業務アプリ群を必須にしない。
9. chartは実データを軸・値・単位とともに描画し、絞り込みの結果が表の値と一致することを確認する。任意種類のグラフeditorや全チャート種別を増やさない。タイトル/JSON/参照IDだけの表示を完成にしない。
10. Surfaceのactionが承認を要する場合はR15の同じ要求/応答経路を使う。親の明示操作であっても、現在の要求・対象版・権限を再検査し、Surface更新後に古い承認で別操作を実行しない。

**検証:** bundle検査、frameなりすまし、CSP/sandbox、入力改ざん、二重click、応答消失、revision更新、承認、実DB保存と再表示を確認する。

**セルフレビュー:** script文字列検査だけを安全性の証拠にしない。HTMLの入力値が保存されただけで対象データ更新済みと扱わない。pinとデータ保存を混同しない。

**完了・次工程条件:** R06–R09が実Clientから閉じ、Fで全体を通せる。

### 工程F: 統合E2E・dogfooding・完了判定

**目的:** 合意した体験を実環境で一続きに確認する。

**対象:** 本書全体、既存回帰test、実Electron・実PostgreSQL・実ファイル・実Agent、既存Workspace Export/Restore。

**作業:**

1. V01–V15の全項目を、Reactで検証済み/不要として削除/後続Phaseへ機能を引継ぎ、のいずれかで閉じる。後続扱いでも旧Vue実装を実行経路やテスト専用runtimeとして温存しない。保存済みデータと共有Coreは独立して保持する。
2. `App.vue`、`AppWorkspace.vue`、旧Vue部品、Vue専用hookを削除し、抽出した処理の利用元と意味のあるtestを残す。`CustomViewFrame.test.ts`、`CollectionWorkspaceView.test.ts`等の認可・入力・隔離の検証を対応するReact/共通契約へ移し、単に失敗するtestを外さない。廃止機能だけのtestは削除理由を対応表に記録する。
3. ルートと`apps/web/package.json`の不要Vue依存、`vitest.config.ts`のVue plugin、WebのVue型宣言とtsconfig対象、Vue前提のscript・生成物を整理し、lockfileを正規手順で更新する。Vueが推移依存として残る場合も由来を確認し、Samuraiのruntime/testの直接依存が残っていないことを説明する。
4. `apps/web/src/styles/app.css`から未使用の旧selectorだけを削除する。Reactと共用する変数・基礎styleは残し、Sidebar・dialog・入力・狭い画面を再確認する。歴史的な検証記録にVueという語が残ることを実装残存と混同しない。現在の起動案内・検証script・有効な文書リンクは更新する。
5. 削除後に、隔離した作業用環境でlockfileに基づく`pnpm install --frozen-lockfile`と対象typecheck/test/buildを一回まとめて実行する。ネットワーク/cache不足は実行不能と記録し、手元の古いnode_modulesで成功したことだけで依存整理完了にしない。既存開発環境のnode_modulesや利用者データを検証のために消さない。
6. 最終bundleで10章のP5/P7シナリオを実行する。既存の成功証拠は変更との関係を確認して再利用し、変更した経路と削除の影響を受ける入口を実画面で通す。途中で使った旧Desktop bundleを最終証拠にしない。
7. 実装者のセルフレビュー後、利用可能なら`.codex/agents/reviewer.toml`と`completion_judge.toml`の役割による読み取り専用レビューを行う。範囲追加をレビューで勝手に決めず、指摘を修正した範囲だけ再検証する。

**完了・次工程条件:** R01–R17とV01–V15の処置・証拠・未検証を一覧化し、11章のPhase別判定と利用者の操作確認へ渡す。必須の未接続経路やVue依存が残る間はPhase 5を閉じない。最終操作確認とコード変更の承認後にのみ、依頼されたGit操作へ進む。Phase 8/9/10は開始しない。

## 9. 参照資料と品質上の注意

2026-09-07に以下の公式資料・公開sourceを読んだ。2026-09-08の補強ではこの参照を引き継ぎ、Samuraiの現行sourceと要件を再確認した。参照先のmainは変わるため、実装開始時には使用するcommitを記録する。外部アプリ自体の操作検証は行っていない。

| 参照 | 確認した点 | Samuraiへの適用 |
| --- | --- | --- |
| [Codex Code review](https://developers.openai.com/codex/app/review) | 行を指定したfeedback、変更の確認と差戻し | 対象resourceと版、選択箇所を修正依頼へ添える。Gitを全成果物の保存基盤にしない |
| [OpenAIのファイル確認](https://learn.chatgpt.com/docs/artifacts-viewer) | previewと箇所を指定する修正依頼 | 対象形式の確認と反復修正。Office互換編集の要件にはしない |
| [MulmoClaude Markdown View](https://github.com/receptron/mulmoclaude/blob/main/packages/plugins/markdown-plugin/src/plugins/markdown/View.vue) | 表示と編集buffer、Apply/Cancel、保存失敗表示 | 文書の直接編集とdraft保持。Vueやファイル直書きの境界は移植しない |
| [MulmoClaude HTML View](https://github.com/receptron/mulmoclaude/blob/main/packages/plugins/html-plugin/src/vue/View.vue) | 隔離iframe、表示更新、source cacheと編集中の切替処理 | Surfaceと親UIの分離、保存後の再表示。HTML source editor全体は今回必須にしない |
| [OpenClaw Session Dashboards](https://docs.openclaw.ai/web/dashboards) | 必要なwidgetを表示・pin・更新し、人が操作する | 操作できるSurfaceと復元。Gateway/Sessionによる所有方式は移植しない |
| [Buzz ChannelCanvas](https://github.com/block/buzz/blob/main/desktop/src/features/channels/ui/ChannelCanvas.tsx) | Markdownの表示、編集draft、保存・取消、canEdit/archive | 人による文章編集と権限による操作表示。Nostr/Event保存方式は移植しない |

失敗しやすい点は、Vue部品の存在をReact完成と誤認すること、汎用Office編集へ拡大すること、Backendで未対応のtoolをUIだけ表示すること、他者変更を保存時に上書きすること、フォームの入力状態と保存データを混同すること、HTMLへ親の権限を渡すことである。

Phase 5では、旧画面の削除を理由に知識・権限・保存APIをまとめて消すこと、逆に要否を判断せず全機能を移すことの両方を避ける。Reactの管理画面もChatと同じ認可を使い、設定変更や検索結果の表示だけが別の保護境界にならないようにする。

## 10. レビューと検証

### 10.1 選定した検証

| 検証 | 理由・対象・command | 実行時期と成功条件 |
| --- | --- | --- |
| 文書 | 用語、相対リンク、Mermaid、`git diff --check` | 文書確定時。参照切れ・範囲矛盾・実装済みとの混同なし |
| lint | `pnpm lint`。変更責務のsource品質 | 実装のまとまりで一回。失敗は修正。小変更ごとには反復しない |
| 型 | `pnpm --filter @samurai-agent/web --filter @samurai-agent/desktop --filter @samurai-agent/server --filter @samurai-agent/workspace-server --filter @samurai-agent/room-permissions --filter @samurai-agent/runtime --filter @samurai-agent/core-schemas --filter @samurai-agent/domain-api --filter @samurai-agent/domain-operations run typecheck` | 共有型変更後と最終。実際に影響したpackageへ絞る |
| Artifact/Domain focused | `pnpm core:test:artifact`、`pnpm exec vitest run packages/domain-operations/src/operations/artifact/artifact-revise.operation.test.ts packages/domain-operations/src/operations/artifact/artifact-restore-revision.operation.test.ts packages/runtime/src/generated-surface-action-ingress.test.ts`と今回追加する対象test | B/D/E。競合・復旧・再送・失敗を確認。fake testは実PGの代わりにしない |
| Client/bridge focused | `RoomWorkSurface.test.ts`、`use-native-app.test.ts`、`NativeApp.test.ts`、`apps/web/src/lib/api.test.ts`、`apps/desktop/src/preload.test.ts`、今回のrenderer/request test | C–E。対象を指定して`pnpm exec vitest run`。draft・切替・操作・権限表示を確認 |
| Phase 5管理・契約focused | `apps/web/src/lib/workspace-room-tree.test.ts`、`workspace-room-capabilities.test.ts`、`apps/server/src/workspace-server/http-server-completion.test.ts`、`completion-contract.test.ts`、`packages/room-permissions/src/index.test.ts`、今回のReact管理/検索/設定/承認test | B/C。実際に変更した責務に絞り、基本管理の永続化・競合・認可・要求IDを確認。静的markupだけを操作検証としない |
| 自動化・共有入力の回帰 | `apps/server/src/adapters/runtime/postgres-runtime-automation.test.ts`、`apps/web/src/lib/collection-view-state.test.ts`と変更対象の既存test | B/C/E。job管理と型付き入力に変更がある時だけ実行。scheduler本体を変更しなければ全学習gateを反復しない |
| 契約とbundle検査 | `pnpm core:domain-contracts:verify`、`pnpm phase01:verify`、`pnpm core:test:generated-surface` | B/Eの共有契約変更後。生成物と実装が一致し、悪いbundleを拒否 |
| Build | `pnpm --filter @samurai-agent/web run build`、`pnpm desktop:build`、`pnpm desktop:verify` | UI/bridge統合後。React production entryとDesktop bundleを確認 |
| Vue削除・依存整合性 | V01–V15の参照調査、隔離環境の`pnpm install --frozen-lockfile`、最終typecheck/test/build | F。旧専用source・直接依存・型/plugin設定が残らず、共有機能の検証も成立。環境不足は削除gateの未検証として残す |
| 実PG・File Integration | 既存`pnpm verify:postgres-deep`と、今回の認可・revision・action・移植の追加シナリオ | B/F。隔離環境でDBとfileとeventを照合。実行条件不足は未検証 |
| 実Client/Agent E2E | 10.2。実Electron、実Native+Gemini、実保存 | F。各形式と主要操作を画面から通す |
| Accessibility | keyboard、フォーカス復帰、入力名、エラー通知、IME、狭い画面 | C–FのComponent/実UI確認にまとめる |
| 依存追加時の確認 | 新規依存のlicense、保守状態、`pnpm audit`結果の影響確認 | 依存選定時のみ。既知問題・未対応を記録 |
| 既存CI | `.github/workflows/ci.yml`の3OS契約/型検査とLinux統合gate | PR時。重い共通検証を各工程で重複しない。CI成功を3OSのNative GUI確認と同一視しない |

`core:test:generated-surface`等には既存reportを書き出すscriptがある。実装時は事前に副作用を確認し、他作業の証拠を上書きしない形で結果を保存する。今回の計画作成中はこれらのコード検証を実行しない。

新しいtestファイル名は責務の切り出しに合わせて決める。上表で「今回追加」としたものは存在済みcommandとして扱わない。性能は既存上限と対象データ量で応答・入力・スクロールを確認し、合意していない負荷目標を新設しない。

### 10.2 実使用シナリオ

本番や既存データへ書き込まず、repo外の専用DB・storage・Account・Roomを用いる。

#### Phase 5: App全体の確認

| ID | 実Clientから行う操作 | 照合する証拠・失敗条件 |
| --- | --- | --- |
| P5-01 | 初回接続→独立Workspace→既存/新規Agentを選んでRoom作成→依頼・添付・返信・コメント・委譲・停止 | 最終React/Electron bundle、DBの仕事/担当/添付ref、実Native+Geminiの結果。未設定Agent・失敗・停止未確認と復旧導線も確認 |
| P5-02 | 子Room作成、移動の影響確認・確定、人間の参加/解除・role変更 | 二つのAccountで親Room制約、最後のOwner、移動後の再認可、古いpreview、DM拒否を実PGと画面で確認 |
| P5-03 | 既存Knowledge/Wiki/Memory/Skillを開き、許可された編集・保管/復元・固定/有効状態変更を行い、仕事へ参照を添える | 資源種別/ID・本文・版・履歴・根拠が保持される。二人の競合、再表示、未許可Roomの検索/参照拒否。新しい自動学習の成立はこの確認に含めない |
| P5-04 | Room内検索から仕事・成果物・知識を開き、表示/出力言語・学習基本状態を変更する | 検索先と表示対象が一致し、抜粋も認可される。切替/再起動で設定scopeが混ざらず、未保存入力を保護 |
| P5-05 | 仕事の証拠と未解決の承認/入力要求を開き、許可・拒否等の応答後に再表示する | 隔離Domain操作から実際の要求を作り、永続decisionと実行/拒否結果を照合。再送・別Account・期限切れ・停止後・再接続で誤実行しない。実外部CLI由来の要求は別証拠 |
| P5-06 | 既存jobの予定・履歴を開き、停止→再取得→再開する | 実Serverのjob管理状態と履歴が一致。予約の停止を実行中Runの停止と誤表示しない |
| P5-07 | 複数Serverの切替、一方のoffline、再接続、App/Server再起動、権限失効、既存Workspaceの再表示 | 設定/知識/検索/draft/iframeの混入なし。旧データを読め、Vueを削除した最終bundleだけで成立 |
| P5-08 | ドパガキくんが主要な仕事と補助機能を操作する | Chatへ戻れる、必要な操作が見つかる、長い一覧と狭い画面でも操作可能。指摘を対象内/後続へ分け、合意した必須問題を解消 |

P5-01の既存仕事経路は変更・削除の影響に応じてまとめて確認する。新しい管理操作はモックだけで閉じず、P5-02–P5-06で実Serverの結果を照合する。Browserは共有React画面と署名済みbridgeの代表操作・失効を確認し、Desktop専用のcredential/移転機能をBrowserで成功と扱わない。

#### Phase 7: 成果物と操作画面の確認

1. React/ElectronでWorkspaceとRoomを選び、Native+Geminiへ文書・表・操作画面を依頼する。実Tool、Work、Run、保存ref、DB/fileを照合する。
2. 文書を開き、本文を人が変更・保存する。閉じて再表示し、変更後の内容と元の版を確認する。空内容も保存する。
3. 表のセルを変更・保存し、数値・真偽値・空値とrowの同一性が保持されることを確認する。
4. 文書の一節・表のセルを指定してAgentへ修正を依頼し、対象以外と出所・新revisionを確認する。
5. 実画像・PDFをAgentの許可された出力または添付から登録し、プレビューとダウンロードのbyte/hashを照合する。既存Backendが対応する修正・変換を実行し、元ファイルと修正版を確認する。新規生成能力と表示能力の証拠は分ける。
6. Agentが生成したHTMLを開き、グラフを絞り込む。フォームに入力して保存し、別の再表示と次のAgent依頼で保存先の同じデータを取得する。
7. Surfaceをpinして閉じ、同じRoomから開く。再生成後も入力先の保存データを保持し、古いSurfaceのactionは拒否する。
8. 二つのAccountとAgentで同じ文書・表を更新する。古い版の保存が拒否され、自分の下書きと先行変更が消えないことを確認する。
9. 他Room/DM/別Serverの参照、権限失効、偽frame、未宣言action、payloadの対象差替え、外部送信を拒否する。
10. 保存中の通信切断・応答消失・Server再起動後に同じ操作を再照会/再送し、二重保存と幽霊の成功表示がないことを確認する。
11. App/Server/DB再起動後に成果物・Surface・入力データ・履歴を再表示する。隔離した別Workspace ServerへのExport/Restoreで全revision、bundle、asset、保存先、出所の整合性を照合する。
12. 既存のRoom依頼・追加指示・コメント・委譲・停止・切替のうち変更の影響を受けた経路を回帰確認する。

追加重点: 6の保存操作では組込みフォーム/Collection表と生成HTMLの双方を実DBへ通す。承認が必要なactionはP5-05と同じ実要求/応答を使い、Surface更新後の古い承認を拒否する。旧版指定のAgent修正と、旧保存経路に頼らないことも確認する。P5と重なる再接続・権限・承認は共通シナリオの証拠を使い、同じ条件で重複実行しない。

実装担当はNative+Geminiを使用し、provider fallbackで検証結果を置き換えない。Codex/Claude Codeの公式認証による実CLI確認は利用者担当を維持し、必要な修正依頼・成果物取込み・再表示だけの手順を渡す。

Self-hostとHostedは結果を分ける。まず用意できる隔離Self-hostで技術E2Eを閉じる。実Hostedが用意できなければ未検証を残し、両配置対応の完成とは報告しない。Windows/Linux GUI、署名・配布物はPhase 10に残す。

### 10.3 証拠保存とGit操作前の停止

実装・検証を開始した時点で、`reports/`の規則に従う対象フォルダに条件・command・結果・未検証・利用者用手順を記録する。今回の読み取り調査と計画だけでは検証reportを作らない。

検証失敗は原因に対応する変更を行ってから該当範囲を再実行する。Agentレビューは実動作の代わりにしない。利用者へ変更内容、実装担当の技術E2E、本人担当の公式認証と操作感、未検証配置を分けて報告し、依頼されるまでcommit/push/PRは行わない。

## 11. 完了条件・未検証事項

### Phase別の完了条件

| 判定 | 必要条件 |
| --- | --- |
| Phase 5 技術確認完了 | R01・R11–R17とAppに関係するR07/R09/R10が成立。採用した管理・検索・設定・確認操作、基本の仕事と成果物入口がReactで使え、Vue専用source/直接依存の整理と削除後の検証が終了。初回・再起動・既存データの利用を実Client/PGで確認 |
| Phase 5 利用者確認完了 | P5-08の操作確認と、その場で必須とした使い勝手の問題を解消。技術確認だけで利用者確認まで済んだと扱わない |
| Phase 7 技術確認完了 | R02–R09と関係するR10/R15が成立。全対象形式の表示、文章/表の直接編集、Agent修正、Surfaceの実入力保存、履歴・競合・隔離・復旧・移植を実Client/PG/fileで確認 |
| 本プラン完了 | 上記とR01–R17の証拠が揃い、対象内の必須不具合・未接続・Vue残存がない。利用者確認を経て、Backend/OS/配置の未検証と後続担当を明示 |

Phase 5と7は番号・責務を分けて判定する。成果物パネルだけの成功や、旧機能を未分類のまま対象外にすることでPhase 5を閉じない。公式Codex/Claude Codeの本人認証・実CLI、未用意のHosted、Windows/Linux GUI・配布の検証は従来の担当/後続Phaseへ残し、本プランの実装時に確認するmacOS・Self-host・Native+Geminiと区別する。それらが未検証の間は「全Backend・全OS・両配置で製品完成」と報告しない。

### 共通の照合条件

- R01–R17に対応する入口、処理、保存、確認の証拠が揃っている。
- 文書・表・画像・PDF・HTMLをReact Appで開き、保存済みの同じ結果を再び確認できる。
- 文書・表の直接編集、対象を指定したAgent修正、Surfaceの入力保存が実際のDomain/DB/fileへ通っている。
- 版競合、権限失効、再送、途中失敗、再起動、移植を扱え、未確定の結果を完成扱いしない。
- V01–V15の採用/廃止/後続と参照元が記録され、採用機能の移行漏れ・動かないボタン・不要なVue実行依存がない。保存データを維持し、採用範囲の既存成果物・知識・Collectionは認可された入口から参照できる。Phase 8へ送る改善候補の専用UIはこのgateに含めない。
- 対象外機能を追加せず、利用者が操作確認できる。Backend・OS・配置別の未検証を明示している。

### 作成時点の証拠

確認済みは、会話の合意、正本・関連設計、列挙したsourceと既存test/script/CIの構造、参照資料である。既存testがあることは今回のtest成功を示さない。

今回の追加機能・廃止判断は4.1に示した評価をもとにした計画上の採用範囲であり、旧Vueの機能が全て現在も動くという意味ではない。新しいUIの詳細配置・library選定・公開型の追加名は技術的な実装事項として残す。採用範囲の削減、学習仕様や保存形式の変更が必要になった場合だけ、理由と影響を示して利用者と相談する。

コード実装、Migration、依存追加、実DB、実Agent、実Electron、Hosted/Self-host E2E、利用者dogfoodingは本プランに対して未実施。文書の構造・リンク・差分確認は作成後に行い、チャットで結果を報告する。
