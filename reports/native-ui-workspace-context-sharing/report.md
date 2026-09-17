# Native UI Workspace Context Sharing 実装・検証レポート

実施日: 2026-09-18
対象計画: [`plans/native-ui-workspace-context-sharing-plan.md`](../../plans/native-ui-workspace-context-sharing-plan.md)
作業ブランチ: `codex/design-workspace-room-agent-sharing`
基準コミット: `45b9eea`
実装コミット: `7faacdb`（Native UI共有とContext連携を実装）
最終コミット: `6416c18`（CI結果を反映）

## 実装結果

- Native AppにWorkspace/Roomナビゲーション、コンテキスト検索、通知、Account設定、Room設定、Agent資源、Room Knowledge/Agent resourceの共有・取り込み導線を接続した。
- Context Query、Notification、ShareをWorkspace Serverの共通Core、Domain API、HTTP、Browser bridge、Electron preload/mainへ接続した。検索・通知・共有の業務認可はUIやHTTP handlerだけに置いていない。
- Workspace Knowledge/Memoryを新規取得・学習・Runtime Context・Completionから除外し、Room Knowledge、Workspace Skill/Policy、Agent資源は保全した。旧入力互換経路はRoom IDとRoom Knowledgeに限定した。
- Share importを受付とWorkerに分離し、recipient再認可、capabilityのTTL/上限、staging/rename/commit、lease、3回の自動再試行、明示再送を実装した。
- Workspace Completion本文の削除台帳、lease/retry、hash/path/symlink検査、maintenance経由の物理cleanup、bundle v3/v4の共有・Agent帰属・本文台帳検証を追加した。
- Bundle v3の`reserved_resource_ids`は、配列内のentry/resource重複、import-resource行との余剰・欠落・不一致を拒否する完全一致検証にした。V4はこのV3検証とAgent/Room scope検証を通過したものだけを扱う。
- Native Account設定は端末Account単位で保存し、未保存変更の確認、共有先のRoom束縛、Browser/`samurai://share`のURL検査を実装した。
- 実検証で判明した3件を根本修正した。Context/Notification SQLの実DB列名誤りと通知投影RLS、BrowserのRoom公開前Agent取得競合、Electron preload済み入力のmain側二重sanitizeを修正した。

## 検証済み

### 静的・focused・回帰

- `pnpm test -- --reporter=dot`: **221 test files passed, 1 skipped; 1,698 tests passed, 6 skipped, 0 failed**。
- `pnpm typecheck`: pass（全24 workspace projects）。
- `pnpm run verify:source-quality`: pass（format 1,014、lint 895、issues 0）。
- `pnpm run verify:architecture`: pass（`findings: []`）。
- `pnpm run core:domain-contracts:verify`: pass（13 tests、170 commands）。
- `pnpm run desktop:verify`: pass。
- `pnpm run i18n:check`: pass。
- `pnpm run desktop:artifact:verify`: pass。
- `pnpm run verify:postgres-migration:static`: pass（legacy reference/API route 0）。
- `pnpm run verify:postgres-runtime-scope`: pass（standard storage `postgresql`, `issues=[]`）。
- Browser bridge focused: 46 tests pass。Desktop context/notification normalized IPC regression: 34 tests pass。
- Web build、Desktop main/preload bundle build、`git diff --check`: pass。

### 実PostgreSQL・実Storage・実Server

Docker Desktop上の専用Compose project `samurai-context-verify`、専用PostgreSQL（runtime roleのRLS）、Hosted DB `samurai_verify_hosted`、Self-host DB `samurai_verify_self_host`、専用一時Storageを使用した。既存DB・既存Storage・リポジトリのデータは変更していない。

- migration、RLS allow/deny、制約、再実行、Workspace Memory廃止、Room Knowledge/Skill/Policy/Agent資源の保全、Completion本文のhash/path/symlink検査、cleanupのlease/retry/復旧を実DBで確認した。
- Shareの下書き・発行・限定公開・claim・署名付きdelegation・recipient再認可・別Server取得・staging/rename/commit・停止・再送・revoke後の独立コピー保持を実Storageで確認した。
- Bundle v4 export/restoreを実行し、復元時active shareがrevokeされ、committed importが独立コピーになり、通知/outbox・未完了処理が復元されないことを確認した。
- Context Query、HTTP completion、Workspace search、Notification outbox/projector/list/summary/mark-readを実経路で確認した。結果例は`searchMatches=1`、通知未読数が1件減少。
- 旧HTTP `/api/workspaces/:workspaceId/memory` と `/knowledge-memory` は実Serverで到達し、Room束縛のない入力は400、Workspace Memory対象は409 `workspace_memory_removed`、Room Knowledgeは許可された。

### Hosted / Self-host

- HostedプロセスはHosted DBと専用Storageで起動し、healthが`storage=postgresql`、`db.ok=true`、`mode=hosted`、`rls=required`を返した。
- Self-hostプロセスはSelf-host DBと専用Storageで起動し、同じhealth条件に加えworker supervisorが`running`、連続失敗0、workspace count 1を返した。
- Shareのsource/targetを別Server相当（Hosted→Self-host）として実行し、単一Server内の二Workspaceだけで代替していない。

### 実Agent（Samurai Native + Gemini）

Gemini API keyは`.env`からプロセスへ渡したが、値はログ・レポートへ出していない。専用Room/Agentで実Chatを1往復し、HTTP 200、`sessionId`、Agent本文、runtime runの`completed`、`run_started`/`text_delta`/`run_completed`、usageを確認した。Agent資源の出所はRoom境界内で、実行結果は`OK`だった。

### 実Browser（Chrome）

- 実Chromeの接続フォームへ専用Server・Workspace・Accountを入力し、IndexedDBを初期化した状態から接続した。
- Workspace/Room表示、Agent一覧、検索入力・結果表示、通知一覧・未読概要、API→実DB投影の一致を確認した。
- CORSを明示したServerで再実行し、OPTIONSだけで終わる初期構成を修正後、各APIが200で応答することをNetwork記録で確認した。
- 接続後画面の証拠画像は一時検証領域の`browser-connected.png`に保存した。秘密情報は含めていない。

### 実macOS Native（Electron）

- 実Electron binaryを専用profile・専用Workspace/Room/Agentで起動した。既存profileの暗号化identityは隔離profileへコピーし、秘密鍵は出力・保存していない。
- 実画面でWorkspace/Room表示、Agentパネル（Agent名、`workspace_agent`、`Samurai Native`、利用可能、DM）、検索入力→検索結果、通知入口→Workspace通知・Account横断通知をクリック操作で確認した。
- preloadで正規化済みの検索・通知入力をmain側が再度raw parserへ渡していたため実画面で失敗していた問題を修正し、再bundle後に検索結果と通知画面の表示を確認した。
- 通知画面の証拠画像は一時検証領域の`electron-notifications.png`に保存した。

### CI

- sandbox内の最初の`pnpm run verify:ci-full`は、コード失敗ではなくsandboxの`listen EPERM 127.0.0.1`、tsx IPC socket、Docker接続制限で実行環境エラーになった。
- 同じCI入口を権限付き実行環境で再実行し、**`verifier=ci-full`, `status=passed`, `failed_checks=[]`, `unverified_checks=[]`**を確認した。結果は一時検証領域の`ci-final-escalated/result.json`に保存した。
- このCIにはarchitecture、migration readiness、全typecheck、Web build、全test、Hosted/Self-host migration、RLS、HTTP recovery、worker bundle、runtime recovery RLSが含まれる。
- Push後のGitHub Actions初回実行（CI `35250814265`）では、macOS/Ubuntuの契約ジョブが`apps/server`から直接利用する`pg`の宣言不足で停止した。`apps/server/package.json`とlockfileへ`pg`/`@types/pg`を直接追加し、ローカルserver typecheckを再通過させた。
- 修正後のCI `35251198091`は、macOS・Ubuntu・Windowsの契約、Linux全体、PostgreSQL deep/load、release readinessを含む全7ジョブがpassした。Security `35251201155`も全ゲートpassした。
- 最終Push後のCI `35251796875`も全7ジョブ（Linux全体、PostgreSQL deep/load、release readiness、macOS・Ubuntu・Windows契約）がpassし、Security `35251800107`もpassした。結果URL: [CI](https://github.com/Takuma-kaho/Samurai-Agent/actions/runs/35251796875)、[Security](https://github.com/Takuma-kaho/Samurai-Agent/actions/runs/35251800107)。

## 旧API互換経路の設計適合性

旧名称・互換route（`/knowledge-memory`、`/memory`、`PostgresKnowledgeMemory`、clientの`workspaceMemory`等）は互換性のため残っている。ただし、実HTTP・Domain API・Core・Runtime・Bundle・migrationの全入口でWorkspace Knowledge/Memoryは拒否し、旧入力はRoom IDとRoom Knowledgeへ束縛している。Workspace Memoryが検索・実行・学習・復元へ再利用される経路は、focused testと実DB/実HTTPで確認されなかった。名称整理は将来のP2であり、今回の要件境界を迂回する修正ではない。

## 残作業と判定

検証上の必須未確認は残っていない。最終コミット`6416c18`をブランチ`codex/design-workspace-room-agent-sharing`へPush済みで、ローカルHEADとoriginのHEADが一致している。マージ、branch削除、既存DB/Storageの削除は行っていない。専用Docker検証環境は検証終了後に停止した。
