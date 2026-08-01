# Samurai Agent Core Completion Plan

## 0. この文書の目的

この文書は、Samurai Agent の Core を今回の強化でいったん完成と判断できる状態まで持っていくための、最終ギャップ監査・実装計画・100点満点テストをまとめた正本である。

- 対象は `MulmoClaude型Host + Agent Backend cassette + Hermes的Memory/Skill改善ループ + Gateway` の Core 全体。
- 既存の `backend-architecture-completion-ledger.md` は Backend 契約の完成記録として残す。
- 本書は、それより広い「Core 全体」の完成判定に使う。
- 本書に書かれた必須項目を実装し、最後の50問で100点を取った時点を Core 完成とする。
- 画面の見た目やピクセル差分を確認するE2Eテストは、今回の必須条件に含めない。

### 0.1 監査対象

本書は2026-07-11時点の資料と実装を確認して作成した。現在は、後から正本へ追加された`SAMURAI_AGENT_MANUAL.md`を本書より優先する。

- 現在の上位正本: [PRINCIPLES.md](../PRINCIPLES.md)、[SAMURAI_AGENT_MANUAL.md](../SAMURAI_AGENT_MANUAL.md)、[ARCHITECTURE.md](../ARCHITECTURE.md)、[PUBLIC_NAMING.md](../PUBLIC_NAMING.md)、[WEB_UI_DESIGN.md](../WEB_UI_DESIGN.md)
- 2026-07-11時点で確認した正本: [PRINCIPLES.md](../PRINCIPLES.md)、[ARCHITECTURE.md](../ARCHITECTURE.md)、[PUBLIC_NAMING.md](../PUBLIC_NAMING.md)、[WEB_UI_DESIGN.md](../WEB_UI_DESIGN.md)
- Learning計画: [Plan A](./learning-core-plan-a-context-retrieval.md)、[Plan B](./learning-core-plan-b-autonomous-review-evaluation.md)、[Plan C](./learning-core-plan-c-curator-automation.md)、[Roadmap](./learning-core-roadmap.md)
- 既存のBackend評価: [Completion Ledger](./backend-architecture-completion-ledger.md)、[OSS Comparison](./backend-current-state-oss-comparison.md)、[External E2E Runbook](./backend-external-e2e-runbook.md)
- 主な実装: `packages/runtime`、`packages/workspace-store`、`packages/learning`、`packages/ui-protocol`、`packages/core-schemas`、`apps/server`、`apps/web`
- 比較元: MulmoClaude、Hermes Agentの公式GitHubリポジトリと公式ドキュメント

## 1. 結論

現状は、Core の骨格はかなり揃っているが、まだ「長時間安心して任せられる完成品」ではない。

特に弱いのは次の4点である。

1. サーバーを再起動しても、長時間タスクを確実に続けられる仕組み
2. Chat、画面、Gateway、Automation、Backend tool の操作を同じCore操作へ統一する仕組み
3. SQLiteとファイルを同時に扱うWorkspaceの壊れにくさ
4. 必要な画面を出す判断と、Memory・Skillを改善する判断の品質保証

逆に、次の土台はすでにある。

- Backend cassette と Backend Registry
- Surface Protocol と capability fallback
- Artifact、Collection、Memory、Wiki、Skill の基本モデル
- Workspace Store と監査記録
- Session Search、Skill disclosure、Learning use trace
- Background Review、Evaluation、Curator、Automation の基本契約
- Approval、監査、Gateway、SecretRef、path制約、plugin署名などの安全境界

したがって、作り直しではない。今ある土台を、再起動耐性・一貫性・品質保証まで含む運用可能なCoreへ仕上げる計画である。

## 2. 比較基準

### 2.1 MulmoClaudeから見る基準

MulmoClaudeについては、公式リポジトリで確認できる次の要素を比較基準にする。

- Hostが実行Backendを呼び分ける
- Chatから文書、表、図、フォームなどの表示を必要時に出す
- ファイルWorkspace、Plugin、Bridge、Sandboxを持つ
- 画像、PDF、テキスト、DOCX、XLSX、PPTXなどを入力として扱う
- URLや再接続後も表示状態を復元できる
- ローカルAPIにも認証境界を置く

参照: [MulmoClaude公式リポジトリ](https://github.com/receptron/mulmoclaude)

### 2.2 Hermes Agentから見る基準

Hermes Agentについては、公式資料で確認できる次の要素を比較基準にする。

- 小さく保たれたMemoryとUser情報
- Session Searchと段階的なSkill disclosure
- 定期実行と、Agentを使わない軽量ジョブ
- Skillの利用状況を見た自動整理
- 永続Goal、タスクボード、checkpoint、heartbeat、zombie回収
- 再起動後のGateway・Session・Taskの継続
- Profileごとの設定、Session、Skill、Homeの分離

参照:

- [Memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)
- [Skills](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md)
- [Cron](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/cron.md)
- [Kanban](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/kanban.md)
- [v0.12 Learning/Curator](https://github.com/NousResearch/hermes-agent/blob/main/RELEASE_v0.12.0.md)
- [v0.13 Goal/Checkpoint/Recovery](https://github.com/NousResearch/hermes-agent/blob/main/RELEASE_v0.13.0.md)
- [Profiles CLI](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md)

### 2.3 公式GitHub再確認後の実装比較

2026-07-11に、両リポジトリの`main`を再取得し、READMEだけでなく関連する実装・開発資料まで確認した。

参照したMulmoClaude実装:

- [AI-native architecture manifest](https://github.com/receptron/mulmoclaude/blob/main/MANIFEST.md)
- [HTML plugin tool contract](https://github.com/receptron/mulmoclaude/blob/main/packages/plugins/html-plugin/src/core/definition.ts)
- [HTML plugin implementation](https://github.com/receptron/mulmoclaude/blob/main/packages/plugins/html-plugin/src/core/plugin.ts)
- [HTML / Wiki render surface notes](https://github.com/receptron/mulmoclaude/blob/main/docs/wiki-html-render-surfaces.md)
- [Runtime-loaded plugin contract](https://github.com/receptron/mulmoclaude/blob/main/docs/plugin-runtime.md)

参照したHermes Agent実装:

- [Background Review implementation](https://github.com/NousResearch/hermes-agent/blob/main/agent/background_review.py)
- [Persistent Memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)
- [Skills](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md)
- [Curator](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/curator.md)
- [Learning graph](https://github.com/NousResearch/hermes-agent/blob/main/agent/learning_graph.py)

| 比較対象 | 公式実装で確認したこと | Samurai Agentで参照すること | Samurai Agent独自の接続 |
| --- | --- | --- | --- |
| MulmoClaude HTML | `presentHtml`がself-contained HTMLを`artifacts/html/`へ保存し、`allow-scripts`だけのopaque-origin iframe、CSP、path-based mount、source edit、file watch、download / PDFを持つ | HTMLを消えないArtifactとして保存し、reload、相対asset、編集、exportを成立させる | 生成HTMLの宣言actionをCommon Domain Operationへ接続し、利用結果を学習する |
| MulmoClaude GUI Plugin | Agent toolとVue Viewが同じpluginに属し、runtimeがtyped dispatch、pub/sub、scoped files、locale、log、fetch、notifyを渡す | Hostと表示実装を小さいruntime protocolで分離し、eventで再描画する | authored Pluginだけでなく、一時生成Surfaceにも制限版runtime bridgeを与える |
| MulmoClaude Wiki | `data/wiki/index.md`、`log.md`、`pages/`、`sources/`をClaudeのfile toolsで育て、Wiki linkとcanvas表示を持つ | Markdown正本、source保存、link、更新log、人間が読める表示 | Wiki利用runを記録し、EvaluationとCuratorで結果に基づき改善する |
| Hermes Background Review | 親runからforkしたAgentがMemory / Skillだけのtoolsetで訂正・手順・利用中Skillを積極的に更新する | 別Agent review、利用中resource優先、訂正を強いsignalにする、tool範囲を限定する | mutation対象へKnowledge Wikiを型付きで追加し、HTML本体はWikiへ混ぜない |
| Hermes Curator | Skill usage、pin、active→stale→archive、任意consolidation、事前snapshot、rollback、run reportを持つ | 利用実績、保護、idle gate、archive、snapshot、rollback、report | Memory / SkillだけでなくWiki関係とGenerated Surface patternも同じevidence線へ接続する |

比較から得た結論:

- MulmoClaudeでは、LLM生成HTMLは永続Artifact、複雑な双方向操作はPlugin Runtimeという二層に分かれている。
- Hermes Agentの自己改善loopは、現在もMemory / Skillが正式な直接更新対象で、独立したKnowledge Wiki resourceは持たない。
- したがって、`Knowledge Wiki × outcome Evaluation × Curator` と、`Generated HTML × Common Domain Operation × Learning Signal` はSamurai Agent側で追加する独自統合になる。
- 独自統合であっても、MulmoClaudeの永続HTML、opaque-origin iframe、runtime bridgeと、Hermesのscoped review、usage、pin、snapshot、rollbackはそのまま実装品質の基準にする。

## 3. 「Core完成」の範囲

### 3.1 100点の対象

次をすべて満たす単一オーナー向けPersonal Agent Coreを完成形とする。

- local-firstで動く
- ローカルdaemon、またはオーナー自身が管理する安全なリモートCoreとして動く
- Web、Desktop、Gateway、Automationが同じCoreを使う
- Chatが主画面で、必要なときだけSurfaceやArtifactを出す
- Workspaceを永続状態の正本にする
- 長時間タスクが、プロセス再起動や一時的な失敗をまたいで継続できる
- Backendを差し替えられる
- Memory、Skill、Artifact、Collectionを再利用できる
- 既存Rendererでは表現しきれない時に、HTML / CSS / 限定JavaScriptのGenerated Surfaceをオンデマンド生成できる
- 実行結果から安全に学び、改善し、必要なら元に戻せる
- 何が起きたかを後から追跡できる

### 3.2 100点の対象外

次は将来の製品拡張であり、Core完成を妨げない。

- MulmoClaudeに存在する全画面・全アプリの複製
- 独自DB、独自API、独自認証、常駐processまで内包するstandaloneアプリを毎回生成する仕組み
- 全LLM provider、全メッセージングサービス、全Sandboxへの対応
- SaaSのマルチテナント、課金、組織管理、共同編集
- Cloud間で自動同期する分散Workspace
- Plugin Marketplaceの販売・決済機能
- GEPA、Mixture-of-Agents、モデル再学習
- 音声、動画、3Dなどの全メディア機能
- ピクセル差分や人手による画面デザイン確認E2E

ただし、差し替え可能性を証明するために、最低1つの実Backend、1つのSandbox、1つの署名付きGateway入力は100点の対象に含める。

ここで対象外にするのは、Coreから独立したアプリ一式の無制限生成である。WorkspaceのDomain Stateを投影し、宣言済みDomain Commandだけを実行する一時的またはピン留め可能なGenerated Surfaceは、Core完成の対象に含める。

## 4. 現行Coreの監査結果

### 4.1 Mulmo的な部分

| 領域 | 現状 | 判定 | 主な不足 |
| --- | --- | --- | --- |
| Host / Backend cassette | Registry、run、resume、stream、tool bridgeがある | 強い | 再起動後の実行復旧と実Backend適合試験 |
| Surface Protocol | form、table、chart、artifact、collection等がある | 強い | 何を出すか決めるPresentation Planner |
| Generated Surface | Collection actionからLLM生成HTMLをsandbox iframeへ出す細い経路がある | 中 | 通常会話からの自動選択、永続化、Domain Command接続、再利用、学習 |
| Collection | schema、record、view、action、triggerがある | 中〜強 | schemaの型、migration、同時更新整合性 |
| Artifact | 作成、参照、previewの基本がある | 中 | 改訂履歴、入力変換、export、欠損復旧 |
| Plugin | manifest、署名、handlerがある | 中 | 隔離実行、timeout、version互換性 |
| Bridge / Gateway | Gatewayとsession mappingがある | 中 | 再起動復旧、重複排除、共通操作化 |
| Sandbox | 契約とadapterがある | 中 | 実環境での代表E2Eと失敗復旧 |
| 添付ファイル | 画像中心の入口がある | 弱い | PDF、Office、textの抽出・由来管理 |
| 再接続 | 一部のrun/session復元がある | 弱い | Surfaceと長時間Taskの完全な再構築 |

### 4.2 Hermes的な部分

| 領域 | 現状 | 判定 | 主な不足 |
| --- | --- | --- | --- |
| Active Memory | Memory、Wiki、source trackingがある | 中〜強 | token予算、圧縮、長期Session要約 |
| Knowledge Wiki学習 | active retrieval、use trace、Evaluation、提案reviewの部品がある | 中 | Background Reviewの直接mutation、意味的整理、UI利用結果との接続 |
| User理解 | `SOUL.md` と任意の `PROFILE.md` がある | 中 | 小さく保つUser Model、Profile分離 |
| Session Search | FTS5とfallbackがある | 中 | 毎回reindexしない増分索引、rank改善 |
| Skill disclosure | 段階開示とuse traceがある | 強い | 実利用率と品質を使った最適化 |
| Background Review | 提案と自動適用がある | 中 | 厳密validation、原子的適用、rollback |
| Evaluation | before/after評価がある | 中 | task分類、訂正信号、比較の因果性 |
| Curator | 統合、昇格、廃止、履歴がある | 中 | 意味的重複、衝突、usage反映 |
| Automation | 永続jobとschedulerがある | 中 | 複数worker競合、lease、restart回収 |
| Goal / Task board | 明示的な永続モデルがない | 弱い | Objective、Work Item、依存、checkpoint |
| Crash recovery | runの一部resumeはある | 弱い | heartbeat、zombie、reclaim、再実行制御 |

### 4.3 実装構造と運用品質

現行コードでは、責務の集中も完成を妨げている。

- `packages/runtime/src/index.ts` は約15,800行で、Host、Backend、Context、Learningなどが集中している。
- `packages/workspace-store/src/index.ts` は約8,000行で、migrationと各repository責務が集中している。
- `apps/server/src/index.ts` は約7,500行で、route、scheduler、stream、compositionが集中している。
- `apps/web/src/App.vue` は約5,000行で、Shellと各Surfaceの責務が集中している。
- ServerにはStoreやRuntimeを直接呼ぶ経路が多く、すべての変更操作が1つのDomain Operationへ統一されていない。
- 実行中process、event buffer、backend sessionの一部がメモリ上のMapにあり、process再起動で失われる。
- Generated SurfaceはLLM生成HTML、iframe sandbox、action handoffの縦線があるが、Collection actionへ依存し、通常Chatからの汎用生成、versioned persistence、再接続、UI固有の学習信号が閉じていない。
- Knowledge Wikiはrunへ注入され、利用記録とEvaluation対象にもなるが、Hermes型Background Reviewの直接mutationはMemory / Skill中心で、Wiki作成・patch・統合まで一つの自己改善loopになっていない。
- SQLite migrationはversion ledger型ではなく、ファイル操作とDB操作をまたぐtransaction recoveryも不足している。
- Browserの見た目E2Eは今回省略できるが、Core API、再起動、競合、復旧の自動試験は不足している。

## 5. まだ足りない部分の全リスト

1. Core完成条件を機械的に判定する正本がない
2. Runtime、Store、Server、Webが物理的に巨大で、責務境界が弱い
3. すべての変更操作がCommon Domain Operationへ統一されていない
4. 長時間タスクを表す永続Objective / Work Itemモデルがない
5. worker lease、heartbeat、zombie回収、checkpointがない
6. Backend実行状態とevent streamの再起動耐性が足りない
7. 長いSession向けのcontext予算・圧縮・要約が足りない
8. 小さく保つUser ModelとProfile分離が足りない
9. Session / Memory / Wiki / Artifact検索の索引とrankが弱い
10. Background Reviewのvalidationと原子的適用が弱い
11. ユーザー訂正・やり直し・差し戻しを学習信号として十分に取れていない
12. Evaluationのtask分類とbefore/after比較の信頼性が弱い
13. Curatorの意味的重複・衝突・usage判断が浅い
14. Knowledge WikiがHermes的な自己改善loopへ完全接続されていない
15. text / artifact / built-in surface / generated surface / noneを決めるPresentation Plannerがない
16. Generated Surface Runtimeの汎用生成・永続化・操作・学習が未完成
17. Surfaceの再接続・再構築とUI責務分割が足りない
18. Collection定義の型とschema migrationが弱い
19. Artifactの改訂履歴と多形式Attachment取り込みが足りない
20. Pluginのprocess隔離、timeout、version互換性が足りない
21. SQLiteとfilesystemをまたぐ整合性、versioned migrationが足りない
22. Backup / Restore / Export / Importの失敗耐性が足りない
23. Automationの複数worker安全性と再起動復旧が足りない
24. Gatewayとowner accessの認証・重複排除・復旧が足りない
25. 観測性、resource上限、privacy、retentionが足りない
26. crash、競合、長時間運転、実adapterを含む最終検証が足りない

## 6. 各項目の詳細と実装方針

### 1. Core完成条件を機械的に判定する

**現状の弱さ**

- Backend契約の完了記録はあるが、Core全体の完了記録ではない。
- 「契約が存在する」と「再起動や実環境でも使える」が混ざりやすい。
- 計画ごとに完了条件が分かれ、全体が本当に閉じたか一度に判定できない。

**実装方針**

- 本書の50問をmachine-readableな `plans/core-completion-scorecard.json` にも持つ。
- `scripts/verify-core-completion.mjs` を追加し、各テスト結果と証拠ファイルを収集する。
- 結果は `reports/core-completion/latest.json` と `latest.md` に出す。
- 各項目に `test_id`、`command`、`evidence`、`score`、`timestamp`、`source_sha256` を持たせる。
- Core完成判定では、再現可能な自動試験と検証対象sourceのhashを正本にする。
- 24時間運転や実Dockerのような環境依存・長時間試験は、Core完成とは分けてrelease certificationへ記録する。
- 古い結果を流用できないよう、検証対象sourceのhashとschema versionが一致しなければ失効させる。clean worktreeとcommit SHA一致はrelease certificationで確認する。

**目標**

- `pnpm core:verify` 1回で、現在の点数と未完項目が分かる。
- 人の感覚ではなく、50問100点で完成を判定できる。

### 2. Runtime、Store、Server、Webの責務を物理的に分割する

**現状の弱さ**

- 4つの巨大ファイルに複数責務が集まり、修正の影響範囲が広い。
- Hostが調整役ではなく、詳細実装まで持ちやすい。
- テストが巨大なintegration testへ集中し、部分的な保証が難しい。

**実装方針**

- `packages/runtime/src/index.ts` は公開exportとcompositionだけにする。
- Runtime内を最低でも次へ分割する。
  - `host/`: 会話の進行とBackend選択
  - `commands/`: Domain Command Bus
  - `execution/`: Objective、Work Item、checkpoint
  - `context/`: context assembly、budget、compression
  - `presentation/`: Presentation PlannerとSurface生成
  - `backend/`: cassette adapter、run、stream、resume
  - `learning/`: `packages/learning` との接続だけ
- Storeは `repositories/`、`migrations/`、`transactions/`、`backup/`、`search/` に分割する。
- Serverは `routes/`、`middleware/`、`workers/`、`streams/`、`composition/` に分割する。
- WebはChat Shell、Context Drawer、各Renderer、Operation clientへ分割する。
- package entrypointは公開exportとcompositionへ絞る。通常moduleの行数は警告材料として記録できるが、1,200行や5,000行など固定の行数上限をCore完成の阻害条件にしない。
- module分割は行数ではなく、責務の混在、変更影響範囲、単体試験可能性、交換可能性で判断する。
- dependency testで、Server routeからStore mutationへの直接importなどを禁止する。

**目標**

- Hostは「何を呼ぶか」を決め、個別の保存・検索・学習処理を持たない。
- 各責務を単体でテスト・交換できる。
- 巨大ファイルを触らずに新しいBackendやRendererを追加できる。

### 3. 変更操作をCommon Domain Operationへ統一する

**現状の弱さ**

- Surface Operation、REST route、Backend tool、Gateway、Automationから別々の変更経路がある。
- 同じ「recordを更新する」操作でも、入口によりvalidation、監査、権限、idempotencyがずれる可能性がある。

**実装方針**

- `DomainCommandEnvelope` をCore schemaへ追加する。
- 必須項目は `command_id`、`kind`、`actor`、`source`、`session_id`、`idempotency_key`、`expected_version`、`payload`、`requested_at` とする。
- `DomainCommandBus.execute()` を唯一の変更入口にする。
- Web/DesktopのSurface Operation、Gateway入力、Automation、Backend tool callは、すべてDomain Commandへ変換する。
- 読み取りは `DomainQueryService` に分け、変更Commandと混ぜない。
- Action CatalogはCommand schemaからBackend tool schemaとSurface action schemaを生成する。
- 結果は `OperationRecord`、`WorkspaceChange[]`、`RenderSpec[]`、`AuditEvent[]` を共通形式で返す。
- direct Store mutationを静的検査で禁止する。許可するのはrepository内部、migration、recoveryだけにする。
- command単位でidempotencyとoptimistic concurrencyを保証する。

**目標**

- GUI操作もLLM操作もGateway操作も、同じCore操作になる。
- 入口が増えても、保存・権限・監査・学習の挙動がずれない。

### 4. 永続Objective / Work Itemモデルを追加する

**現状の弱さ**

- Chat sessionとBackend runはあるが、「何を達成するまで動くのか」を表す永続Objectiveがない。
- 長時間タスクを小さな作業に分け、依存関係や完了条件を追う正本がない。

**実装方針**

- 次の永続schemaを追加する。
  - `ObjectiveRecord`: 目的、完了条件、状態、予算、現在checkpoint
  - `WorkItemRecord`: instruction、親子、依存、優先度、状態、attempt、idempotency key
  - `WorkDependencyRecord`: 先行・後続関係
  - `RunCheckpointRecord`: backend session、event cursor、要約、生成resource、未完操作
- Objective状態は `active / paused / blocked / completed / cancelled / failed` とする。
- Work Item状態は `queued / ready / running / waiting / blocked / completed / failed / cancelled` とする。
- Objectiveは明示した完了条件を満たすまで自動でcompletedにしない。
- Chatから作った長時間依頼、Automation、Gateway依頼を同じObjectiveへ紐づける。
- 途中で追加された指示は、現在のWork Itemへのsteerか、新しい後続Work Itemかを明示して保存する。
- token、時間、attempt上限は任意設定できるが、上限未設定でも安全なsystem上限を持つ。

**目標**

- 何を目指し、今どこまで終わり、何が止めているかが常に分かる。
- Chatを閉じてもObjectiveが消えない。

### 5. lease、heartbeat、zombie回収、checkpointを追加する

**現状の弱さ**

- HTTP processやin-memory timerに実行所有権が寄っている。
- processが落ちた際、実行中のまま残る仕事や重複実行を自動で解消できない。

**実装方針**

- HTTP ServerとDurable Workerを論理的に分離する。同一process起動もできるが、所有権はDB leaseに置く。
- `claimWorkItem()` はSQLiteのatomic conditional updateで1 workerだけ成功させる。
- `lease_owner`、`lease_expires_at`、`heartbeat_at`、`attempt` を持たせる。
- Workerは一定間隔でheartbeatを更新する。
- lease失効した `running` はreconcilerが `ready` または `failed` に戻す。
- side effect前後にcheckpointを保存し、再開時にidempotency keyで二重実行を防ぐ。
- exponential backoff、retryable / non-retryable error、最大attemptを実装する。
- cancelはBackend、tool、Sandboxへ伝播し、最終状態が確定するまで追跡する。
- 起動時に必ずstale lease、running run、pending outboxをreconcileする。

**目標**

- processを強制終了しても、仕事が消えず、二重実行もせず、自動で続きから進む。
- 「実行中のまま永久に止まる」状態をなくす。

### 6. Backend実行状態とstreamを永続化する

**現状の弱さ**

- active run、event buffer、backend session IDの一部がprocess memoryにある。
- 再起動後に過去streamを再送できず、実行が不明状態になる可能性がある。

**実装方針**

- `BackendRunRecord` に cassette version、native session ID、working directory、pid metadata、last event sequence、resume capabilityを保存する。
- すべてのstream eventを連番付きappend-only event logへ保存する。
- clientは `after_sequence` から再購読できるようにする。
- arbitrary processへの危険な再attachは行わない。再attach可能なadapterだけnative resumeし、それ以外はcheckpointから新runとして再開する。
- Backend health、capability、cost、latency、circuit stateをRegistryへ記録する。
- fallbackは開始前またはidempotentなcheckpointからだけ許可し、Backend変更理由をrunへ記録する。途中の失敗を隠すsilent fallbackは禁止する。
- Backendごとに `start / stream / tool / wait / resume / cancel / crash / timeout` のconformance suiteを作る。
- cassette version互換性をmanifestで宣言し、非互換runは安全にblockedへ置く。
- 最低1つの実Backendでrun、tool call、wait、resume、cancelを確認する。

**目標**

- Server再起動後も、利用者から見るrun履歴とevent順序が途切れない。
- Backend差し替えが「型が合う」だけでなく、実動作でも保証される。

### 7. context予算・圧縮・長期要約を追加する

**現状の弱さ**

- 直近messageやsource数の上限はあるが、長期Sessionを保つ明確なtoken budgetと圧縮戦略がない。
- Sessionが長くなるほど、古い決定や未完作業を落としやすい。

**実装方針**

- Contextを次の層へ分ける。
  - Stable: principles、user model、固定Memory
  - Working: Objective、current Work Item、直近会話、checkpoint
  - Retrieved: Session、Wiki、Skill、Artifactから検索した情報
  - Volatile: tool result、stream中間結果
- 各層にtoken予算、優先度、切り詰め規則を持たせる。
- threshold超過時に、会話を永続summaryとdecision logへ圧縮する。
- checkpointには未完作業、決定、制約、resource参照を構造化して保存する。
- ContextHandoffに採用・除外source、token見積り、警告、圧縮理由を記録する。
- prompt実送信前にhard limitを検査し、silent truncationを禁止する。

**目標**

- 何千messageのSessionでも、目的・決定・未完作業を維持できる。
- なぜそのMemoryやSkillを使ったか説明できる。

### 8. User ModelとProfile分離を追加する

**現状の弱さ**

- `SOUL.md` と `PROFILE.md` はあるが、User情報を小さく保つ契約とprofile分離が弱い。
- 仕事用、個人用、テスト用のMemoryやSkillが混ざる可能性がある。

**実装方針**

- `USER.md` 相当の公開名は `USER_PROFILE.md` とし、Coreが読む短いUser Modelにする。
- 文字数またはtoken上限を設け、事実、好み、禁止事項、確認が必要な判断を区別する。
- 長い履歴や根拠はMemory/Wikiへ置き、User Modelには要約とsource refだけを置く。
- `ProfileRecord` を追加し、Workspace root、Session、Memory、Skill、SecretRef、Automationをprofileで分離する。
- profile switch、export、import、cloneを追加する。
- Backendへ渡すUser Modelはprofile scopeを超えないようにする。

**目標**

- Coreが利用者を理解しつつ、古い情報や別用途の情報を混ぜない。
- 環境を変えてもProfile単位で再現できる。

### 9. 検索を増分索引・rank付きへ強化する

**現状の弱さ**

- Session SearchはFTS5を持つが、検索時reindexやexact phrase寄りの挙動が残る。
- Session、Memory、Wiki、Artifact、Collectionを横断したrankと説明可能性が弱い。

**実装方針**

- create/update/delete時にindexを更新する増分方式へ変える。
- FTS5のBM25、recency、resource type、scope、pinned、source trustを組み合わせたdeterministic rankを実装する。
- 日本語tokenizationの品質をfixtureで保証する。
- optionalなembedding providerをadapterとして追加し、keyword検索とのhybrid rerankを可能にする。
- embeddingがなくても必ず動くdeterministic fallbackを維持する。
- 結果に `matched_fields`、`score_breakdown`、`source_ref` を返す。
- index versionとrebuild jobを持ち、破損時に再構築できるようにする。

**目標**

- 過去の会話や成果物を、手作業で探さず再利用できる。
- 検索結果が出た理由を説明できる。

### 10. Background Reviewを厳密かつ原子的にする

**現状の弱さ**

- LLM出力をJSON化した後のmutation validationが浅い。
- 複数mutationの途中で失敗すると、一部だけ反映される可能性がある。

**実装方針**

- mutation kindごとにdiscriminated unionのZod schemaを作る。
- resource existence、expected version、scope、source traceを適用前にすべてpreflightする。
- 全mutationをsnapshot + transaction単位で適用する。
- 1件でもvalidationまたはwriteに失敗したら全体をrollbackする。
- `review_proposal` と `review_application` を分離し、入力、判断、適用差分を保存する。
- 同じproposalを再実行しても重複しないidempotency keyを持つ。
- dry-run reportと実適用reportを明確に区別する。

**目標**

- LLMが不正なJSONや矛盾した変更を返しても、Workspaceを部分破損させない。
- 何を学習候補にし、何を実際に保存したか追跡できる。

### 11. 訂正・差し戻しを学習信号として記録する

**現状の弱さ**

- correction countなどが実際の利用者操作から十分に作られていない。
- 「やり直して」「違う」「元に戻す」「この形式を今後使う」といった重要な信号を評価に使い切れていない。

**実装方針**

- 次を `LearningSignalRecord` として記録する。
  - 明示的な良い・悪い評価
  - 訂正message
  - undo / rollback
  - 同じ目的でのrerun
  - Artifactの大幅revision
  - tool error後の手動修正
  - Skill採用・不採用
- 信号にはsession、objective、work item、run、resource、source messageを紐づける。
- 自動推定信号と利用者の明示信号を分け、明示信号を強く扱う。
- privacy scopeとretentionを持たせる。
- Userが「学習に使わない」と指定したSessionは除外する。

**目標**

- 成功回数だけでなく、「どこを直されたか」から改善できる。
- 学習根拠を利用者へ説明し、削除できる。

### 12. Evaluationの比較を信頼できるものにする

**現状の弱さ**

- task classがBackend種別に寄っており、内容の違う仕事を比較する可能性がある。
- beforeが複数run、afterが1runなど、比較条件が揃いにくい。
- 自動改善の因果関係を断定しにくい。

**実装方針**

- `TaskFingerprint` を intent、domain、operation kinds、tool sequence、output kind、expected checksから生成する。
- 同じfingerprintまたは互換cohortだけをbefore/after比較する。
- 最小sample数、confidence interval、外れ値規則を設定する。
- success、correction、latency、cost、retry、artifact validityを別指標で持つ。
- benchmark fixtureを作り、学習前後を同じ入力・同じBackend条件でreplayする。
- sample不足や差が小さい場合は `inconclusive` とし、昇格や廃止を自動実行しない。
- evaluation formulaとversionを保存し、後から再計算できるようにする。

**目標**

- 「たまたま上手くいった」を「学習で改善した」と誤判定しない。
- 改善が速度だけでなく、品質・安全・費用を悪化させていないと確認できる。

### 13. Curatorを意味・衝突・usageまで見て判断させる

**現状の弱さ**

- Memoryの重複判定やSkill統合候補が、正規化文字列や単純なgroupingに寄る。
- usage countが判断に十分反映されていない。
- 内容が似ているが指示が衝突するSkillを安全に扱いにくい。

**実装方針**

- FTSで候補を絞り、必要な候補だけsemantic similarityまたはLLM adjudicationへ渡す。
- resource間に `duplicate / overlaps / conflicts / supersedes / derived_from` edgeを持つ。
- Skill lifecycleに利用回数、成功率、訂正率、最終利用日、適用scope、source trustを使う。
- merge時はsource trace、support files、capability、Backend条件を失わない。
- conflictは自動mergeせず、scope分離かreview待ちにする。
- Curator runごとにsnapshot、plan、applied diff、rollback pointを保存する。
- 同じrunを再実行しても二重統合しない。

**目標**

- MemoryとSkillが増え続けても、重複・古さ・矛盾で品質が落ちない。
- 自動整理を安全に元へ戻せる。

### 14. Knowledge WikiをHermes的な自己改善loopへ完全接続する

**この項目の位置づけ**

Hermes AgentのMemory / Skill / Reflection / Curatorを参照しつつ、濃い業務知識を独立したKnowledge Wikiとして改善loopへ接続する部分は、Samurai Agent独自の統合である。

**現状の弱さ**

- activeなKnowledge WikiはContextへ入り、どのrunで使ったかも `LearningResourceUseRecord(resource_kind=wiki)` に記録される。
- Wiki利用runはEvaluation対象になり、Curatorもproposedまたは未検証Wikiをreview候補へ出せる。
- 一方、Hermes型Background Reviewの直接mutationはMemory / Skill中心で、Wikiの作成、patch、統合、弱体化まで同じloopで閉じていない。
- UI生成でWikiが使われても、「どの知識が表示判断や画面構成に役立ったか」を区別できない。
- Wikiの重複、矛盾、古い判断、後継ページの関係がEvaluationとCuratorへ十分に渡らない。

**責務分離**

| Resource | 保存するもの | 保存しないもの |
| --- | --- | --- |
| Memory | ユーザーの短い好み、重要ルール、個人理解 | 長い調査記事、HTMLそのもの |
| Knowledge Wiki | 業務知識、判断理由、設計、プロジェクト規則、UIに必要な意味知識 | 実行手順、生成済みUI bundle |
| Skill | 繰り返し使う作業手順、UI構成手順、Backend別手順 | 個別案件の正本データ |
| Generated Surface | 実際に生成したHTML / CSS / 限定JavaScriptとaction宣言 | Collection / Artifactの正本データ |
| Collection / Artifact | UIが表示・変更する業務データと成果物 | 学習判断そのもの |

**完成させるloop**

```text
active Knowledge Wikiを検索
↓
runまたはGenerated Surface生成で使用
↓
Wiki ID / version /利用箇所を記録
↓
完了・訂正・再生成・UI操作結果をLearning Signalへ接続
↓
Evaluationが「このWikiを使った同種作業」を比較
↓
Background Reviewがcreate / patch / archive / merge候補を作る
↓
Curatorが重複・衝突・supersedeを整理
↓
次回runが更新後Wikiを再利用
```

**実装方針**

- `ReviewSnapshot` に `existing_wiki_catalog`、実際に利用したWiki本文の対象断片、Wiki version、利用目的を追加する。
- Background Reviewは、今回実際に読み込まれたWikiを最優先でpatch候補にし、無関係な全Wikiを毎回promptへ載せない。
- Wiki review forkが使える操作は、Wikiの型付きmutation、Memory、Skill、検索readだけに限定する。shell、web、一般file write、外部送信は許可しない。
- `BackgroundReviewMutation` に次を追加する。
  - `wiki_create`
  - `wiki_patch`
  - `wiki_archive`
  - `wiki_merge`
- `knowledge_wiki_capture_mode` を `auto / suggest / off` として適用する。
  - `auto`: localで検証可能なsource refsがあり、schema・conflict・version検査を通った変更を自動保存する。
  - `suggest`: `proposed` で保存し、active retrievalには入れない。
  - `off`: 読み取りと利用記録だけ行い、mutationしない。
- External Providerだけに由来する内容は、capture modeが`auto`でも自動active化しない。verified sourceまたは別のlocal evidenceが揃うまで`proposed`に留める。
- `LearningResourceUseRecord` に `purpose=context / decision / surface_generation / domain_action` と、採用したWiki section refを追加する。
- `LearningSignalRecord` にWiki訂正、根拠差し替え、Generated Surface再生成理由、UI内修正を紐づける。
- EvaluationはTaskFingerprintが同じrunだけを比較し、Wiki利用の有無、version差、訂正率、成果物妥当性、Generated Surface利用結果を分離して計測する。
- CuratorはWiki間の `duplicate / overlaps / conflicts / supersedes / derived_from` edgeを管理する。
- ownerがpinしたWikiはarchive、merge、supersede対象から除外する。本文patchは設定で許可できるが、変更履歴を必ず残す。
- Curatorはidle gateと定期intervalを持ち、最初の自動実行前に1 interval待つ。manual dry-runはいつでも実行できる。
- Wiki mutation全体をLearning snapshot、transaction、rollback pointで囲み、途中失敗時は一部だけ反映しない。
- 各runにJSON reportと人間向け短いsummaryを残し、create / patch / merge / archive / no-changeの件数を出す。
- Wiki本文にはsource refs、provenance、source run、review run、変更理由を残す。
- Background Reviewが何も変えない判断も正式に記録し、更新回数を増やすこと自体を目標にしない。

**目標**

- Knowledge Wikiが単なる検索棚ではなく、利用結果に応じて育つ業務知識になる。
- 「どのWikiが、どの仕事やUI判断に役立ったか」を説明できる。
- 誤った知識は訂正・弱体化・archive・rollbackできる。
- Memory、Wiki、Skill、Generated Surfaceの役割を混ぜずに、1つの自己改善loopとして循環する。

### 15. Presentation Plannerを追加する

**現状の弱さ**

- RenderSpecの種類は多いが、「文章だけで返す」「Artifactを作る」「操作Surfaceを出す」「何も出さない」の判断が明示的な責務になっていない。
- keywordやrouteごとの個別判断に寄ると、不要な画面を出したり、必要な操作面を出せなかったりする。

**実装方針**

- `PresentationDecision` を追加し、`text / artifact / built_in_surface / generated_surface / none` を選ぶ。
- 判断材料はuser intent、操作可能性、結果の構造、再利用性、client capability、privacy、生成costとする。
- deterministic ruleを先に適用し、曖昧な場合だけBackendのstructured outputを使う。
- `reason`、`confidence`、`resource_refs`、`render_specs` を保存する。
- 表示しない選択も正式な結果として扱う。
- 代表prompt fixtureを用意し、不要なUIを出さないprecisionと、必要なUIを出すrecallを測る。
- PlannerはWorkspaceを直接変更せず、Domain Command結果を表示へ変換するだけにする。

**目標**

- Chatが常に主役で、必要なときだけ適切なUIが出る。
- Mulmo的な豊かな表示を持ちながら、アプリ中心に戻らない。

### 16. Generated Surface Runtimeを完成させる

**この項目の位置づけ**

Generated Surfaceは、独立したアプリを毎回作る機能ではない。既存Rendererだけでは作業しにくい時に、会話とWorkspaceの文脈から一時的またはピン留め可能な操作面を生成するCore機能である。MulmoClaudeのHost / Workspace / LLM Wiki / Plugin /豊かな生成物の考え方を参照しつつ、Samurai AgentではCommon Domain Operationと学習loopへ接続する。

**現状の弱さ**

- `custom_view.html` をBackendへ要求し、sandbox iframeで表示する細い縦線は存在する。
- iframe内のaction IDをHostへ返すcapability handoffも存在する。
- ただし主にCollection actionの `output_surface=custom_view` に依存し、通常ChatからPresentation Plannerが自動選択する汎用経路ではない。
- 現在のgeneric `custom_view.action` は操作内容をstructured Artifactとして残す経路が中心で、宣言した業務操作を必ずDomain Commandとして実行するところまで閉じていない。
- 生成HTMLはfirst-classなversioned resourceではなく、reload、別client、pin、再利用、差分修正が弱い。
- 生成UIを開いた、使った、閉じた、再生成した、修正した結果がLearning Signalになっていない。

**実装方針**

生成可能な範囲、Core schema、Workspace正本、Runtime pipeline、制限付きBridge、Learning接続を1つの契約として実装する。

**生成対象と非対象**

- 生成してよいもの:
  - HTML
  - CSS
  - iframe内だけで動く限定JavaScript
  - 宣言済みaction
  - read-onlyの表示変換
  - local draft state
- 生成しないもの:
  - 独自DB
  - 独自認証
  - Coreを迂回するAPI
  - raw secret参照
  - Workspaceへの直接file write
  - 任意shell command
  - 背景で常駐する独自server

**Core schema**

- `SurfaceGenerationRequest`
  - user intent
  - source resource refs
  - allowed Domain Commands
  - selected Knowledge Wiki / Skill refs
  - client capabilities
  - expected lifetime
  - fallback
- `GeneratedSurfaceDefinition`
  - surface ID
  - state: `ephemeral / pinned / archived`
  - title
  - HTML / CSS / script bundle refs
  - input data schema
  - action declarations
  - capability manifest
  - source refs
  - generation run
  - content hash
  - current revision
  - preview URL
  - fallback chain
- `GeneratedSurfaceRevisionRecord`
  - surface ID / revision ID / parent revision
  - producer run
  - prompt fingerprint
  - Knowledge Wiki / Skill versions
  - bundle hash
  - validation report
  - created at
- `SurfaceInteractionRecord`
  - opened / action / corrected / regenerated / pinned / unpinned / dismissed
  - session / message / surface / revision / command / result
  - user feedback

**Workspace正本**

```text
workspace/surfaces/<surface-id>/
  surface.json
  revisions/<revision-id>/
    index.html
    style.css
    script.js
    manifest.json
```

- pinされたGenerated Surfaceとrevision bundleはfilesystemを正本にする。
- ephemeral SurfaceはSession timelineとretention policyに従い、必要なら自動削除する。
- SQLiteはSurface index、状態、revision relation、interaction、利用回数、message/run紐づけを持つ。
- Collection / Artifact / Memory / Wiki / SkillのデータをHTMLへ複製して正本化しない。Surfaceは常にresource refsから現在値を読む。
- pin済みまたは再利用対象のHTMLは実ファイルをpath-based URLで配信し、相対asset、reload、cache bust、print/exportを成立させる。
- ephemeral previewだけは`srcdoc`を許可するが、base URLとasset解決規則を明示する。

**Runtime pipeline**

1. Presentation Plannerが文章、Artifact、built-in Surface、Generated Surface、追加表示なしを選ぶ。
2. built-in Rendererで要求を十分に満たせる場合はそちらを優先する。
3. 固定部品では情報関係や操作手順を表現しにくい場合、`SurfaceGenerationRequest` を作る。
4. Hostは必要なCollection / Artifact、active Knowledge Wiki、選択済みSkill、client capabilityだけをBackendへ渡す。
5. BackendはHTML / CSS /限定scriptと、action宣言をstructured outputで返す。
6. `GeneratedSurfaceCompiler` がschema、size、DOM、script、network、action、accessibility最低条件を検証し、ephemeral用`srcdoc`または永続用bundleを作る。
7. `GeneratedSurfaceRuntime` はsandbox iframeで表示する。defaultはscripts許可、same-origin不許可、`connect-src none`、Workspace直接アクセス不許可とする。外部assetやnetworkはcapability allowlistがあるrevisionだけ許可する。
8. UI actionは `action_id + payload` だけをHostへ返し、Action Catalogで解決した`DomainCommandEnvelope`として実行する。
9. Domain Command結果を再取得し、Surfaceへ新しいread modelを渡す。Generated Surface自身が状態の正本にならないようにする。
10. unsupported client、validation failure、runtime errorではbuilt-in Surface、Artifact、textの順でfallbackする。
11. reload、reconnect、別clientではdefinition、revision、resource refsから再構築する。
12. pin、unpin、revision、archiveをDomain Commandとして扱う。
13. source reviewまたは自然言語修正は既存bundleを上書きせず、新しいrevisionを作る。
14. file change eventまたはDomain Command完了eventを購読し、iframe全体を作り直さず必要なread modelだけを更新できるようにする。
15. pin済みSurfaceはsource bundle、manifest、参照assetをzip exportでき、必要ならPDFまたは静的HTMLへ出力できるようにする。

**Generated Surface Runtime Bridge**

iframeへHost内部objectを直接渡さず、次の制限interfaceだけを提供する。

```text
dispatch(action_id, payload)
subscribe(resource_ref | event_kind)
read(resource_ref)
getLocale()
log(level, message)
notify(message)
```

- `dispatch` は宣言済みactionだけをDomain Commandへ変換する。
- `subscribe` はSurface scope内のresource eventだけを受け取る。
- `read` はcapability manifestにあるResourceRefだけをread modelとして返す。
- `log` と `notify` はsurface ID / revision ID / session IDを自動付与する。
- genericなfilesystem、raw fetch、secret、Host DOM accessは渡さない。

**Knowledge Wiki / Skill / Learningとの接続**

- Knowledge Wikiは「何を見せるべきか」「業務上なぜ重要か」を提供する。
- Skillは「どのような操作面を組み立てるか」「どの順番で確認させるか」を提供する。
- Memoryはユーザー個人の表示好みを短く提供する。
- Generated Surfaceは実際の画面bundleだけを持つ。
- Surface生成時に使ったWiki / Skill / MemoryのIDとversionをuse traceへ保存する。
- open率、action完了率、訂正、再生成、dismiss、pin、同じSurfaceの再利用をLearning Signalへ保存する。
- Background Reviewは、個別HTMLをMemoryやWikiへ貼り付けず、再利用可能な判断をWikiへ、作り方をSkillへ、画面bundleをGenerated Surface revisionへ分けて更新する。
- Evaluationは同じTaskFingerprintでbuilt-in Surface、初回Generated Surface、学習後Generated Surfaceを比較する。
- Curatorは使われないSurface revisionを整理し、再利用される生成patternをSkill候補へ昇格する。

**目標**

- カンバンやカレンダーの組み合わせだけでは表現できない操作面を、必要な瞬間に生成できる。
- 生成UIのボタンが見せかけではなく、本当のWorkspace状態をCommon Domain Operation経由で変更できる。
- 生成UIを閉じても仕事状態は残り、必要なら同じSurfaceを再構築・pin・再利用できる。
- 利用者の修正を次回のUI構成へ反映し、使うほど「その人と仕事に合う画面」が出る。

### 17. Surfaceの再接続・再構築とUI責務分割を完成させる

**現状の弱さ**

- RenderSpecはあるが、reloadや別client接続後に同じ表示・入力状態を完全再構築する契約が弱い。
- `App.vue` にShellとRendererの責務が集中している。

**実装方針**

- `SurfaceInstanceRecord` にsession、operation、render spec version、resource refs、local state、expires policyを保存する。
- clientはsession timelineからSurfaceを再構築する。
- form入力途中などのdraftは、明示した保存規則でlocalまたはWorkspaceへ保存する。
- rendererを種類ごとのcomponentへ分け、共通のloading、error、approval、fallback wrapperを持たせる。
- capability不足時は `fallback_chain` に従い、table→artifact→textのように安全に縮退する。
- reconnect時はevent sequenceを使い、同じSurfaceを二重追加しない。
- 見た目E2Eは必須にしない。schema、component、API replayで機能を保証する。

**目標**

- 再読み込みやDesktop/Web切替後も、作業の続きが見える。
- Renderer追加がApp全体の改修にならない。

### 18. Collection定義を強く型付けし、migration可能にする

**現状の弱さ**

- field、ref、derived、trigger、action、viewが汎用record寄りで、壊れた定義を保存できる余地がある。
- schema変更後の既存record移行契約が弱い。

**実装方針**

- field typeごとのdiscriminated unionを作る。
- ref、embed、derived、trigger、action、viewも個別schemaへ分ける。
- `schema_version` と `CollectionMigration` を追加する。
- migrationはrename、add default、type conversion、split、merge、ref repairを表現できるようにする。
- preview、validate、apply、rollbackを分離する。
- recordにはschema versionとoptimistic versionを持たせる。
- derived fieldとtriggerは依存graphを作り、cycleを拒否する。
- Human操作とAgent操作はDomain Command Bus経由で同じvalidationを通す。

**目標**

- Collectionを長期間使い続けても、schema変更でrecordが壊れない。
- table、gallery、calendar、kanbanが同じ構造化データを安全に表示する。

### 19. Artifact改訂履歴と多形式Attachment取り込みを追加する

**現状の弱さ**

- Artifactの作成・参照はあるが、改訂履歴、欠損修復、大きいファイルの扱いが弱い。
- Chat入力は画像中心で、文書や表計算の内容をCore contextへ取り込む共通pipelineがない。

**実装方針**

- `ArtifactRevisionRecord` を追加し、hash、parent revision、producer run、source refs、mime、sizeを保存する。
- original fileは不変として保存し、抽出textやpreviewはderived artifactにする。
- PDF、text、DOCX、XLSX、PPTXのextractor adapterを追加する。
- extractorはSandbox workerで実行し、mime、size、page/sheet上限を検査する。
- 変換失敗時もoriginalを失わず、再試行可能な状態を残す。
- exportは内容hashとmanifestを含み、再import後も参照を復元できるようにする。
- missing file、hash mismatch、orphan revisionをdoctorで検出・修復する。
- 大容量fileはstreamingし、全体をmemoryへ読み込まない。

**目標**

- Mulmo的に多様な入力と成果物を扱える。
- どの入力から何が作られたかを後から追える。

### 20. Pluginを隔離し、互換性と失敗境界を持たせる

**現状の弱さ**

- manifestと署名はあるが、Plugin codeがHost processへ与える影響を十分に隔離できていない。
- Plugin更新時のschema/API互換性や、途中crash時の扱いが弱い。

**実装方針**

- Plugin handlerはWorker Threadまたはchild processで実行し、serialize可能なinput/outputだけを渡す。
- filesystem、network、secret、command実行はmanifest capabilityで許可する。
- timeout、memory上限、cancel、crash isolationを持たせる。
- manifestに `plugin_api_version`、`min_core_version`、`max_core_version`、migrationを追加する。
- install、enable、disable、upgrade、rollbackの状態遷移を保存する。
- Pluginが作ったArtifact、Collection、Operationにplugin ID/versionを残す。
- 署名不正、version非互換、timeout、crashのfixtureを作る。

**目標**

- Pluginを増やしてもCore本体が落ちない。
- 更新後に壊れた場合、前versionへ安全に戻せる。

### 21. SQLiteとfilesystemをまたぐ整合性を完成させる

**現状の弱さ**

- versioned migration ledgerと明示的transaction境界が弱い。
- DB更新とfile更新の途中でprocessが落ちると、片方だけ残る可能性がある。

**実装方針**

- SQLite起動時に `foreign_keys=ON`、WAL、`busy_timeout`、適切な`synchronous`を明示する。
- `schema_migrations` tableでversion、checksum、applied_atを管理する。
- migrationを順序付きfileへ分割し、fresh installと全旧versionからのupgradeをテストする。
- DB内だけの更新はtransactionでまとめる。
- fileを含む更新は `.staging/<operation_id>` とtransactional outboxを使う。
- 流れは `stage file → DB pending + outbox → atomic rename → DB commit state` とし、起動時recoveryで完了またはrollbackする。
- record更新にはversionを持たせ、lost updateを拒否する。
- lock取得はread後writeではなく、条件付きUPDATE 1回で行う。

**目標**

- どの瞬間にprocessを落としても、DBとfileが説明不能な不一致にならない。
- 複数workerが同時に動いても更新を失わない。

### 22. Backup / Restore / Export / Importを原子的にする

**現状の弱さ**

- Backupはあるが、Restore途中の失敗でWorkspaceが半分だけ戻る危険がある。
- 別machineへの移行やschema差を含むportabilityの証明が弱い。

**実装方針**

- Backup前にWAL checkpointを行い、manifest、schema version、file hash一覧を作る。
- Restoreは現在Workspaceを直接消さず、別staging rootへ展開・検証する。
- 検証成功後にdirectoryとDBをatomic swapする。
- swap前に自動pre-restore backupを作る。
- 途中失敗時は元Workspaceをそのまま維持する。
- ExportはProfile scope、Secret除外規則、Artifact inclusion policyを明示する。
- Importはdry-runで衝突、容量、version、欠損を先に報告する。
- 旧version backupから最新versionへのrestore試験を持つ。

**目標**

- Backupが「作れる」だけでなく、壊さず必ず戻せる。
- 別machineでもWorkspaceとProfileを再現できる。

### 23. Automationをdurable worker化する

**現状の弱さ**

- 永続jobはあるが、process-local schedulerと非原子的lockでは、複数process時に重複実行する可能性がある。
- 実行中に落ちたjobの回収と再試行が弱い。

**実装方針**

- schedule計算とjob実行を分離する。
- due jobはWork Itemへ変換し、共通worker leaseで実行する。
- recurring jobは次回時刻をtransaction内で更新する。
- `agent` modeと、定型Domain Commandだけを行う`no-agent` modeを分ける。
- pause、resume、edit、remove、run-nowをDomain Commandにする。
- timezone、DST、missed run policy、overlap policyを明示する。
- 同時worker、再起動、時刻飛び、失敗retryのfixtureを作る。

**目標**

- AutomationがServer再起動やworker複数台でも、抜け・二重実行なく動く。
- LLM不要の定型処理は安く確実に実行できる。

### 24. Gatewayとowner accessを安全・永続にする

**現状の弱さ**

- localhost前提の開いたCORSや一般API認証不足は、owner-hosted remote modeでは使えない。
- Gateway session、delivery、dedupが再起動をまたぐ保証が弱い。

**実装方針**

- local APIにもinstall時生成のBearer tokenを要求し、Web/Desktopへ安全に注入する。
- remote modeではTLS前提、origin allowlist、token rotation、rate limitを必須にする。
- inbound Gateway eventに署名検証、nonce、timestamp、dedup keyを持たせる。
- inboundはDomain Command Busへ入り、通常Chatと同じsession/objectiveを使う。
- outbound deliveryはpersistent queue、attempt、backoff、dead letterを持つ。
- Gateway session mapping、last sequence、delivery receiptを永続化する。
- request/upload size、mime、SSRF、private metadata IP、redirectを検査する。
- Secret値はlog、event、learning sourceへ入る前にredactする。

**目標**

- localでもremoteでも、オーナー以外がCoreを操作できない。
- Gatewayを再起動しても会話と配信状態が途切れない。

### 25. 観測性、resource上限、privacy、retentionを追加する

**現状の弱さ**

- doctorやdiagnosticはあるが、1つの依頼を入口から学習まで横断して追う標準IDと指標が不足している。
- event、trace、Artifact、indexが増え続けた場合の上限と削除規則が弱い。

**実装方針**

- `request_id → command_id → operation_id → objective_id → work_item_id → run_id → tool_call_id → workspace_change_id → learning_run_id` を相互参照できるようにする。
- structured logとmetricsを追加し、latency、queue depth、retry、token、cost、error、recovery、curator resultを計測する。
- healthをHTTP、worker、DB、Backend、Gateway、index、outbox別に返す。
- queue上限、concurrency上限、file上限、context上限、stream buffer上限を設定する。
- event log、trace、temporary artifact、index、backupのretention policyを追加する。
- redactionを保存前に行い、Secret patternと個人情報scopeをtestする。
- 利用者がSession、Memory、Learning evidenceを削除・exportできるようにする。

**目標**

- 問題が起きた時に、どこで止まり、何が再試行され、何が保存されたか分かる。
- 長期運転しても容量と費用が無制限に増えない。

### 26. Core完成検証とrelease certificationを分離する

**現状の弱さ**

- unit、typecheck、API integrationは強いが、process crash、複数worker競合などCoreで必須の耐障害性を一度に確認する入口が必要である。
- 24時間運転や実Dockerなど、環境や時間に依存する認証をCore完成条件へ混ぜると、実装が完成していても完了判定できない。
- 完全一致した不要コピーや秘密情報がrelease候補へ混ざるのを自動で防ぐ必要がある。

**実装方針**

- 最後の50問を `pnpm core:verify` で集約する。
- 変更中は関連テストだけを実行し、Core完成時に再現可能な自動テスト一式を1回実行する。
- unit、contract、integration、restart、race、failure injection、加速soakの層を分ける。
- DB write、file rename、Backend event、Gateway deliveryの各地点へfailure injection pointを置く。
- 10 worker競合、process kill、network切断、disk full疑似、破損index、古いbackupを試験する。
- Core完成では、100 Objective、1,000 job、定期killを含む加速soakを通す。
- 最低1つの実Backendと、1つの署名付きGateway fixtureを通す。
- 実Docker E2EはDocker Sandboxを正式に有効化して提供するreleaseの前に実施する。Docker未導入環境ではCore完成を阻害しない。
- 24時間soakは24時間常時運転を正式提供する直前の任意release certificationとして実施する。
- 完全一致した不要コピー、秘密情報、意図しない生成物をrelease verifierで検知する。類似コードの統合や大規模refactorは別タスクにする。
- Core完成の証拠は検証対象sourceのhash付きreportへ保存する。clean worktreeとcommit SHA一致はrelease certificationで確認する。

**目標**

- Coreの実装不足と、release前だけ必要な環境依存認証を混ぜずに確認できる。
- 100点未満なら、Coreで本当に未完の機能がどこか即座に分かる。

## 7. 実装順序

一度で仕上げるが、依存関係を無視して同時に触らない。次の6段階で進める。

### Phase 1: 完成判定と境界固定

- 項目1: ScorecardとVerifier
- 項目2: 物理分割
- 項目3: Domain Command Bus

この段階で、以後の実装がどの責務へ入るかを固定する。

### Phase 2: 永続実行基盤

- 項目4: Objective / Work Item
- 項目5: lease / heartbeat / checkpoint
- 項目6: Backend persistence
- 項目23: Durable Automation

ここまでで、長時間タスクが再起動をまたいで動くようにする。

### Phase 3: Workspaceの壊れにくさ

- 項目21: transaction / outbox / migration
- 項目22: atomic backup / restore / portability
- 項目24の認証・persistent delivery部分

学習やUIを増やす前に、保存基盤を完成させる。

### Phase 4: Hermes的な理解と改善

- 項目7: context budget / compression
- 項目8: User Model / Profile
- 項目9: Retrieval
- 項目10〜13: Review / Signal / Evaluation / Curator
- 項目14: Knowledge Wiki self-improvement loop

学習処理は必ず、Phase 3のtransactionとrollbackを使う。

### Phase 5: Mulmo的な表現と成果物

- 項目15: Presentation Planner
- 項目16: Generated Surface Runtime
- 項目17: Surface lifecycle
- 項目18: Collection migration
- 項目19: Artifact / Attachment
- 項目20: Plugin isolation

UI生成はCoreの判断・resource・operationを表示する層として実装する。

### Phase 6: Hardeningと100点試験

- 項目25: Observability / limits / privacy
- 項目26: crash / race / soak / real adapter
- 50問をすべて2点にする

## 8. 完了条件としての100点テスト

### 8.1 採点ルール

- 全50問、各2点満点。合計100点。
- **2点**: 指定された実装があり、Core完成に必要な再現可能な自動試験がすべて成功している。
- **1点**: 契約や単体試験はあるが、再起動・競合・failure injectionなどCoreで必須の条件が一部未確認。
- **0点**: 未実装、または必須試験が失敗している。
- `N/A`、免除、四捨五入、平均点での代替は認めない。
- **100/100かつCore必須gate成功の場合だけCore完成**とする。release certificationの未実施はCoreの点数を下げない。
- Browserで見た目を確認するE2Eは採点対象外。Core API、protocol、component、replayの試験で代替する。

### 8.2 共通テスト基準値

「基準を満たした」の意味が曖昧にならないよう、初回の完成判定では次の値を固定する。将来値を変える場合は、Scorecard versionも上げる。

| 対象 | 完成判定の基準値 |
| --- | --- |
| Command重複 | 同一idempotency keyを100並列送信し、side effect 1回、返却result ID 1種類 |
| Worker競合 | 10 worker、1,000 Work Itemで二重claim・二重side effect 0件 |
| Zombie回収 | test lease失効後30秒以内にreclaim。本番値は設定可能 |
| Event継続 | 10,000 eventで欠落0、重複0、sequence逆転0 |
| Long Session | 10,000 message、埋め込み済み重要決定100件のうち95件以上を正しく保持し、prompt hard limit超過0 |
| Presentation Planner | 人手で期待値を固定した100 promptで`text / artifact / built_in_surface / generated_surface / none`のmacro F1 0.90以上、不要なSurface表示5%以下 |
| Generated Surface | 固定30 taskの90%以上で要求UIを生成し、schema/action検証100%、Domain Command迂回0、reload後bundle hash一致100% |
| Retrieval | 100 queryでRecall@5 0.90以上、MRR@10 0.80以上。日本語subsetもRecall@5 0.85以上 |
| Learning改善 | 固定30 taskで主要品質scoreがbaseline比5%以上改善し、safety失敗0件、訂正率悪化0、costとlatencyの悪化は各20%以内 |
| Wiki自己改善 | 固定20 taskでsource→利用→signal→evaluation→mutation→次回利用の証拠欠損0、採用済み訂正の次回反映90%以上、無関係taskへの誤適用0 |
| Collection migration | 10,000 record移行で欠損0、参照切れ0、rollback後hash一致 |
| Attachment | 各対応形式の正常・破損・上限超過fixtureを通し、original hashとsource trace欠損0 |
| Security | 認証、CORS、SSRF、path traversal、upload、redactionの全fixtureで既知bypass 0件 |
| Core Soak | 加速実行で100 Objective、1,000 job、定期的なprocess killを含め、stuck・duplicate・orphan・data loss 0件 |

24時間soakは常時運転を正式提供する直前のrelease certificationとして別に記録し、Core完成の必須基準には含めない。

### 8.3 必須gate

点数とは別に、次のどれか1つでも失敗したら未完成とする。

1. 全workspaceのtypecheck成功
2. 全unit / contract / integration test成功
3. migration fresh / upgrade test成功
4. restart / crash recovery test成功
5. multi-worker race test成功
6. 100 Objective、1,000 job、定期killを含む加速soak成功
7. 最低1つの実Backend E2E成功
8. 署名付きGateway fixture E2E成功
9. secret scan、dependency audit、完全一致duplicate source scan成功
10. `git diff --check` 成功
11. Scorecard reportのsource hashが検証対象sourceと一致
12. Generated Surfaceの生成、sandbox、Domain Command、reload、pin、fallback試験成功
13. Knowledge Wikiの利用、Evaluation、Background Review、Curator、rollback閉ループ試験成功

24時間soak、実Docker E2E、clean worktree、reportのcommit SHA一致はrelease certificationで確認する。

### 8.4 Scorecard

#### A. Architecture / Domain Operation — 7問、14点

| ID | テスト質問 | 2点の条件 |
| --- | --- | --- |
| A01 | Runtime、Store、Server、Webは責務別moduleへ分割されたか | entrypointがcomposition/export中心で、責務directoryとdependency boundary testを通る。通常moduleの行数は警告に留める |
| A02 | すべての変更入口がDomain Command Busを通るか | Runtime API、Gateway、Automation、Backend tool、Generated Surfaceのmutation fixtureが同じBusを通り、Web/DesktopがServer API境界を使い、direct mutation scanが0件 |
| A03 | 同じ操作は入口が違っても同じ結果になるか | 代表10操作を5入口から実行し、validation、change、audit、render resultが同値 |
| A04 | Commandの重複送信を安全に処理できるか | 同じidempotency keyを100回並列送信してside effectが1回だけ |
| A05 | 古い画面やclientの上書きを防げるか | stale `expected_version` を拒否し、最新状態と再試行方法を返す |
| A06 | Action Catalog、Backend tool、Surface actionのschemaがずれないか | 1つのcommand schemaから生成され、golden contract testが全Backendで一致 |
| A07 | 禁止依存と責務の逆流がないか | route→Store mutation、Learning→UI、Renderer→DBなどのforbidden importが0件 |

#### B. Durable Execution / Backend — 8問、16点

| ID | テスト質問 | 2点の条件 |
| --- | --- | --- |
| B01 | ObjectiveとWork Itemは再起動後も残るか | 依存付きObjective実行中にkillし、再起動後に同じ状態と完了条件を復元 |
| B02 | 複数workerで同じ仕事を二重実行しないか | 10 workerが同時claimして1 workerだけ成功、side effectも1回 |
| B03 | 止まったworkerを自動回収できるか | heartbeat停止後にlease失効し、別workerが規定時間内にreclaim |
| B04 | retryと失敗終了を正しく区別できるか | retryable、non-retryable、budget超過、backoffをclock fixtureで検証 |
| B05 | checkpointから副作用を重複せず再開できるか | tool完了直後にkillし、再開後にtoolを二重実行せず後続だけ完了 |
| B06 | pause、resume、cancel、steer、follow-upが一貫するか | 全状態遷移をmodel testし、Backendとchild Work Itemへ伝播 |
| B07 | Backend streamは再起動後も連続するか | event途中でServerを再起動し、`after_sequence`から欠落・重複なしで再購読 |
| B08 | 実Backend cassetteが長時間flowを完走できるか | 最低1つの実Backendでrun、tool、wait、resume、cancel、restart recoveryを完走 |

#### C. Workspace / Data / Recovery — 7問、14点

| ID | テスト質問 | 2点の条件 |
| --- | --- | --- |
| C01 | DB schemaを安全にupgradeできるか | fresh installと全supported旧versionから最新へのmigrationが成功しchecksum一致 |
| C02 | SQLite設定と同時書き込みは安全か | foreign key、WAL、busy timeoutが有効で、100並列更新にlost updateがない |
| C03 | DBとfileの途中失敗を回復できるか | stage、DB pending、rename、commit各地点でkillし、再起動後に完了または全rollback |
| C04 | Restore失敗で現在のWorkspaceを壊さないか | 展開・hash検証・swap各地点のfailure injection後も元Workspaceが完全一致 |
| C05 | Export / Importで参照関係を維持できるか | 別temporary rootへ移し、Session、Artifact、Collection、Memory、Skillのrefとhashが一致 |
| C06 | 検索indexを増分更新・再構築できるか | create/update/deleteが即反映され、index破損後のrebuildで同じrank結果を再現 |
| C07 | crash後にorphanや壊れた参照が残らないか | doctorが全fixtureを検出し、自動修復後に整合性checkが0件 |

#### D. Mulmo的Surface / Artifact / Collection / Plugin — 8問、16点

| ID | テスト質問 | 2点の条件 |
| --- | --- | --- |
| D01 | Presentation Plannerはbuilt-inとGenerated Surfaceを含む表示方法を適切に選べるか | 固定benchmarkでtext、artifact、built-in、generated、noneの期待値を満たし、不要UI率が基準以下 |
| D02 | Generated Surfaceを安全に生成・縮退できるか | HTML / CSS / script / action schema、CSP、size、capability matrix、malformed output、built-in / artifact / text fallbackを全通過 |
| D03 | Generated Surfaceの操作は本当の業務状態を変更できるか | 生成UIの全actionが宣言済みDomain Commandを通り、Human / Agent操作と同じvalidation、結果、監査になる |
| D04 | Generated Surfaceをreload・pin・改訂・再利用できるか | 同じSurface IDとrevisionを再構築し、source editは新revision、別clientでもresource state一致、export/import後もhash一致 |
| D05 | Collection schema、action、triggerを安全に変更・実行できるか | schema migration、Human / Agent / Generated Surface操作、cycle、重複trigger、rollback fixtureが全成功 |
| D06 | 多形式Attachmentを安全に取り込めるか | image、PDF、text、DOCX、XLSX、PPTXの抽出・上限制御・source trace・失敗再試行が成功 |
| D07 | Artifactを改訂・再表示・export・修復できるか | revision lineage、hash、missing source repair、別root importが一致 |
| D08 | Plugin失敗をCoreから隔離できるか | crash、timeout、memory超過、署名不正、version非互換でもHostが継続しrollback可能 |

#### E. Hermes的Context / Memory / Skill / Learning — 10問、20点

| ID | テスト質問 | 2点の条件 |
| --- | --- | --- |
| E01 | 小さく保たれたUser Modelを使えるか | 上限、source ref、更新規則、prompt注入、削除をtestし、長文履歴を直接混ぜない |
| E02 | Profileは完全に分離・移行できるか | 2 profile間でSession、Memory、Skill、Secret、Automationが漏れず、export/importも一致 |
| E03 | 長いSessionをbudget内へ圧縮できるか | 10,000 message fixtureでhard limitを超えず、目的・決定・未完作業を保持 |
| E04 | 必要な過去情報をrank付きで取れるか | 日本語を含むretrieval benchmarkで基準recallを満たし、score理由とsourceを返す |
| E05 | Skillを段階開示し、実利用を記録できるか | list→body→support fileの順序、Backend差、use trace、未使用判定を全fixtureで確認 |
| E06 | Background ReviewはMemory / Skill / Wikiの不正提案を部分適用しないか | scoped reviewがshell等を使えず、malformed、version conflict、途中write failureで全rollbackし、正しいmutationだけ1回適用 |
| E07 | Knowledge Wikiは自己改善loopを一周できるか | active retrieval→利用記録→signal→Evaluation→create/patch/merge/archive→Curator→次回利用→rollbackをsource付きで完走 |
| E08 | 訂正信号とEvaluationは比較可能な仕事へ正しく結びつくか | correction、undo、rerun、Artifact/Surface revision、dismiss、pin、explicit feedbackをTaskFingerprint cohortで評価し、sample不足はinconclusive |
| E09 | CuratorはMemory / Wiki / Skill / Surface patternの重複・衝突・usageを安全に扱えるか | duplicate、overlap、conflict、supersede、pin、stale、archiveを判定し、snapshotから完全rollback |
| E10 | 学習loopは仕事とGenerated Surfaceを本当に改善するか | baseline比で仕事品質とUI利用結果が改善し、安全、訂正率、誤適用、cost、latencyのguardrailを悪化させない |

#### F. Gateway / Automation / Owner Access — 5問、10点

| ID | テスト質問 | 2点の条件 |
| --- | --- | --- |
| F01 | recurring / one-shot / no-agent jobは再起動後も正しく動くか | timezone、DST、missed run、pause/resume、restart fixtureで抜け・重複がない |
| F02 | Automationを複数workerで安全に実行できるか | atomic lease、heartbeat、reclaim、retryを10 worker競合で通す |
| F03 | Gateway sessionとdeliveryは再起動をまたげるか | inbound dedup、session mapping、outbound retry、receiptを再起動後も復元 |
| F04 | owner以外のCore操作を拒否できるか | local/remote token、rotation、CORS、rate、size、SSRF、Secret redaction testを全通過 |
| F05 | 代表Sandbox契約と署名付きGateway flowが動くか | Sandbox policyがadapter境界を通り、署名付きwebhook fixtureがDomain Command、Workspace保存、返信まで完走。実Dockerは正式提供前のrelease certificationとする |

#### G. Quality / Operations / Release — 5問、10点

| ID | テスト質問 | 2点の条件 |
| --- | --- | --- |
| G01 | 1つの依頼を最初から学習まで追跡できるか | requestからcommand、objective、run、tool、change、learningまでcorrelation queryで辿れる |
| G02 | 長期運転時のresource増加を制御できるか | queue、concurrency、token、file、event、backup、indexの上限とretention testが成功 |
| G03 | Secretとprivate dataを保存・表示前に守れるか | log、event、Artifact metadata、Learning source、Gateway errorのredaction/fuzz testが成功 |
| G04 | 加速耐久試験と障害注入に耐えるか | 100 Objective、1,000 job、Gateway、Curatorを動かし、定期kill後もstuck、orphan、duplicate、data lossが0件 |
| G05 | Core verifierが100点と検証対象sourceの健全性を証明するか | 最終自動テスト一式、typecheck、diff check、secret scan、完全一致duplicate scan、source hash確認が成功し100/100。clean成果物はrelease certificationとする |

### 8.5 期待する実行コマンド

最終的に次の入口へ統一する。

```bash
pnpm core:verify
pnpm core:verify -- --category durable-execution
pnpm core:verify -- --category learning
pnpm core:soak
pnpm core:report
```

`pnpm core:verify` は最低でも次を内部実行する。

```text
typecheck
unit tests
contract tests
API integration tests
domain command parity tests
migration and recovery tests
multi-worker race tests
restart and crash tests
security and redaction tests
real adapter evidence validation
score aggregation
```

## 9. 完成時に残してよいもの / 残してはいけないもの

### 残してよいもの

- 未対応の追加BackendやGateway adapter
- 追加Rendererや新しいCollection view
- optionalなsemantic search provider
- 製品UIの見た目改善
- SaaS、共同編集、課金、Marketplace

これらはCoreの拡張であり、Coreの欠陥ではない。

ただし、追加RendererがなくてもGenerated Surface Runtime自体は完成している必要がある。個別の新Rendererは拡張だが、HTML生成、Domain Command接続、sandbox、reload、fallback、学習はCore要件である。

### 残してはいけないもの

- process再起動で消える実行状態
- 二重実行されるjobやtool side effect
- DBとfileの説明不能な不一致
- 入口ごとに異なるvalidation・監査・権限
- sourceのないMemoryやSkill改善
- 利用結果とつながらないKnowledge Wiki自動更新
- rollbackできない自動学習
- reloadで消える、またはversionを追えないGenerated Surface
- Domain Commandを迂回してWorkspaceを直接変更する生成HTML
- 生成HTMLそのものをMemoryやKnowledge Wikiへ貼り付ける学習
- 壊れたCollection migration
- 認証なしのremote API
- Plugin crashによるHost停止
- 100点テストで1点または0点の項目

## 10. 最終判定

この計画をすべて実装した状態では、Samurai Agent Coreは次の意味で完成と言える。

- Mulmo的には、Backendを差し替えながら、Chatから必要なSurface、Artifact、Collectionを安全に出せる。
- Mulmo的には、既存Rendererだけで足りない時に永続・編集・fallback可能なGenerated Surfaceを出し、その操作を同じDomain Commandへ返せる。
- Hermes的には、長い作業を再起動後も継続し、MemoryとSkillを検索・利用・評価・整理できる。
- Samurai Agent独自の形として、Knowledge Wikiも利用結果、Evaluation、Background Review、Curatorへ接続し、Generated Surfaceの判断と改善に再利用できる。
- Samurai Agent独自の形として、Chat、Workspace、UI、Gateway、Automation、Learningが同じDomain Operationと監査線上でつながる。
- 追加作業はCoreの穴埋めではなく、Backend、Plugin、Renderer、Gatewayなどの機能拡張になる。

**最終完了条件は、必須gateをすべて通過し、50問100点を取ること。99点以下は未完成とする。**
