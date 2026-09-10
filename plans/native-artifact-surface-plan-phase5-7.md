# Native App・Artifact・Surface 実装プラン — Phase 5残作業・7

- 作成日: 2026-09-07
- 更新日: 2026-09-10。機能E2Eを全てAI担当へ変更し、必須CI・製品方針・OSSコード品質を完了条件へ反映
- 状態: 元の製品範囲・要件・工程を維持。初回実装と一部の実機検証は存在するが、対象範囲の完了は未達。本改訂のコード修正・追加検証は未着手
- 調査基準: 現行HEAD `2cbf2b2d81caeb535df3eae264dd3712144de084`、計画改訂開始時の作業ツリーはclean。初回計画の調査HEADは `a7a8c174243bf7ee20d6b367afca821284b81ff9`
- 改訂範囲: この詳細版と簡略版だけ。設計書・コード・検証report・Git履歴は変更しない
- 対象: 元のNative AppロードマップのPhase 5の残作業とPhase 7
- 簡略版: [非エンジニア向けプラン](native-artifact-surface-overview-plan-phase5-7.md)
- 詳細設計: [Artifact・Surface](../docs/designs/artifact-surface.md)、[Native App](../docs/designs/native-app.md)

## 1. 目的・背景

Phase 0・1・2・3・4・6が完了したという利用者の申告を今回の開始条件とする。今回それらのPhase全体を再監査して完了判定を変更するものではない。

Phase 5では、今の製品設計に必要な操作をReact Appで完結させ、旧Vueの画面・専用処理・依存を整理する。旧Vueの全機能や画面構成を再現することは目的にしない。必要な機能を評価して採用し、不要な機能は移植せず廃止する。

Phase 7では、RoomでAgentが作った文書・表・画像・PDF・HTMLを開き、内容を確認して修正・保存できる体験を完成させる。必要なときに表やフォーム、グラフ等の画面が開き、人が入力したデータもWorkspaceに残るようにする。

既存React/Electronを継続する。「React Native App」という旧ロードマップの表記を、モバイル向けReact Nativeフレームワークへの移行と解釈しない。既に動くWorkspace・Room・Agent・仕事・接続の基盤を活用し、不足する管理・確認・設定の操作を加える。Reactが起動すること、Phase 7のパネルができることだけではPhase 5完了にしない。

本書のPhase番号は利用者提示の元ロードマップを指す。[Workspace-first・Organization再設計](workspace-first-organization-realignment-master-plan.md)のPhase番号とは別である。実装順序は本書内の工程A–Fで表し、元Phaseを改番しない。

今回の目的は、再レビューで挙がった問題を直すことに加え、当初のR01–R17、V01–V15、実使用シナリオの未接続・未検証を閉じることである。「指摘数がゼロ」「CIが成功」「代表的なSurfaceを一つ操作できた」だけで全体を完了にしない。既に成立している実装は再利用し、成果物の上書き・下書き消失・二重実行・中断復旧を先に修正する。

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
- 要件、元Phase、工程、完了条件を独断で省略・統合・改名しない。未合意の仕様・概念を追加しない。
- テストを通すために必須値を空値へ補完したり、認可・版・参照の検査を緩めたりしない。必要な移行互換と、不正な現行入力を区別する。
- 不具合を避けるために、合意済みの編集・再利用・移植・複数Server/Room・交換可能なAgentという製品能力を削らない。正規の操作を恒久的に読取専用へ変える、対象形式を狭める、複数接続を禁止する等を修正の代わりにしない。
- 内部実装の都合だけで、不要な承認、手入力の内部ID、利用者によるデータ修復、追加の運用手順を要求しない。制約は実際の認可・整合性・能力限界に必要な範囲へ限定し、理由・適用範囲・解除条件を説明できるものにする。
- 保存競合を防ぐためにアプリ全体を操作不能にしたり、再送を一律禁止したりしない。例えば保存中の一時的な編集抑止は当該bufferだけに限定し、無関係のRoom/仕事/閲覧を止めない。
- HTTP/IPC controller、React component/hook、巨大なRuntime分岐へ、データ整合性・認可ルール・業務判断を継ぎ足して解決しない。入口ごとに同じルールを複製したり、汎用helperへ移しただけで責務分離済みと扱ったりしない。
- 読みやすさを犠牲にする過剰な条件分岐、型の強制変換、例外の握り潰し、暗黙の副作用、循環依存、用途不明の抽象化を追加しない。品質改善のために無関係な全体リファクタリングへ広げることも禁止する。
- 画面操作による機能検証を利用者へ引き渡して完了にしない。実Electronの操作・生成・保存・再表示と必須CIはAIが実施し、主観的なUI評価の回答待ちを完了条件にしない。

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
| 今回の改訂 | 再レビューの21項目、接続切替の競合候補、追加変更の品質問題を扱い、元のPhase 5・7の全完了条件まで計画する。今は実装しない |
| 2026-09-10の検証担当変更 | 仕様どおりの機能・画面操作・実Electron E2E・必須CIは全て実装担当AIが実施する。利用者の主観的なUI評価は任意とし、完了条件から外す |
| AI生成の検証 | 前回の検証で使った、利用者提供のGemini APIキーを無料枠内で使用してよい。値を文書やログへ出さず、既存の安全な実行環境を利用する |
| 修正の品質 | 製品の本質を変える便宜的制約を追加せず、OSSとして第三者が理解・再利用・保守できる責務分離と安全な実装を守る |

### 3.3 今回の技術提案

以下は上記を実現する具体案であり、利用者がライブラリ・内部schema・API名まで指定したという意味ではない。

- Markdown文書、構造化した表データ、既存Generated Surfaceを主な編集・表示モデルにする。
- Chat横のパネル、Roomの成果物一覧、手動保存、版比較と復元を既存構造から具体化する。
- Surfaceの保存先は既存ArtifactまたはCollection等のDomain資源へ固定する。
- Clientを共通Domain APIへ接続し、本文の大きさ・binary配信は認可されたFile APIと分担する。
- 機能検証の担当は3.4の最新合意に従う。Native+Geminiによる生成と実Client操作をAIが行い、利用者の操作確認票を要求しない。
- Phase 5の採用範囲は4.1の評価表を実装基準にする。Knowledge/Skillの基本管理、Room管理、検索、必要な設定、実行確認、自動化の基本管理を加える。学習アルゴリズムや専用業務アプリ群は追加しない。
- 各補助機能はRoomの文脈から必要時に開く。旧Vueの常設メニュー群を再現せず、Chatと補助パネルに戻れる導線を揃える。
- 本改訂では、下書きの対象・基準版固定、保存中の編集抑止、送信先を伴うIPC、既存の永続記録を使った操作再照会を具体案とする。製品機能の追加ではなく、既存の保存・認可・復旧要件を満たす方法である。内部の型名や小さなmodule分割は実装判断に残す。

### 3.4 最新合意による担当・完了条件の変更

2026-09-10の利用者の明示指示により、前版の本人操作を必須にした条件を次のように変更する。R01–R17、V01–V15、工程A–F、P5/P7/Tの番号は維持し、機能範囲は削減しない。関連設計書に残る旧担当の記述より、この会話の最新合意を優先する。今回、設計書自体は変更しない。

| 前版の項目 | 今回の対応 | 完了への影響 |
| --- | --- | --- |
| P5-08: 利用者の主要操作確認 | 同じIDでAIによる全必須機能の実画面操作・客観的な操作性のE2Eへ変更 | AIの操作記録と保存結果が必須。利用者の検証作業は不要 |
| Phase 5 利用者確認完了 | Phase 5 画面操作E2E完了（AI担当）へ変更 | 本人確認待ちのgateを廃止 |
| 工程F: 統合E2E・dogfooding・完了判定 | 工程F: 統合E2E・品質確認・完了判定 | 実操作、第三者視点の品質確認、対象commitの必須CIをAIが閉じる |
| 見た目・好み・心地よさの本人評価 | 任意の主観的feedback | 未実施でも本プランの完了を妨げない |
| 必須CIはPR時に別途確認 | 同じ最終実装commitに対する既存必須CIの成功を本プラン完了条件へ追加 | CI待ち・失敗・必須jobのskipを完了としない |
| 外部Backendの機能確認を利用者へ依頼 | 今回の変更対象の機能確認はAIが担当。本人にしかできない認証操作が必要な場合だけ最小限の入力を依頼 | 機能テストの代行を利用者へ戻さない。Backend別の実証と環境不足は10.2で区別 |

製品内で「本人の応答」「利用者の操作」と書く場合は、テストAccountを操作するAIがその手順を行う。実ユーザーの承認を捏造したり、認可を省略したりする意味ではない。merge等のリポジトリ公開操作の許可は、機能の本人確認とは別に扱う。

## 4. 現行実装と不足

以下は2026-09-09のsource・test・既存reportの読み取り結果であり、この改訂で実行したテストの結果ではない。

| 責務 | 確認したファイルと事実 | 今回必要な作業 |
| --- | --- | --- |
| Reactと管理 | `apps/web/src/native-app/NativeApp.tsx`、`NativeKnowledgeTools.tsx`、`use-native-knowledge-tools.ts`、`NativeInteractionRequests.tsx`に管理・確認パネルがある | Knowledge作成、全ページ、検索先、拒否、下書き保護などの不足を補う |
| 成果物UI | `ArtifactSurfacePanel.tsx`、`NativeArtifactWorkspace.tsx`に表示・編集・履歴・復元と結果カードからの入口がある | 資源切替、基準版、保存後の現在版、画像/PDF修正依頼を修正 |
| Collection/Surface UI | `NativeCollectionPanel.tsx`、`GeneratedSurfaceFrame.tsx`に入力・action・固定・exportがある | 競合、同一操作の再送、結果/data/assetの反映、stateと保管導線を完成 |
| 公開API/bridge | `apps/server/src/workspace-server/domain-api-v1.ts`にArtifact/Surface/interactionの公開経路、Desktopに要求処理中の接続snapshotがある | R12–R16の旧専用経路を公開Query/Operation/Eventへ接続。IPC受付前の切替も対象固定で防ぐ |
| Artifact保存 | `apps/server/src/adapters/runtime/postgres-artifact.ts`にimmutable revision、blob、File Transactionがある | create/revise双方のbinary変換と保存結果・参照を揃える |
| Runtime/仕事確定 | `http-server.ts`にArtifact/Surface tool、`apps/server/src/workers/postgres-room-work-worker.ts`に結果ref集約がある | 同一Run内の複数版と保存済みの終端証拠を、通常完了/再起動復旧で同じ意味にする |
| 参照/移植 | `packages/workspace-server/src/workspace-server-store.ts`、`schema.ts`、`workspace-completion-bundle-v4.ts`に認可・仕事・Bundleがある | mutableな現在pointerとimmutableな結果を分け、work/instructionのresource_refsを移植 |
| 承認/入力復旧 | `workspace-interaction-request-service.ts`とmaintenance workerがpending期限切れ・executing中断を処理する | accepted直後の中断と、停止済みRunへの入力を正しく終端化・回収 |
| 既存UI test | `ArtifactSurfacePanel.test.ts`、`native-artifact-workspace.test.ts`、`native-knowledge-tools.test.ts`、`native-interaction-requests.test.ts`等は静的markupと関数testが中心 | mount後の編集・再render・遅延保存・操作を検証するComponent testを追加 |
| 旧Vue | 既存reportではVue source 0と境界検査成功を記録。現行の対象UIはReact | 旧実装を復活・再削除せず、採用した挙動の移行漏れと最終build graphを確認 |

### 4.1 Phase 5の機能評価と処置

次のV01–V15は2026-09-08時点の旧機能の採用・廃止判断を維持した表である。列内のVueファイル名と不足の記述はその時点の評価であり、現在もファイルが存在するという意味ではない。初回実装で削除されたsourceはGit履歴を必要な箇所だけ参照し、復活させない。工程A/Fで各Vの現在のReact入口・検証証拠を対応付け、採用済み挙動を削除済みファイルと一緒に失わない。

| ID | 旧source・機能（初回評価時点） | 評価と今回の処置 | 到達先・要件 |
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

- [初回実装の検証記録](../reports/native-artifact-surface-phase5-7/report.md)に、自動test/build、隔離PGでの各形式の作成・更新・再起動、実Desktop/Native+GeminiからのArtifact/Surface生成・action・再起動成功がある。途中のGemini 503は後日の成功記録で解消されている。
- 同reportの代表経路の成功を、R01–R17すべての実Client操作の成功へ拡張しない。report末尾の「上記以外は実施済み」という総括だけでは、人の直接編集・競合・移植・全管理導線の証拠にならない。工程Aで証拠の対象commit・Client・操作・保存照合を記録し、修正で影響する経路は更新する。
- [Phase 3・4・6の検証記録](../reports/room-agent-collaboration-phase3-4-6/report.md)はR11の再利用基盤。今回その全Phaseを再実装・再監査しない。
- Knowledge・検索・自動化などの旧workspace bridgeは実処理を持つが、R12–R16の不足する公開Query/Operation/Eventも元から今回の必須範囲。Phase 9へ先送りしない。旧互換APIも同じ認可・サービスを利用する。
- 「旧Wiki全体を開けない」は採用しない。WikiはCompletion Knowledge上のprojectionであり、その経路を確認済み。旧Memoryを含む資源種別・metadata・履歴・管理操作の保持はV03の検証で別に確認する。

### 4.3 再レビューの指摘台帳

I01–I13は前回13項目、I14–I21は今回追加した8項目に一対一で対応する。I22は再現未実施の競合候補、I23は追加変更の契約品質問題であり、確認済みの実行障害と同数扱いしない。全項目が本改訂時点で未修正。下記の検証T01–T11は10.2の追加シナリオを指す。

| ID | 問題と成立条件 | 主な対象 | 要件 / 工程 / 検証 |
| --- | --- | --- | --- |
| I01 | 表Aのdirty stateを表Bが引き継ぎ、BのID/現在版でAの内容を保存する | `ArtifactSurfacePanel.tsx` | R03・R04・R07 / C・D / T01 |
| I02 | Collection再取得でexpected versionだけ進み、古いdraftが他者変更を上書きする | `NativeCollectionPanel.tsx` | R03・R04・R06 / D・E / T02 |
| I03 | target object/gatewayの再生成が同一Roomのパネル初期化を起こす | `NativeApp.tsx`、`NativeArtifactWorkspace.tsx` | R03・R08・R11 / C・D / T01 |
| I04 | 同一Runの作成→改訂で旧論理refも集約し、現在pointerとの照合で仕事確定が失敗する | `postgres-room-work-worker.ts`、`workspace-server-store.ts` | R02・R04・R09 / B / T04 |
| I05 | Surface再試行で新operation IDを作り、副作用が重複し得る。Collection作成も対象 | `NativeArtifactWorkspace.tsx`、`NativeCollectionPanel.tsx` | R06・R09 / B・E / T06 |
| I06 | 結果カードの初期revision指定を保存/復元後も再使用し、古い版を表示する | `NativeArtifactWorkspace.tsx` | R02・R04 / C・D / T01 |
| I07 | 数値セルを空欄にして再入力すると文字列になる | `ArtifactSurfacePanel.tsx` | R03 / D / T02 |
| I08 | Native toolのbinary作成で配列をbyteへ変換せずJSONとして保存する | `http-server.ts`、`postgres-artifact.ts` | R02・R05・R09 / B / T05 |
| I09 | Bundleのexport/restoreがwork/instructionのKnowledge/Skill参照を落とす | `workspace-completion-bundle-v4.ts`、`schema.ts` | R09・R12 / B / T10 |
| I10 | Surfaceの結果/data/asset反映、現在state更新とarchive導線が不足 | `GeneratedSurfaceFrame.tsx`、`NativeArtifactWorkspace.tsx` | R06・R08・R09 / E / T06 |
| I11 | 終了・取消済みRunへの入力が配送されなくても要求をcompletedにする | `domain-api-v1.ts`、`run-control-service.ts` | R15 / B・C / T07 |
| I12 | 検索結果に仕事・履歴・成果物のopen先がなく、Appにもhandlerが未接続 | `NativeApp.tsx`、`use-native-knowledge-tools.ts` | R14 / B・C / T08 |
| I13 | Knowledge作成UIがなく、無効Skillが一覧から消えて再有効化できない | `NativeKnowledgeTools.tsx`、Completion service | R12 / B・C / T08 |
| I14 | 閉じる・Room/資源切替で未保存入力を確認なく破棄する | Artifact/Knowledge/CollectionとAppの離脱処理 | R03・R08・R11・R12 / C・D / T03 |
| I15 | 表/Knowledgeの保存中に追加入力できるが、完了処理でその入力を消す | editor、`use-native-knowledge-tools.ts` | R03・R12 / C・D / T03 |
| I16 | Run終端後・仕事確定前の再起動で、復旧経路が結果refを回収しない | `postgres-room-work-worker.ts` | R02・R09 / B / T04 |
| I17 | 画像/PDFにAgent修正依頼の操作がない | `ArtifactSurfacePanel.tsx`、Room Work入力 | R05 / C・D / T05 |
| I18 | 一覧の次cursorを使わず、検索した一覧外Knowledgeも開けない | Completion Query/bridge、Knowledge hook | R12・R14 / B・C / T08 |
| I19 | backend入力の拒否にも入力値検証・添付を行い、空欄/入力済みの双方で失敗する | `NativeInteractionRequests.tsx`、interaction service | R15 / B・C / T07 |
| I20 | 応答をacceptedへ保存した後・実行claim前に中断すると回収されない | interaction service、maintenance worker、Domain API | R09・R15 / B・C / T07 |
| I21 | 採用済み管理機能の公開v1接続が不足し、旧専用APIが主経路に残る | Domain API/registry/台帳、Desktop/Browser bridge | R12–R16 / A・B・C / T09 |
| I22 | 接続確認とIPC受付の間で切替が起こると、別Serverに同ID資源がある場合に誤送信し得る | `native-workspace-target.ts`、Desktop main/preload、Browser bridge | R07・R09 / B・C / T11 |
| I23 | 必須のRuntime結果配列を`?? []`で補い、欠落と正常な空結果を区別しない | `postgres-room-work-worker.ts`、`RunChatTurnResult`、test fixture | R02・R10 / A・B / T04 |

I22は工程Aで遅延を制御した再現testを作り、成立時は修正、非成立なら保護する実経路と反証testを記録する。I23は現行productionで欠落が起きると断定せず、必須契約とfixtureの一致を回復する。いずれも無言で対象外にしない。

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

### 6.1 OSSとして守る責務分離と再利用性

第三者が単一の入口を読めば呼出し先と契約を追え、同じ業務ルールをNative App・外部Client・Runtimeから再利用できる構造にする。データ整合性をcontrollerの呼出し順序だけに依存させない。

| 層 | 持つ責務 | 持ち込まない責務 |
| --- | --- | --- |
| React component/hook | 表示、入力buffer、選択・保存中・失敗状態、操作要求の組立て | 権限の最終判断、DB整合性、仕事完了の判定、保存済み結果の捏造 |
| HTTP/IPC controller・bridge | wire入力検査、認証由来contextと捕捉targetの受渡し、共通サービス呼出し、型付き結果/安全なerrorへの変換 | revision整合・重複排除・参照解決・復旧の独自実装、直接の複数DB/file更新 |
| Domain Operation / application service | Room認可、対象/版/参照の業務条件、操作の同一性、処理順序とtransaction境界の統括 | HTTP/React/Electronへの依存、別入口専用の例外、永続化方式を混ぜた巨大関数 |
| Repository / PostgreSQL・File adapter | 条件付き更新、制約、transaction、immutable revision、File Transaction、永続記録の取得 | UI文言・表示状態、利用者が押したbuttonを権限証明とする判断 |
| Runtime / worker | 認可済み実行の調整、保存証拠の回収、claim・再開・終端の制御 | controllerと重複する業務ルール、結果不明の副作用の無条件再実行 |

- 既存のservice/port/adapterを優先し、今回触る責務だけを適切な既存moduleへ切り出す。`http-server.ts`、`domain-api-v1.ts`、Desktop main、NativeApp周辺にある大きな処理は、今回の変更が関わるルールから分離する。全ファイルの行数削減や新しいフレームワーク導入を目的にしない。
- 公開入力、Domain入力、保存record、表示用projectionを型で区別する。状態遷移・option・結果を判別可能にし、必須項目を`any`や二重castで通さない。重複した業務条件は一つの責務に集約する。
- 名前は既存の製品/Domain用語に合わせる。副作用、transaction範囲、版競合、再送、失敗後の状態、互換理由を、型・短い説明・意味のあるtestから第三者が追えるようにする。
- 認可と整合性は全入口から同じサービスで検査し、DB制約/条件付き更新でも競合を防ぐ。Clientの検査は操作支援であり、Serverの検査を省く根拠にしない。本文・path・frame messageを未信頼入力として扱い、credentialや内部errorを公開結果へ漏らさない。
- 再利用性は、既存の複数入口が同じサービスを呼び、HTTP/GUIなしでもその業務条件をtestできることを基準にする。仮想の将来用途だけを理由に汎用基盤を増やさない。

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
| R10 実使用と既存機能回帰 | 5・7 | F | AIが行う実画面操作E2E、Backend別・Client別・配置別の結果、OSS品質確認、対象commitの必須CI |
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

各工程は既存実装の差分修正として実行する。以下の元の実装項目は残すが、成立済みの機能を作り直す指示ではない。Aで指摘と証拠の台帳を固定し、Bで保存・参照・復旧・公開契約、Cで対象固定と管理導線、Dで編集、EでSurface、Fで実使用と全体判定を閉じる。Bの契約が固まる前にC–Eが独自の暫定APIを増やさない。

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
8. I01–I23を現在の実行経路とtestへ結び付ける。I01–I21は再現条件と期待動作を定義し、対応工程で修正前に再現testを用意する。同じ原因のtestはまとめ、Aで全機能のtestを一括実装しない。I22はIPC受付前/後を別々に遅延させ、別Serverに同じworkspace/resource IDを置いた境界で反証も可能にする。製品にtest専用の動作分岐は設けない。
9. 追加変更を「契約上必要な補強」「不具合修正」「互換」「test fixture修正」に分類する。Vitest/coverage更新、Desktop snapshot、出所/参照の追加を一括で戻さず、I04/I06/I23を生んだ箇所だけ是正する。既存のMigration v126/v127等を削除・書換えしない。
10. UI test基盤を確認する。静的markupを維持しつつ、実React Componentをmountして操作できる最小のDOM環境を追加する。新しいtest依存が必要ならtest用途に限定し、runtime依存・汎用E2E基盤の全面刷新はしない。
11. 実装記録に、Rごとの入口→公開契約→保存先→Event→実使用シナリオ→証拠を作る。IのないR13/R16等も空欄を許さない。過去の成功は対象commitを付けた背景資料とし、今回の完成証拠へ転記しない。最終gateは修正後の対象コードに対する証拠で閉じる。
12. 変更対象の業務ルールと保存不変条件を6.1の各層へ割り当て、controllerの新しい分岐へ押し込まない構成を決める。新しい制約を提案する場合は、製品上の根拠・必要な範囲・解除条件を示し、入力snapshotや条件付き更新など機能を保つ方法で解決できないか確認する。

**境界:** Office互換や任意のアプリ構築へ広げない。HTML生成を学習ループと結合しない。

**検証・セルフレビュー:** 全てのRに入口、保存先、参照元、確認方法があるかを文書で照合する。未確定の技術選定を実装済みと書かない。

**完了・次工程条件:** 必須経路の未分類がなく、R01–R17/V01–V15/I01–I23を追跡できる。I22の判定方法と再現用境界、最小のComponent test手段、公開契約の不足が具体化されている。製品範囲を変える問題があればその点だけ相談し、通常の実装判断は担当が具体化してBへ進む。

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

#### B.1 結果参照・仕事確定・復旧を揃える（I04・I16・I23）

- `postgres-room-work-worker.ts`、`workspace-server-store.ts`、`packages/runtime/src/agent-runtime.ts`の通常完了と復旧を同じ参照規則へ接続する。論理Artifactの同一性、保存されたrevision、表示用の現在版pointerを分ける。
- 同一Runで作成→複数回改訂した場合は、そのRunが確定したrevisionとの関係を保存し、変更後の現在pointerだけで過去結果を不正扱いしない。カードをまとめる場合も中間revisionと出所の証拠は失わない。URI/labelの一致条件を単に削るのではなく、Server側で資源・revision・Room・出所を解決する。
- 他Run/人による後続編集・改名があっても、元の仕事を失敗にせず元の結果を開ける。他Roomのref、存在しないrevision、取り違えた資源は引き続き拒否する。
- Runtimeの保存済みRun・event・operation・revisionから結果を再構成し、Run終端後・仕事確定前の停止でも正常完了と同じrefを回収する。既存の`projectChatTurn`等の保存履歴projectionを調べて再利用し、復旧のためにAgentを再実行しない。証拠が足りなければ既存の不明/失敗状態に理由を残す。
- `RunChatTurnResult`の必須配列は正常時も全て返す。成果物を作らない正常Runは明示的な空配列で成功し、必須配列の欠落・不正refは境界でエラーにする。legacy adapterの実利用がある場合だけadapter内部に明示した互換変換を置く。fixtureを完成した型へ直し、productionで`?? []`を重ねて補わない。

#### B.2 Binaryと可搬参照を保存する（I08・I09）

- Native tool、公開Artifact Operation、adapterのcontent/encoding/MIME境界を統一する。create/reviseで同じ正規化を使い、byte配列は整数0–255・サイズを検査して実byteへ変換する。base64とtextを区別し、実内容と矛盾するMIME・壊れた入力は保存前に拒否する。
- `workspace-completion-bundle-v4.ts`のexport列、型/検証、`schema.ts`内のimport関数、`workspace-server-store.ts`の参照検査を一続きで変更する。work/instruction両方のresource_refsと参照先のID・版・scopeを保持する。指示の有効条件も現行作成契約と揃え、旧attachment/body条件のまま現行の有効な指示を拒否しない。
- 適用済みMigrationの本文は変えず、新しい追記Migrationでimport関数等を更新する。空DBへの適用と現行DBからのupgradeを分けて確認する。
- 旧Bundleに存在しなかったrefと、新Bundleにあるはずのrefの欠落・不正値を区別する。既存versionの互換方針とmanifest検証に従い、必要なversion/feature識別を追加する場合はexport/import/公開schemaを同時に更新する。旧Bundleの正規な欠如だけを空として扱い、既存資源の参照を推測で生成しない。
- 別Serverへの復元では接続URLを再解決し、元Serverの一時URLや認証情報を持ち込まない。不正参照を含むimportは既存のtransaction/abort/cleanupで失敗させ、部分的な成功にしない。

#### B.3 公開契約と送信先を固定する（I12・I13・I18・I21・I22）

公開接続の対象は次の表の全行。既存契約があれば接続と不整合を直し、未実装分だけ追加する。公開の名前は既存registry・生成規則へ合わせ、ここに仮のURLを正規仕様として新設しない。

| 責務 | Query | Operation / Event | Clientでの照合 |
| --- | --- | --- | --- |
| Knowledge/Skillと旧資源 | scope・kind・archive状態・cursorを持つ一覧、detail/body/version/evidence、Skill本文 | Knowledge作成/編集/保管・復元/固定、Skill本文編集・有効状態、旧資源の対応済み管理操作。確定後に公開Event | 管理画面、仕事へのref、全ページ、再接続 |
| Room/人間membership | 移動・membership影響確認、現在の権限/版 | 既存作成/移動/参加/解除/role。現在版・権限の再検査とEvent | 既存Room管理の公開接続を確認し、重複新設しない |
| Room検索 | 認可した仕事/履歴/Artifact/Knowledge、kindとopen先ref | 検索はreadのみ。更新通知後は必要なQueryを再取得 | 抜粋の認可、旧履歴、削除済み、一覧外の結果 |
| 必要な設定 | 表示/出力言語、学習基本状態とWorkspace/Room scope | 既存設定変更/Room上書き解除とEvent。端末local preferenceは既存の保存責務を維持 | 対象Server/Account/scopeの一致、再起動 |
| 既存自動化 | 一覧・次回予定・管理状態・履歴 | 停止/再開とEvent。実行中Run停止を代行しない | Server再取得・旧状態からの操作・権限失効 |
| 承認/入力・操作再照会 | pending/accepted/executing/結果と、本人に認可された同一操作の保存結果 | 応答/取消/実行claim/終端/中断の既存契約を補完 | 受付と実行結果、同一操作の再送、再起動 |

- `packages/domain-api/src/index.ts`、`packages/domain-operations/src/operations/`、公開registry/catalog、生成Client/spec/台帳、Server dispatch、Desktop/Browser bridgeを同時に揃える。処理がない項目を公開catalogへ広告しない。旧互換入口は同じサービスへ委譲し、利用元確認なしに削除しない。
- 管理用Skill一覧は実行時の有効Skill検索と分け、無効/保管済みも必要な権限で取得できるようにする。ページング前にscope/kind等を絞り、Room資源で埋まった先頭ページからWorkspace資源をClientだけで探す形にしない。
- Desktopは更新要求自体に捕捉したconnection/workspace targetを含め、preloadの検査を経てmainで照合し、そのsnapshotに束縛したclientで実行する。呼出し時のactive接続への読替えは禁止する。Browserも署名・認証を含む送信先を同じ要求targetに固定する。
- main受付前の不一致は送信前に拒否する。受付後の切替で、既に正しい旧targetへ出した操作を新targetへ再送しない。応答と結果再照会は旧target/operationに対応付け、新画面へ混ぜない。I22の再現が非成立でも、実際の保護をT11で固定する。

#### B.4 同一操作と承認・入力の復旧（I05・I11・I19・I20）

- 一回の利用者操作にtarget・資源/版・action・入力内容・operation IDを結び付け、送信失敗後の再試行では同じIDと同じ入力を使う。別の明示操作だけに新IDを発行する。内容が変わった同一IDの要求は拒否する。
- Client再起動後の結果照会は既存Operation/interaction/Domain結果の永続記録から行う。本人に認可された対象資源・actionの操作履歴から該当するoperationを解決し、同じIDの結果を再表示する。操作を一意に特定できなければ結果不明として再確認へ戻し、入力が似ているだけで同一操作と推測しない。不足するread経路だけ公開契約へ追加する。Clientにcredentialや本文を保存する汎用outbox、新しいjob基盤は作らず、結果不明の作成を新IDで自動再送しない。
- 入力応答optionの意味をServer発行の型で伝える。`submit_input`だけ入力値を検証・添付し、denyでは空欄検証も入力添付もしない。ラベル文字列から判断しない。Serverはoption IDから再判定する。
- Run Controlの返り値と保存された配送証拠を照合する。終端Runへのno-op/replayを新しい配送成功と数えず、停止/取消/期限切れ/非対応は既存の失敗・取消等の状態と理由で示す。過去に同じ操作で実配送済みの再照会だけを成功の再表示にする。
- `accepted`の保存後にプロセスやEvent配信が落ちても、既存maintenance/claim経路が回収する。実行前に同じ要求の現在権限、期限、停止、対象版を再検査し、未実行で許可された操作だけを同じIDで一度claimする。`executing`の副作用が不明なら従来の中断/失敗扱いを維持し、無条件に再実行しない。
- `workspace-interaction-request-service.ts`、`workspace-interaction-request-maintenance-worker.ts`、`domain-api-v1.ts`、`run-control-service.ts`で受付・実行・Event・結果照会を整合させる。応答後の再接続もポーリング/公開Event再取得で追跡し、受付済みのボタンを再送不能のまま放置しない。

**検証:** Artifact/Domain/RuntimeとR12–R16のfocused test、型検査、実PGで初期版・競合・再送・中断復旧・認可拒否・binaryの往復を確認する。Room影響確認後の版変更、承認の二重応答、検索結果への非許可情報の混入も対象とする。

**セルフレビュー:** schemaが存在するだけで未接続のcommandを広告していないか。target commandとイベントが同じoperationを指すか。初回保存前の内容が失われないか。厳格な検査を削ってI04を隠していないか。正常な空結果と壊れた戻り値、未実行と結果不明の副作用を区別しているか。HTTP/IPC/Runtimeの入口に同じ業務条件を複製していないか。transaction・認可・条件付き更新が適切なサービス/保存層で守られているか。

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
11. `NativeKnowledgeTools.tsx`とhookにKnowledge新規作成、全ページへの到達、保管/無効Skillの再表示と再有効化をつなぐ。検索からは一覧への事前読み込みを必須にせず、返された資源refをdetail Queryで再認可する。旧Wikiのmetadata・履歴・種別を保持し、旧Memoryの読取/保管経路もP5-03で確認する。
12. `NativeApp.tsx`に型付き検索先のhandlerを接続し、仕事/旧履歴/Artifact/Knowledgeごとの入口へ遷移する。別Roomへ黙って切替えたり、仕事のない履歴を架空の仕事へ変換したりしない。削除・失効済みは理由を表示する。
13. 下書き保護は成果物・Knowledge/Skill・Collection・依頼入力・対象設定の共通の離脱方針に揃える。通常の閉じる、資源/Room/Workspace切替、アプリの通常終了に保存・破棄・戻るを接続する。OS強制終了後の未保存本文の永続復旧を新しい必須仕様にはしない。権限失効時には保存を許さず、別scopeへの持出しや共有キャッシュ保存で代替しない。
14. `NativeInteractionRequests.tsx`はB.4のoption型と保存結果を使い、拒否は入力不要、受付と実行完了は別表示にする。再接続後にaccepted/executingも再照会し、停止・期限切れ・失敗を完了表示で隠さない。

#### C.2 成果物の表示とPhase 7への接続

1. 仕事の結果カード、Roomの成果物一覧、Chat横の表示パネルをReactで実装する。個別renderer・controllerを分け、既存の大きいhookへ全責務を集中させない。
2. Markdown、表、画像、PDF、chart、生成HTMLを種類に応じて表示する。HTMLを親DOMへ挿入しない。対応不能・破損・大きすぎる結果は原因と安全なダウンロード/fallbackを示す。
3. Desktop/Browser双方のbridgeへ必要なQuery/Operationを実装し、表示開始時のconnection/workspace/Roomを固定する。非同期応答が別の選択へ混入しないようにする。
4. 閉じる・再表示・狭い画面・keyboard操作を用意する。編集中はAgentの新しい成果物が表示を奪わない。
5. ダウンロードは実byte・適切なfilename/MIMEを使う。Object URL、iframe、購読を切替・権限失効・終了時に解放する。
6. production entryとbuild graphを確認し、対象導線が旧Vue画面へ戻らないことを確かめる。
7. 同じconnection/workspace/Roomの再renderやEventではcontroller/gatewayを再生成・初期化しない。依存をprimitiveなtargetの同一性で安定させ、資源変更時は離脱処理を経て別の編集状態を開く。`key`の追加だけでdirty stateを破棄する修正にはしない。
8. 結果カードからの初回表示は指定された過去版を尊重する。人が保存/復元した後は返された新revisionを表示中の版・現在版へ反映する。元の仕事の保存済みrefと履歴は書き換えず、次の編集も実際に読んだ版から行う。

#### C.3 Vue整理の開始

V01–V15ごとに採用機能のReact入口と検証結果を記録する。既に削除されたVueは再導入しない。残存する専用処理があれば共有関数の利用元を確認して整理し、移行漏れはReact/共通契約へ補う。最終的な依存・test設定・CSS・型宣言の確認と、削除後の挙動をFで閉じる。

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
8. editorはtarget/resource ID、読み始めたbase revision/version、buffer、dirty、送信中snapshotを一組として持つ。refreshでserver snapshotだけが更新されてもdirty bufferとbaseを進めない。Collectionのversion Mapをdirty rowのbaseとして代用しない。
9. 保存要求は捕捉した対象とbaseから組み立て、現在選択中のpropsから資源IDを補完しない。競合なら最新内容と比較できる状態で保持し、再読み込み/破棄は明示操作にする。成功時は送信した対象・世代のbufferだけを確定し、別資源のbufferを消さない。
10. 保存中は当該bufferの本文・表・Knowledge/Skill編集だけを一時停止し、二度押しを同期的に防ぐ。IME確定前に送信せず、保存完了まで画面離脱で結果を取り違えない。他の仕事・Room・閲覧を一律に止めない。追加入力を許す実装を選ぶ場合は送信snapshotと新bufferを分けて保持し、機能を保てる既存実装があれば一律の無効化へ戻さない。
11. 表の型は現在セルの値だけで推測せず、保存schemaまたは読み込み時の列型を保持する。数値→空欄→数値、0、false、nullを区別し、無効な数値を文字列やNaNへ黙って変換しない。schema不明/安定row IDなしは既存の読取制限と理由を維持する。
12. 画像/PDFにも共通のAgent修正依頼欄を置き、対象ファイルref・revision・説明をRoom Workへ渡す。画像/PDFの手動編集は追加しない。実Backendの対応能力を検査し、未対応の説明と実際に対応する修正経路の検証を分ける。

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
11. `GeneratedSurfaceActionRequest`とcallbackの結果型を、B.4のoperation ID・相関ID・保存結果/失敗へ接続する。iframeの相関IDは権限やoperation IDとして盲信せず、親が保持する操作へ束縛する。request→responseの対応を検査し、承認待ちは保存成功として返さない。
12. 保存完了後は新しいデータ/版を公開Queryから再取得し、対応するframeと親画面へ返す。別actionの失敗・旧frameの応答を現在のフォームへ適用しない。通常のdata更新でframeを作り直して未送信入力を消すことも避ける。承認が必要なactionも終端結果まで追跡して反映する。
13. bundle内のassetは認可済みの同じrevisionから読み、検証済みpath・MIME・サイズで参照を解決する。外部URL、path traversal、active content、credentialの持込みを拒否する。表示とHTML/ZIP書出しで必要assetの整合を確認し、切替・失効・終了時にObject URL等を解放する。CSPの任意network解禁で表示を直さない。
14. pin/unpin/archiveの成功時はServerが返すstateで一覧と開いているdetailを更新する。archive操作を親UIへ用意し、archive後は保存済み履歴を保持してactionを停止する。pin直後のunpin、再表示、旧版action拒否まで通す。
15. Collectionの追加/更新/削除も同じ再送規則を使う。作成中のrecord IDとoperation IDを保持し、応答消失で別recordを作らない。I02のdirty base・型付きbufferをDと共用し、refreshの自動version更新で競合検査を迂回しない。

**検証:** bundle検査、frameなりすまし、CSP/sandbox、入力改ざん、二重click、応答消失、revision更新、承認、実DB保存と再表示を確認する。

**セルフレビュー:** script文字列検査だけを安全性の証拠にしない。HTMLの入力値が保存されただけで対象データ更新済みと扱わない。pinとデータ保存を混同しない。

**完了・次工程条件:** R06–R09が実Clientから閉じ、Fで全体を通せる。

### 工程F: 統合E2E・品質確認・完了判定

**目的:** AIが実アプリを操作して合意した全必須機能を一つずつ確認し、コード品質と必須CIまで揃えて、利用者の機能検証なしで完了を判定する。

**対象:** 本書全体、既存回帰test、実Electron・実PostgreSQL・実ファイル・実Agent、既存Workspace Export/Restore。

**作業:**

1. V01–V15の全項目を、Reactで検証済み/不要として削除/後続Phaseへ機能を引継ぎ、のいずれかで閉じる。後続扱いでも旧Vue実装を実行経路やテスト専用runtimeとして温存しない。保存済みデータと共有Coreは独立して保持する。
2. `App.vue`、`AppWorkspace.vue`等の削除済みsourceは履歴と現在のbuild graphで確認する。残存がある場合だけ用途を確かめて整理する。旧`CustomViewFrame.test.ts`、`CollectionWorkspaceView.test.ts`等が担った認可・入力・隔離の検証がReact/共通契約で実行できることを照合し、廃止機能だけのtestは削除理由を対応表に記録する。
3. ルートと`apps/web/package.json`の不要Vue依存、`vitest.config.ts`のVue plugin、WebのVue型宣言とtsconfig対象、Vue前提のscript・生成物を整理し、lockfileを正規手順で更新する。Vueが推移依存として残る場合も由来を確認し、Samuraiのruntime/testの直接依存が残っていないことを説明する。
4. `apps/web/src/styles/app.css`から未使用の旧selectorだけを削除する。Reactと共用する変数・基礎styleは残し、Sidebar・dialog・入力・狭い画面を再確認する。歴史的な検証記録にVueという語が残ることを実装残存と混同しない。現在の起動案内・検証script・有効な文書リンクは更新する。
5. 削除後に、隔離した作業用環境でlockfileに基づく`pnpm install --frozen-lockfile`と対象typecheck/test/buildを一回まとめて実行する。ネットワーク/cache不足は実行不能と記録し、手元の古いnode_modulesで成功したことだけで依存整理完了にしない。既存開発環境のnode_modulesや利用者データを検証のために消さない。
6. 実装担当AIが最終bundleのElectronを起動し、Computer Use/Browser Use等で10章のP5/P7/Tシナリオを操作する。各機能を画面の入口→入力/クリック→結果表示→保存先照合→再表示まで通し、利用者へ未実行手順を渡して代替しない。過去の成功は手順・調査の参考に留め、今回の完成証拠へ転記しない。同じ最終コードを対象とした今回の証拠は複数項目で共用できる。途中で使った旧Desktop bundleを最終証拠にしない。
7. 実装者のセルフレビュー後、利用可能なら`.codex/agents/reviewer.toml`と`completion_judge.toml`の役割による読み取り専用レビューを行う。範囲追加をレビューで勝手に決めず、指摘を修正した範囲だけ再検証する。
8. I01–I23の修正/反証とR01–R17の証拠を照合する。Iが解消していても、元シナリオの必須操作・公開契約・再起動/移植の未検証があれば技術完了にしない。古い成功reportを上書きして修正後の成功に見せず、今回の条件・結果を追記して区別する。
9. P5-08もAIが担当し、操作の到達性、keyboard/IME、狭い画面、失敗表示、フォーカス復帰を確認する。対象内の客観的な操作不良を修正し、影響範囲だけ再検証する。利用者の見た目・好みの主観評価は任意のfeedbackとし、完了を止める条件にしない。
10. 9.1の品質基準を第三者視点でセルフレビューし、責務漏れ・重複した業務ルール・エラー隠蔽・セキュリティ上の不備を解消する。レビュー自体をE2Eの代替にしない。確認済みの対象内問題は直し、無関係な抽象化・好みの書換えだけで工程を繰り返さない。
11. AIが同じ最終実装commitの既存必須CIを起動・追跡し、失敗原因を修正して必要な範囲を再実行する。job名、実行URL、対象SHA、success/failed/skippedを報告する。CI未実行・必須jobのskip・異なるcommitの成功では本プランを完了にしない。

**完了・次工程条件:** R01–R17/V01–V15/I01–I23とP5/P7/Tの証拠、9.1の品質確認、対象commitの必須CI成功が揃い、11章を満たす。必須の未接続・不具合・未検証があれば閉じない。本人の機能検証や主観評価は待たない。完了後に、別途許可されたmerge等へ進める状態として報告し、Phase 8/9/10の実装はこの作業へ混ぜない。

## 9. 参照資料と品質上の注意

初回計画の体験上の参照を以下に残す。2026-09-09の改訂ではMulmoClaudeのMarkdown ViewとBuzzのChannelCanvasの公開sourceを読み、保存buffer・対象切替・保存中の入力抑止に絞って確認した。2026-09-10はその参照結果を引き継ぐ。MulmoClaude HTML Viewの再取得は失敗したため、再読済みと扱わない。残りは初回計画の参照記録であり、本改訂での実アプリ操作の証拠ではない。mainは変化するため、実装開始時には利用するsourceのcommitを記録する。

| 参照 | 確認した点 | Samuraiへの適用 |
| --- | --- | --- |
| [Codex Code review](https://developers.openai.com/codex/app/review) | 行を指定したfeedback、変更の確認と差戻し | 対象resourceと版、選択箇所を修正依頼へ添える。Gitを全成果物の保存基盤にしない |
| [OpenAIのファイル確認](https://learn.chatgpt.com/docs/artifacts-viewer) | previewと箇所を指定する修正依頼 | 対象形式の確認と反復修正。Office互換編集の要件にはしない |
| [MulmoClaude Markdown View](https://github.com/receptron/mulmoclaude/blob/main/packages/plugins/markdown-plugin/src/plugins/markdown/View.vue) | 表示と編集buffer、Apply/Cancel、保存失敗表示 | 文書の直接編集とdraft保持。Vueやファイル直書きの境界は移植しない |
| [MulmoClaude HTML View](https://github.com/receptron/mulmoclaude/blob/main/packages/plugins/html-plugin/src/vue/View.vue) | 隔離iframe、表示更新、source cacheと編集中の切替処理 | Surfaceと親UIの分離、保存後の再表示。HTML source editor全体は今回必須にしない |
| [OpenClaw Session Dashboards](https://docs.openclaw.ai/web/dashboards) | 必要なwidgetを表示・pin・更新し、人が操作する | 操作できるSurfaceと復元。Gateway/Sessionによる所有方式は移植しない |
| [Buzz ChannelCanvas](https://github.com/block/buzz/blob/main/desktop/src/features/channels/ui/ChannelCanvas.tsx) | Markdownの表示、編集draft、保存・取消、canEdit/archive | 人による文章編集と権限による操作表示。Nostr/Event保存方式は移植しない |

今回確認した品質上の参考は、MulmoClaudeの`persistMarkdown`が保存した文書と現在の選択を照合して別文書への反映を避ける点、保存失敗時に編集を閉じない点と、Buzzが保存中のtextareaを無効にする点である。Samuraiでは文書pathだけでは足りず、connection/workspace/Room/resource/base revisionを固定し、Serverの認可と競合制御へ通す。参照OSSにも今回と同等の復旧・競合保証があるとは推定せず、該当する書き方だけを参考にする。

失敗しやすい点は、Vue部品の存在をReact完成と誤認すること、汎用Office編集へ拡大すること、Backendで未対応のtoolをUIだけ表示すること、他者変更を保存時に上書きすること、フォームの入力状態と保存データを混同すること、HTMLへ親の権限を渡すことである。

Phase 5では、旧画面の削除を理由に知識・権限・保存APIをまとめて消すこと、逆に要否を判断せず全機能を移すことの両方を避ける。Reactの管理画面もChatと同じ認可を使い、設定変更や検索結果の表示だけが別の保護境界にならないようにする。

今回特に避ける修正は、`key`変更だけによる下書き破棄、refreshでのexpected version更新、既存配列欠落の空補完、古いrefを一覧から落とすだけの仕事確定、再送ごとのUUID発行、保存後のiframe丸ごと再生成、権限確認前後のactive接続読替えである。小さく見える修正でも保存・表示・証拠の整合が崩れる。逆にCRDT、汎用状態管理基盤、別DB、任意の処理を再実行するoutboxへ拡大しない。

### 9.1 OSSコード品質の受入基準

次を今回変更する責務の受入基準にし、工程ごとのセルフレビューとFの最終確認で証拠を残す。全repositoryの書換えや、主観的な命名の好みを無期限に直すgateではない。

| 観点 | 完了時に確認すること | 確認方法 |
| --- | --- | --- |
| 製品との整合 | 合意した機能を維持し、追加制約が不具合回避だけの都合になっていない | 変更前後の利用者操作、制約の理由/範囲/解除条件、該当RのE2Eを照合 |
| 薄いcontroller | HTTP/IPC入口は検証・context生成・サービス呼出し・結果変換へ限定され、業務条件と保存整合を抱えない | 変更経路と呼出し先を追い、6.1の責務表と差分を照合 |
| 再利用性 | Native/公開API/Runtimeが共通の業務サービスを使い、同じ認可・版・再送規則を再実装していない | 関連する複数入口の契約testと、HTTP/GUIに依存しないservice test |
| 可読性・保守性 | 型、名前、moduleの責務、正常/失敗/中断の流れが明確で、巨大な分岐・循環依存・型検査回避を追加していない | lint/typecheck、変更対象の境界検査、第三者が追える説明とfocused test |
| 整合性・セキュリティ | transaction/条件付き更新/不変履歴を守り、全入口で認可。frame/path/入力改ざん、誤送信、秘密値漏出を防ぐ | T01–T11の該当条件、実PG、拒否経路、差分のセキュリティ確認 |
| 失敗の透明性 | 欠損・競合・結果不明を空値や成功に変換せず、利用者と実装者が次の操作を判断できる | 失敗test、実画面のerror/retry表示、保存状態との照合 |

受入基準に反する確認済みの設計逸脱・整合性不良・セキュリティ不備は修正する。任意の整形や将来の汎用化だけの提案は後続候補として分離し、完成後に次のPhaseへ進める範囲を保つ。

## 10. レビューと検証

### 10.1 選定した検証

`samurai-plan-creator`の検証選定ガイドを読了し、現行`package.json`、`.github/workflows/ci.yml`、対象testを照合した。表の既存commandは実在する。新しいTシナリオは既存test/verifierの責務に追加し、作成前の専用commandが存在するとは記載しない。全てのコード検証は本改訂では未実行。

| 検証 | 理由・対象・command | 実行時期と成功条件 |
| --- | --- | --- |
| 文書 | 用語、相対リンク、Mermaid、`git diff --check` | 文書確定時。参照切れ・範囲矛盾・実装済みとの混同なし |
| lint | `pnpm lint`。変更責務のsource品質 | 実装のまとまりで一回。失敗は修正。小変更ごとには反復しない |
| 型 | `pnpm --filter @samurai-agent/web --filter @samurai-agent/desktop --filter @samurai-agent/server --filter @samurai-agent/workspace-server --filter @samurai-agent/room-permissions --filter @samurai-agent/runtime --filter @samurai-agent/core-schemas --filter @samurai-agent/domain-api --filter @samurai-agent/domain-operations run typecheck` | 共有型変更後と最終。実際に影響したpackageへ絞る |
| Artifact/Domain focused | `pnpm core:test:artifact`、`pnpm exec vitest run packages/domain-operations/src/operations/artifact/artifact-revise.operation.test.ts packages/domain-operations/src/operations/artifact/artifact-restore-revision.operation.test.ts packages/runtime/src/generated-surface-action-ingress.test.ts`と今回追加する対象test | B/D/E。競合・復旧・再送・失敗を確認。fake testは実PGの代わりにしない |
| Client/bridge focused | `apps/web/src/native-app/ArtifactSurfacePanel.test.ts`、`native-artifact-workspace.test.ts`、`native-collection-panel.test.ts`、`native-knowledge-tools.test.ts`、`native-interaction-requests.test.ts`、`GeneratedSurfaceFrame.test.ts`、`apps/web/src/lib/workspace-browser-bridge.test.ts`、`apps/desktop/src/preload.test.ts`と追加するmain送信先test | C–E。対象指定の`pnpm exec vitest run`。DOM上で編集/再render/遅延Promise/保存/離脱を操作する。静的markupやhelperの呼出しだけではT01–T03を完了にしない |
| Phase 5管理・契約focused | `apps/web/src/lib/workspace-room-tree.test.ts`、`workspace-room-capabilities.test.ts`、`apps/server/src/workspace-server/http-server-completion.test.ts`、`completion-contract.test.ts`、`packages/room-permissions/src/index.test.ts`、今回のReact管理/検索/設定/承認test | B/C。実際に変更した責務に絞り、基本管理の永続化・競合・認可・要求IDを確認。静的markupだけを操作検証としない |
| 自動化・共有入力の回帰 | `apps/server/src/adapters/runtime/postgres-runtime-automation.test.ts`、`apps/web/src/lib/collection-view-state.test.ts`と変更対象の既存test | B/C/E。job管理と型付き入力に変更がある時だけ実行。scheduler本体を変更しなければ全学習gateを反復しない |
| 仕事確定・interaction・移植focused | `apps/server/src/workers/postgres-room-work-worker.test.ts`、`apps/server/src/workspace-server/run-control-service.test.ts`、`packages/workspace-server/src/workspace-interaction-request-service.test.ts`、`workspace-server-store.test.ts`、`workspace-completion-bundle-v4.test.ts`とmaintenance worker test | B。T04/T07/T10の正常・中断・欠損を検証。保存済み証拠からの復旧と現在版からの推測を区別する。実DB検証は別に必要 |
| 契約とbundle検査 | `pnpm core:domain-contracts:verify`、`pnpm phase01:verify`、`pnpm core:test:generated-surface` | B/Eの共有契約変更後。生成物と実装が一致し、悪いbundleを拒否 |
| Build | `pnpm --filter @samurai-agent/web run build`、`pnpm desktop:build`、`pnpm desktop:verify` | UI/bridge統合後。React production entryとDesktop bundleを確認 |
| Vue削除・依存整合性 | V01–V15の参照調査、隔離環境の`pnpm install --frozen-lockfile`、最終typecheck/test/build | F。旧専用source・直接依存・型/plugin設定が残らず、共有機能の検証も成立。環境不足は削除gateの未検証として残す |
| 実PG・File Integration | 既存`pnpm verify:postgres-deep`と、今回の認可・revision・action・移植の追加シナリオ | B/F。隔離環境でDBとfileとeventを照合。実行条件不足は未検証 |
| 実Client/Agent E2E | 10.2。AIが実Electron、実Native+Gemini、実保存を操作 | F。全必須機能を画面の入口から通し、機能別の証拠を残す。利用者操作で代替しない |
| Accessibility | keyboard、フォーカス復帰、入力名、エラー通知、IME、狭い画面 | C–FのComponent/実UI確認にまとめる |
| 依存追加時の確認 | 新規依存のlicense、保守状態、`pnpm audit`結果の影響確認 | 依存選定時のみ。既知問題・未対応を記録 |
| OSS品質・責務境界 | 6.1/9.1と変更対象のservice/controller/adapter、既存Architecture gate | 各工程とF。責務分離・再利用性・可読性・安全性を確認。lint成功だけで設計品質を代替しない |
| 既存必須CI | `.github/workflows/ci.yml`と対象PR/branchに設定された必須check。3OS契約/型検査、Linux test/build/audit、PG等 | AIがFで最終実装commitの実行と全必須checkの成功を確認。未実行/失敗/skipは全体未完了。CI成功を3OSのNative GUI確認と同一視しない |

採用する検証の分担は、純粋変換/状態遷移をfocused、mount後の入力保護をComponent、保存・認可・Migration・中断・移植を実PG/file、画面→Server→再表示を実Clientとする。最終の全体typecheck/test/audit/buildは既存CIへまとめ、ローカルでは変更packageと技術E2Eに必要なbuildを行う。共有契約検査とPG verifierに重複がある場合は実行項目を確認して一方の証拠を参照する。追加変更、失敗、未解決の懸念がない同一条件の再実行はしない。

新しいtestは既存CIのtest収集または既存PG verifierへ接続し、ローカルだけで成功する未収載testにしない。CIのskip・閾値緩和・必須契約の削除は修正方法にしない。今回変更しない性能基盤の負荷試験や、全OSのGUI検証を追加の必須gateにはしない。実行できない検証は理由・影響するR・担当を残し、そのgateを未完了とする。

`core:test:generated-surface`等には既存reportを書き出すscriptがある。実装時は事前に副作用を確認し、他作業の証拠を上書きしない形で結果を保存する。今回の計画作成中はこれらのコード検証を実行しない。

新しいtestファイル名は責務の切り出しに合わせて決める。上表で「今回追加」としたものは存在済みcommandとして扱わない。性能は既存上限と対象データ量で応答・入力・スクロールを確認し、合意していない負荷目標を新設しない。

### 10.2 実使用シナリオ

本番や既存データへ書き込まず、repo外の専用DB・storage・Account・Roomを用いる。

**実行担当は全シナリオでAI。** Electronの実ウィンドウ/rendererをComputer Use/Browser Use等で操作し、機能ごとに前提→操作→期待結果→画面の実結果→DB/file/Event→再表示を記録する。APIはfixture準備と保存結果の照合に使えるが、画面から行う必須操作をAPI直呼びに置き換えない。確認dialog、保存失敗、再接続も実画面で扱う。主観を伴う見た目の好みは確認対象外だが、buttonに到達できる、入力を失わない、keyboard/IMEが使える等はAIが検証する。

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
| P5-08 | AIが実Electronで主要な仕事と全必須補助機能を一つずつ操作し、P5/P7/Tの機能別記録を完成させる | Chatへの復帰、必要な操作への到達、長い一覧、狭い画面、keyboard/IME、失敗/確認dialogを含め実動作を確認。仕様上の操作不良を解消し、利用者の機能検証を要求しない |

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

AI生成が必要な必須E2Eは、前回使用した利用者提供のGemini APIキーを既存の安全な設定経路で利用し、Native+Geminiの無料枠内で行う。有料枠への変更や別providerへの自動fallbackで結果を置き換えない。429/503等は原因を区別し、理由のある限定的な再試行に留め、成功まで無制限に呼び続けない。キーや無料枠を利用できなければAIが原因と影響gateを報告し、必須の実Agent確認は未完了とする。

Codex/Claude Codeを含む今回変更した機能の契約・表示・失敗処理もAIが確認する。公式CLIの実接続を検証する場合は、利用可能な認可済み環境でAIが操作する。本人にしかできないログイン/認証入力が必要な場合だけ、その操作に限って依頼し、機能確認や再現作業は依頼しない。全外部Backendの再認証・全機能実証は従来どおり本Phaseの範囲を広げず、実CLI未実証をNative+Gemini成功と同一視しない。旧来の「利用者が公式Backendを検証する」という提出待ちは完了条件に残さない。今回の必須機能に影響する環境不足は未完了、元から対象外の実証は後続として明示する。

Self-hostとHostedは結果を分ける。まず用意できる隔離Self-hostで技術E2Eを閉じる。実Hostedが用意できなければ未検証を残し、両配置対応の完成とは報告しない。Windows/Linux GUI、署名・配布物はPhase 10に残す。

#### 再レビューを閉じる追加シナリオ

P5-01–P5-08とPhase 7の1–12を維持し、次のT01–T11を必要な箇所へ組み込む。これは別のPhaseや新しい製品要件ではない。同じ実行が複数のR/I/P5/P7を証明する場合は証拠を共用する。初回実装で成功した代表経路だけで置き換えない。

表内の`P7-n`は直前のPhase 7シナリオの番号nを短く参照する表記であり、元の番号と内容を変更しない。

| ID / 指摘 | 条件と操作 | 必須の確認 / 主な検証 |
| --- | --- | --- |
| T01 / I01・I03・I06 | 表Aを編集→同一Roomの親再render/Event→表Bへの切替。別操作で、仕事の過去版カードを開いて保存/復元/続けて編集 | A/Bのbuffer・対象ID・baseが混ざらず、離脱で選択できる。保存後は返された新revisionを表示し元の結果refは不変。Component＋実Electron/PG、P7-2/3/8 |
| T02 / I02・I07 | 表ArtifactとCollectionで数値→空欄→数値、0/false/null、sort後の編集。Account Aがdirty中にB/Agentが同じrecordを変更し、Aで一覧refresh→保存 | typed値/row IDを保持。refresh後もAのbaseは進まず競合し、Bの変更とAの下書きが残る。Component＋実PG＋実画面、P7-3/8 |
| T03 / I14・I15 | 文書/表/Knowledge/Skill/Collectionを編集し、保存Promiseを止める。閉じる・資源/Room/Workspace切替・通常アプリ終了、IME、保存失敗も行う | 保存中の入力抑止、保存/破棄/戻る、失敗時のdraft保持、元target以外への送信ゼロ。依頼/設定の未保存保護もP5-04/07で確認。Component＋実Electron |
| T04 / I04・I16・I23 | 実Runtime toolから作成→同一Run内の複数改訂→仕事確定。他者の後続編集/改名も挟む。Run終端保存後・仕事確定前にServer停止→復旧。正常空結果と必須配列欠落を別入力で検証 | 元の仕事・Run・全revision・カードの一致、通常/復旧のrefの一致、再実行/副作用の重複ゼロ。欠落を正常空結果にしない。focused＋実PG/file/Server再起動＋画面、P7-1/10/11 |
| T05 / I08・I17 | byte配列とbase64の実画像/PDFを通常Native tool/APIから登録し、画面表示・download。UIから対象版付き修正依頼を送り、対応するBackendで修正版を作る。破損・範囲外byte・MIME不一致も投入 | 元/新ファイルのbyte数・hash・revision・Work/Run関係。表示だけで修正成功と数えない。非対応表示はそのBackendの証拠であり、対応経路の実修正検証を代替しない。実Native+Gemini/Client/PG/file、P7-5 |
| T06 / I05・I10 | 実フォームと生成HTML双方で保存→結果/data表示→再表示。二度押し、保存確定後に応答だけ遮断→同一ID再送/アプリ再起動後照会。asset付きbundle、pin→unpin→archive、再生成、HTML/ZIP出力 | operation/作成record/新revisionが一回、同じ結果を再表示。未送信入力と確定データを保持。asset整合、detail/list state一致、古いframe/action拒否、次のAgentが保存済みデータを参照。Component＋実Client/PG/file、P7-6/7/9/10 |
| T07 / I11・I19・I20 | backend入力で空欄のdeny/入力済みdeny/submit。停止済みRun、期限切れ、別Account、二重応答。accepted保存直後、claim直後、副作用直後、結果通知前を別々に中断 | denyは入力不要で保存。未配送をcompletedにしない。acceptedは同一要求の再認可後に一度実行/拒否へ進み、不明な副作用は自動再実行しない。Event失敗も保存結果を失わない。focused＋実PG/再起動＋実画面、P5-05/P7-10 |
| T08 / I12・I13・I18 | Knowledge新規作成・本文/履歴・保管/復元・固定、Skill編集→無効→画面を閉じる→再有効。ページ上限を超えるRoom/Workspace資源、同名の旧Memory/Wiki、一覧外の検索結果、仕事/旧履歴/成果物検索 | 種別/ID/metadata/権限/版を保持。全ページへ到達し、検索先を開ける。無効Skillは実行用には使われず管理用に取得できる。公開API＋実Client/PG、P5-03/04 |
| T09 / I21 | R12–R16の公開Query/Operation/Eventを生成契約と照合し、管理画面から代表的な取得/更新/拒否/再接続を行う | UIの実通信が公開入口を使用。catalogのみの未接続ゼロ、旧互換も同じ認可/保存サービス。Room移動/最後のOwner/DM保護、設定scope、自動化停止/再開を含む。契約test＋実PG/Client、P5-02–06 |
| T10 / I09 | 現行DBをupgrade、全形式の複数revision・Surface/asset・Collection・Knowledge/Skillを作りwork/instructionに参照を添える。export→隔離した別Serverへrestore→画面と次の仕事で参照。旧Bundleと不正refも確認 | 本文/hash/全版/ID/scope/参照/出所が一致。旧Bundleは仕様どおり、不正Bundleは部分成功せずcleanup。元ServerのURL不要、現在の権限で再認可。実PG/file/2 Server/Client、P7-11/P5-03/07 |
| T11 / I22 | 同じworkspace/resource IDを持つ別接続A/Bで、事前確認後・IPC受付前に切替。受付後・HTTP応答前の切替と失効も別条件で行う | Bへの誤更新ゼロ、受付時targetが変われば送信前拒否。Aへ確定した操作はAで再照会しBへ混入しない。Desktop main/preload/Browserの遅延制御test＋実2 Server/Client、P5-07/P7-9/10 |

T04/T07の中断位置はtest harnessの依存注入・プロセス制御で確定し、単に任意時刻にServerを再起動したことだけでは証拠にしない。新しい本番用failpoint APIは作らない。T05で利用可能なBackendに修正能力がない場合はR05の該当実証を未検証として残し、新しいprovider契約で埋めない。

### 10.3 証拠保存・必須CI・Git操作の境界

実装・検証を開始した時点で、`reports/`の規則に従い、既存の`reports/native-artifact-surface-phase5-7/`へ今回の条件・command・結果・未検証・AIが実行した操作手順を追記する。初回実装の記録を消さず、後日の修正結果と区別する。今回の読み取り調査と計画だけでは検証reportを作らない。

証拠の各行は、R/V/I/Tまたは元シナリオ、対象commitと差分、Client/Backend/認証方式、DB/OS/配置、AIが行った画面操作とcommand、期待結果、実結果、DB/file/Eventとの照合、必要な画面記録のpath、未検証理由を持つ。全体testの件数だけを各Rの証拠にしない。秘密値は保存せず、検証資源のID/hashだけを必要な範囲で残す。9.1の品質確認には変更対象の責務・共通サービス・test・未解決指摘を記録する。

実環境はrepo外の専用DB/storage/Account/Room/Browser profile/Electron user-data-dirへ隔離する。対象を明記してから正規Migrationを適用し、既存Desktop profile・既存DB・本番データを使わない。AIが起動・操作・停止と証拠保存まで行い、終了後は今回作成した資源だけをcleanupする。任意のUI評価を利用者が希望する場合は別途起動手順を渡せるが、環境の引継ぎや利用者操作を完成の前提にしない。Geminiキーの値を文書・ログ・画面記録へ出さず、許可された安全な実行環境経由で利用する。

検証失敗はAIが原因に対応する変更を行ってから該当範囲を再実行する。Agentレビューは実動作の代わりにしない。対象の最終実装commitとE2Eのコード状態を対応付け、AIが既存必須CIの全checkを確認する。コード変更で証拠の対象が変われば影響範囲を再検証し、古いcommitのCI結果を使わない。

利用者へは、修正内容、機能別のAI E2E結果、OSS品質確認、必須CIの対象SHA/実行URL/結果、元から対象外の未検証を報告する。CI起動に必要なcommit/push/PR更新は、その時点で与えられた許可の範囲でAIが行う。必要なGit操作の許可やCI実行環境が不足していれば具体的に示し、CI待ちとして全体未完了を維持する。これは機能検証を利用者へ依頼するgateではない。今回のplan-only依頼を即時のコード実装・Git操作・mergeの許可へ拡張しない。mergeは別の明示指示に従う。

## 11. 完了条件・未検証事項

### Phase別の完了条件

| 判定 | 必要条件 |
| --- | --- |
| Phase 5 技術確認完了 | AIがR01・R11–R17とAppに関係するR07/R09/R10を確認。採用した管理・検索・設定・確認操作、基本の仕事と成果物入口がReactで使え、Vue専用source/直接依存の整理と削除後の検証が終了。初回・再起動・既存データの利用を実Client/PGで確認 |
| Phase 5 画面操作E2E完了（AI担当） | AIがP5-08を含む全必須機能を実Electronで操作し、機能別の画面・保存先・再表示の証拠を記録。keyboard/IME、狭い画面、到達性、確認/失敗表示等の客観的な操作不良を解消 |
| Phase 7 技術確認完了 | AIがR02–R09と関係するR10/R15を確認。全対象形式の表示、文章/表の直接編集、Agent修正、Surfaceの実入力保存、履歴・競合・隔離・復旧・移植を実Client/PG/fileで確認 |
| OSS品質確認完了 | 6.1/9.1を満たし、変更対象のファットコントローラー化、業務ルール重複、型/エラー隠蔽、整合性・セキュリティ上の確認済み不備がない。製品能力を不必要に制限して問題を隠していない |
| 必須CI完了 | 最終実装commitに対する対象PR/branchの全必須checkが成功し、AIがSHA・実行URL・結果を記録。未実行/失敗/必須jobのskipを成功扱いしない |
| 本プラン完了 | 上記とR01–R17/V01–V15/P5/P7/TのAI検証証拠が揃い、I01–I21の修正、I22の修正または実経路での反証、I23の契約是正が終了。対象内の必須不具合・未接続・Vue残存・必要な技術検証の未実行がない。元から対象外のBackend/OS/配置を明示。利用者の機能検証・主観評価は条件に含めない |

Phase 5と7は番号・責務を分けて判定する。成果物パネルだけの成功や、旧機能を未分類のまま対象外にすることでPhase 5を閉じない。必須の実画面操作はAIがmacOS・Self-host・Native+Geminiで確認する。外部Backendの実証範囲は10.2に従い、未用意の実Hosted、Phase 10のWindows/Linux GUI・配布は元の対象外を維持する。これらを「利用者が後で機能確認する」という未処理の必須作業に置き換えず、全Backend・全OS・両配置で製品完成とも報告しない。

### 共通の照合条件

- R01–R17に対応する入口、処理、保存、確認の証拠が揃っている。
- 文書・表・画像・PDF・HTMLをReact Appで開き、保存済みの同じ結果を再び確認できる。
- 文書・表の直接編集、対象を指定したAgent修正、Surfaceの入力保存が実際のDomain/DB/fileへ通っている。
- 版競合、権限失効、再送、途中失敗、再起動、移植を扱え、未確定の結果を完成扱いしない。
- V01–V15の採用/廃止/後続と参照元が記録され、採用機能の移行漏れ・動かないボタン・不要なVue実行依存がない。保存データを維持し、採用範囲の既存成果物・知識・Collectionは認可された入口から参照できる。Phase 8へ送る改善候補の専用UIはこのgateに含めない。
- 対象外機能を追加せず、AIが仕様どおりの機能・操作を確認する。利用者の主観評価は任意。Backend・OS・配置別の未検証を明示している。
- T01–T11を元シナリオへ対応付け、変更した経路のComponent/実PG/実Client証拠が揃う。単なるmarkup、mock、API単体の成功で実画面操作を代替しない。
- 必須経路に影響する未解決の指摘が追加で見つかった場合も台帳へ追加し、修正と対応検証を行う。件数を21に固定して発見を打ち切らず、逆に対象外の機能追加へは広げない。

### 完了判定の手順

1. 実装者がR01–R17、V01–V15、I01–I23、P5-01–P5-08/P7-1–12/T01–T11の対応を点検する。成功・未検証・対象外・根拠付き反証を分け、未記入を成功にしない。
2. AIがP5-08を含む実画面操作と技術gateを全て通し、Phase 5/7それぞれの結果を記録する。未実証があればAIの検証待ちとして未完了を維持し、機能テストを利用者へ戻さない。
3. 9.1のOSS品質確認と、同じ最終実装commitの必須CI成功まで揃ったら、本プランの合意済み範囲を完了と判定する。主観的なUI評価が未提出でも判定を止めない。元から対象外の環境は明示し、全環境で成功したと報告しない。
4. 完了報告に修正内容、AIによる機能別E2E、品質確認、必須CIの証拠、対象外の未検証を添える。10.3の許可範囲に従ってGit操作を扱い、mergeの指示があれば進められる状態にする。merge承認と本人の機能検証を混同しない。

### 改訂時点の証拠と未決定事項

確認済みは、会話の合意、正本・関連設計、現行sourceと既存test/script/CIの構造、4.2の過去の検証記録、9章で今回読んだ参照OSSの該当sourceである。過去の実装/成功記録を全未実施とは扱わず、本改訂でのコード修正・再実行とも混同しない。

製品範囲を左右する未決定事項は現時点でない。I22の成立条件、互換Bundleのversion/feature識別、DOM test依存と公開型の追加名は工程A/Bで現行契約から確定する実装事項であり、利用者の回答待ちではない。採用範囲の削減、学習仕様や資源所有・保存形式の変更が必要になった場合だけ、理由と影響を示して相談する。

この改訂によるコード実装、Migration、依存追加、T01–T11、実DB/実Agent/実Clientの追加E2E、対象コードの必須CIは未実施。計画文書だけを更新し、文書構造・リンク・用語・差分を検査する。コード検証のreportは作成しない。任意の主観的UI評価は未実施でも必須gateの未検証には数えない。

### プランのセルフレビューで反映したこと

- 古い「実装前・全て未実施」という記述を修正し、初回実装の成功範囲と今回の未達を区別した。
- R01–R17/V01–V15/工程A–F/P5-01–P5-08/Phase 7の1–12の番号と機能範囲を維持した。最新合意で変更したP5-08・工程F・完了gateの担当と名称は3.4に旧新対応を記録した。管理・権限・自動化・旧データの検証も省略していない。
- I01–I21、反証可能なI22、品質上のI23を工程とTへ対応付けた。未確定の競合候補を既知の実機障害に数えていない。
- 別の資源へ書く事故をUI stateだけでなく送信先・基準版・保存先で防ぐ計画にした。再起動復旧は保存結果の回収と実行再開の安全性を分けた。
- 不具合を示す動的Component testと実PG/実Clientを追加し、全体検証の反復、CIの弱体化、参照OSSの丸ごと移植を要求していない。
- 機能E2E・実Electron操作・品質確認・必須CIをAI担当に統一し、本人の機能検証と主観評価を完了条件から外した。認証入力と機能検証を区別し、後続OS/配置を今回の成功へ含めていない。
- 製品の本質を損なう制約、ファットコントローラー、重複した業務ルール、保守性の悪化を禁止事項と受入基準の双方へ反映した。対象外の全体リファクタリングや、指摘のないレビュー反復を要求していない。
- plan-onlyの範囲でコード・report・Git履歴は変更しない。
