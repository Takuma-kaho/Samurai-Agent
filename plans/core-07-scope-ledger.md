# Core07 Scope Ledger

状態: **完了**  
開始時点: 2026-08-09

## 対象

- `packages/core-schemas/src/index.ts`：Activity、ResourceUsage、WorkspaceJob、JobAttempt、Port契約、状態遷移。
- `packages/workspace-store/src/migrations/012-core07-activity-history.ts`：Activityと利用履歴。
- `packages/workspace-store/src/migrations/013-core07-workspace-jobs.ts`：Jobとattempt履歴。
- `packages/workspace-store/src/rows/`、`repositories/`、`workspace-store.ts`、`packages/runtime/src/activity/activity-history-query-service.ts`：永続化、Room別Query、Backup対象のFacade接続。
- `packages/runtime/src/activity/`、`packages/runtime/src/agent-runtime.ts`：Trusted Context、Room認可、Host実行とのActivity lifecycle、Fake Processor Worker。
- `scripts/verify-core07.mjs`、`package.json`：Core07専用Verifier。
- `plans/`、`SAMURAI_AGENT_MANUAL.md`、`ARCHITECTURE.md`、`plans/core-progress-ledger.md`：範囲と進捗。

## 対象外

- `apps/`のUI・HTTP API・MCP server・Plugin adapter。
- Gatewayの認証、pairing、transport、外部Session保存。
- Background Review、Evaluation、Curator、LearningEvidenceAssemblerの再設計または自動接続。
- Memory、Knowledge、Skill、Artifact、Collectionの自動変更。
- Objective、WorkItem、既存Automation Jobの改名・統合。
- Relay、Event Bus、購読、Vector DB、Workflow DSL、Model routing。

## 固定する境界

- `ActivityInboxItem`、`BackendEventRecord`、`Objective / WorkItem`は新しい正本に流用しない。
- SessionRefは任意の出所参照であり、Room権限やActivityの親にしない。
- Resource catalogを別の正本として増やさず、既存ResourceのRefと`ResourceUsageRecord`のversion/hash snapshotをProcessor入力に使う。
- ProcessorはWorkspace Storeの書込み権限を持たず、Domain Operationを呼ばない。
- Activity IngestはTrusted Workspace Contextだけを受け、公開入力のRoom・Principal・sourceを信用しない。

## 参照OSSの確認結果

| 参照先 | 採用する作り方 | 採用しない設計 |
| --- | --- | --- |
| Buzz | EventとDB責務の分離、fixtureを使う境界テスト | RelayをWorkspace正本にすること |
| Hermes Agent | Memory処理と実行経路を分けて検証すること | Session中心の学習設計 |
| MulmoClaude | Adapter/bridgeごとの入力境界とE2E分離 | Chat・Plugin構造の移植 |
| OpenClaw | lease、retry、cancelを別テストにすること | 汎用タスク基盤やPlugin実行の持込み |

確認元: 各公式Repositoryの公開tree、実装、対応test（2026-08-09確認）。

## 完了証拠

- `pnpm core:07:verify`：Architecture boundary、Core05〜07 focused tests、3 package typecheck、`git diff --check`。
- Core07 focused tests：Sessionなし/Session付きActivity、Room越境拒否、変更参照、retry・heartbeat・cancel・lease recovery、Backup/Restore、SQLite不正上書き拒否。
- 自動学習・Memory/Knowledge/Skill変更・本番Processor登録・外部transportは、対象外のまま追加していない。
