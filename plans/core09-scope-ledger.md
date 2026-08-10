# Core09 Scope Ledger

状態: **実装・集中検証済み**
開始日: 2026-08-10
開始HEAD: `768c665`

## 対象

- `packages/core-schemas`: Connection、Connector evidence、Automation authority／provenance／blocked状態の契約。
- `packages/workspace-store`: Migration 015／016、Connection Repository、Automation row・Repository、Backup／Restore互換。
- `packages/room-permissions`: 既存のRoom／Agent権限をConnection／Automation再評価に利用する最小のPort。
- `packages/domain-operations`: Connection管理、Automation save／status／rebind／reauthorize／manager stop／resume／runのSession非依存契約。
- `packages/runtime`: External App Context Resolver、Query／Domain Operation／Activity Ingest共通入口、Automation再認可、管理停止、安全停止、Crash recovery。
- `packages/gateway`: Pairing／legacy Chat互換へ入らないFormal ingressの責務分離だけ。
- `scripts/verify-core09.mjs`、Focused test、`plans/`、正本の現状実装記録。

## 対象外

- `apps/web`、Native App画面、Chat、Session一覧、App Agent、表示状態。
- 本番MCP Server、Plugin、OAuth、HTTP公開Route、固定Token、具体的外部チャネル。
- Memory／Knowledge／Skillの自動生成・自動昇格、Activity後のJob自動enqueue。
- 任意Workspace Job API、万能Event bus、Workflow DSL、Compute抽象化。
- Room realtime、Relay、Nostr、署名Event。

## 境界

- ConnectionはRoom membershipを付与しない。許可はConnection上限、委任元の現在権限、Resource／Operation固有権限の積集合で決める。
- PairingはTransport admissionだけであり、ConnectionでもRoom権限でもない。
- Transport AdapterはStore／Repositoryを直接呼ばず、Resolver後のQuery／Domain Operation／Activity Ingestへ渡す。
- Queryは完全read-only。Domain Operationは既存registry、Activity Ingestは既存Activity portを必ず通る。
- SessionRefは任意の出所だけであり、Room／Principal／Connectionの根拠にはならない。
- Automationの旧JobはRoom・Authorityを推測せず`rebind_required`にする。明示Rebind後も自動enableしない。
- Automationの`blocked`は明示reauthorize後もdisabled、`manager_stopped`は明示resume後もdisabledにする。Job lockはowner token一致時だけ終端できる。
- Credential、Cookie、OAuth token、App Session全文をDB、log、Backupへ入れない。

## 実装ファイルの固定範囲

- Connection契約・永続化: `packages/core-schemas/src/index.ts`、`packages/workspace-store/src/migrations/015-core09-external-ingress-automation-boundary.ts`、`packages/workspace-store/src/migrations/016-core09-automation-manager-locks.ts`、`packages/workspace-store/src/repositories/external-app-connection-repository.ts`。
- Connection管理と共通入口: `packages/domain-operations/src/operations/external_app/connection/`、`packages/runtime/src/commands/services/external-app-connection-domain-service.ts`、`packages/runtime/src/external-app/`。
- Query: `packages/domain-operations/src/operations/activity/history/list.operation.ts` と既存Activity Query service。
- Automation: `packages/runtime/src/commands/services/core09-automation-domain-service.ts`、Automation operation契約、Automation row／repository。
- Gateway境界: `packages/gateway/src/formal-workspace-ingress.ts`。既存`gateway.inbound.route`、`apps/server`、`apps/web`は変更しない。
- 証拠・検証: `packages/*/src/core09-*.test.ts`、`scripts/verify-core09.mjs`、`plans/core09-*.md`。

## 完了条件

- [x] Connection・Resolver・3入口が同じTrusted Contextを使う。
- [x] Formal ingressとAutomationのsave／status／runがSessionを作らない。
- [x] Connection失効とRoom権限失効が次リクエスト／実行直前に反映される。
- [x] Authorization blockはRetry budgetを消費しない。
- [x] Room managerのstop／resumeと、blocked Jobの明示reauthorizeがAuthorityを上書きせずdisabledを保つ。
- [x] token-bound lock、started Runの一意制約、期限切れRunの通常失敗回復を持つ。
- [x] Migration／Backup／Restoreが旧Automationと新metadataを安全に扱う。
- [x] Reference Adapter E2E、Focused verifier、`git diff --check`が成功する。

`pnpm core:09:verify`はCore06〜08の必要回帰、Core09のMigration／Backup、共通入口、Gateway recovery、型検査をまとめて実行する。実Credential、最終MCP／Plugin／OAuth、UI、製品全体の完成はこの完了条件に含めない。
