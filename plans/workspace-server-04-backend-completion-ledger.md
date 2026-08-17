# Workspace Server 04：バックエンド完成台帳

開始日: 2026-08-17
作業ブランチ: `codex/backend-completion-04`
基点: `b5b49d0`

## 0. 正本と作業境界

この台帳は、利用者がこの会話で確定した「技術版：4番バックエンド重大問題修正プラン」を実装へ落とすための台帳である。元の26項目・22要件・Phase・完了条件は変えず、今回見つかった9件の実装不良と検証不足だけを修正する。既存の `plans/workspace-server-04-knowledge-learning.md`、`plans/workspace-server-04-oss-reference.md`、`plans/workspace-server-04-self-review.md` は当時の実装記録として変更しない。

優先順位は次のとおり。

1. この会話で利用者と確定した内容
2. 技術版：4番バックエンド重大問題修正プラン
3. 元の26項目プラン
4. `PRINCIPLES.md`、`SAMURAI_AGENT_MANUAL.md`、`ARCHITECTURE.md`、`PUBLIC_NAMING.md`、`WEB_UI_DESIGN.md`
5. 現行コード
6. 参照OSS

運用調整値（再試行、昇格、保持、Curator周期、snapshot数、負荷検証件数）は、版と履歴を持つWorkspace設定の初期値として扱う。内部ID、内部path、report pathは利用者設定にせず、安定した実装定数として一か所で管理する。変更時には移行、互換性、検証を伴わせる。

## 1. 参照OSS調査（Phase 0 完了）

確認日: 2026-08-17

| 修正対象 | 参照箇所 | Samuraiで採用する作法 | 採用しないOSS設計 |
| --- | --- | --- | --- |
| Caller／Policy | [Buzz Architecture `f956e6f`](https://github.com/block/buzz/blob/f956e6fe06a76e50cbd8fba1a162482e752e7f1a/ARCHITECTURE.md)、[Testing](https://github.com/block/buzz/blob/f956e6fe06a76e50cbd8fba1a162482e752e7f1a/TESTING.md) | 認証済みContextだけをtransactionへ渡し、認可・期待Version・更新を同じ境界で確認する | Buzz固有のRoom、Nostr、Relay設計 |
| file transaction | [OpenClaw Agent Workspace `327974f`](https://github.com/openclaw/openclaw/blob/327974fa2d0e2801917562de1500b3664e99cbdb/docs/concepts/agent.md) | 人が読めるfileとDB状態を照合し、hash不一致や欠損は安全停止する | Agent単位Workspace、USER.md／MEMORY.md分類 |
| Skill package | [Hermes Curator `bab7be3`](https://github.com/NousResearch/hermes-agent/blob/bab7be3ca7ee2ca58d38f29c189ddb4dd38035ff/website/docs/user-guide/features/curator.md)、[AGENTS](https://github.com/NousResearch/hermes-agent/blob/bab7be3ca7ee2ca58d38f29c189ddb4dd38035ff/AGENTS.md) | package全体をsnapshotとして扱い、pathとhashをまとめて検証する | Agent中心のMemory／Skill所有構造 |
| Curator | [Hermes Curator `bab7be3`](https://github.com/NousResearch/hermes-agent/blob/bab7be3ca7ee2ca58d38f29c189ddb4dd38035ff/website/docs/user-guide/features/curator.md) | snapshot、dry-run、rollback、stale時の安全停止を分ける | Sessionを学習の親にする構造 |
| Migration | [Buzz Testing `f956e6f`](https://github.com/block/buzz/blob/f956e6fe06a76e50cbd8fba1a162482e752e7f1a/TESTING.md)、[OpenClaw Agent Workspace `327974f`](https://github.com/openclaw/openclaw/blob/327974fa2d0e2801917562de1500b3664e99cbdb/docs/concepts/agent.md) | 状態遷移、transaction、receipt、再開／rollbackを明示する | 外部Agent runtime一体型の移行 |
| Bundle | [MulmoClaude Developer Guide `f02d8a4`](https://github.com/receptron/mulmoclaude/blob/f02d8a4c7a93924e5704e1894ed58dc4456696da/docs/developer.md)、[OpenClaw Agent Workspace `327974f`](https://github.com/openclaw/openclaw/blob/327974fa2d0e2801917562de1500b3664e99cbdb/docs/concepts/agent.md) | path・定数を一元化し、stagingと最終成果物を分けて照合する | Bundleを別正本にする構造 |
| verifier | [Buzz Testing `f956e6f`](https://github.com/block/buzz/blob/f956e6fe06a76e50cbd8fba1a162482e752e7f1a/TESTING.md)、[MulmoClaude Developer Guide `f02d8a4`](https://github.com/receptron/mulmoclaude/blob/f02d8a4c7a93924e5704e1894ed58dc4456696da/docs/developer.md) | 型・focused・実DB・事故注入・負荷を一つの入口で記録する | UI、個人Wiki、Plugin製品設計 |

参照OSSのコードは直接コピーしていないため、LICENSE／NOTICEの追加は不要である。

### 1.1 今回の修正対応表

| # | 根本修正 | 主な実装先 | 完了証拠 |
| ---: | --- | --- | --- |
| 1 | file batchにWorkspace／Room scopeを持たせる | `workspace-completion-files.ts`、`schema.ts`、`workspace-completion-bundle-v4.ts` | scope CHECK・RLS・旧batchのWorkspace化／複数Room安全停止・別Room読取／非読取probe |
| 2 | Serverが検証したcallerだけをPolicyへ渡す | `types.ts`、`auth.ts`、`postgres.ts`、`http-server.ts`、`workspace-completion-service.ts` | 偽署名／偽connection／maintenance拒否probe |
| 3 | Attestation Portと追記専用根拠を追加する | `workspace-completion-types.ts`、`workspace-completion-service.ts`、`schema.ts` | forged machine verification、hash／Version不一致probe |
| 4 | Skill package全体をCopy／Move／Restoreする | `workspace-completion-files.ts`、`workspace-completion-service.ts`、`workspace-completion-bundle-v4.ts` | ネスト・binary・失敗復旧probe |
| 5 | Review／Curatorのsnapshotとstale確認をtransaction内へ置く | `workspace-completion-service.ts`、`workspace-completion-curator.ts` | 101件、保存直前更新、fixed化、rollback保護probe |
| 6 | 専用Migration Runでread-only化して復旧する | `workspace-completion-migration.ts`、`schema.ts` | 開始transaction内のAudit、通常書込み拒否、phase停止／resume／rollback probe |
| 7 | maintenance membershipをBundle投影から除外する | `workspace-completion-bundle-v4.ts`、`workspace-bundle-v3.ts` | Restore後のmembership不在probe |
| 8 | v3埋込みwriterとv4最終台帳を分ける | `workspace-bundle-v3.ts`、`workspace-completion-bundle-v4.ts`、`schema.ts` | 最終path／hash、retry、staging台帳不在・hashで証明できる旧台帳修復probe |
| 9 | 実DB・事故・負荷を一括verifierで失敗も含め記録する | `scripts/verify-server-04-completion.mjs`、`verify-server-04-completion-rls.ts`、`verify-server-04-completion-load.ts` | `pnpm server:04:complete:verify` のreport |

## 2. 完成要件の台帳

| # | 完成要件 | 現状との差分 | 実装先 |
| ---: | --- | --- | --- |
| 1 | AgentはWorkspace管理、Sessionは任意参照 | 既存は成立 | 既存境界を維持する型・schema・API |
| 2 | PROFILE/SOULは人間更新専用 | Server側file serviceなし | profile file service |
| 3 | Activityは確定作業証拠 | 基盤あり、追記型を明示化 | activity/episode service |
| 4 | Episodeを正式PostgreSQLモデル化 | `groupKey`だけ | episode table/service |
| 5 | Knowledgeは4種類 | `knowledge`単種 | resource type/validator |
| 6 | Skillはpackage全体 | 本文DB保存 | learning file service |
| 7 | Policyは独立しServer強制 | `workspace_rule`混在 | policy service/guard |
| 8 | Memory廃止、Wikiは管理層 | Memoryの新規経路が残る | migration/API明示エラー |
| 9 | 本文=file、認可等=PostgreSQL | 本文がDB正本 | file pointer/version schema |
| 10 | 通常書込はServer経由 | file serviceは汎用 | command/Policy guard |
| 11 | 学習対象を決定的に限定 | 基盤あり | review eligibility |
| 12 | 構造化Reviewと種類別必須項目 | 旧mutationのみ | review schema/validator |
| 13 | 422修正再試行と原子適用 | 422はterminal、単発適用 | retry/batch transaction |
| 14 | 種類別昇格 | 旧stateのみ | promotion/evaluation service |
| 15 | 次版・矛盾・fixed | 現行版をAI更新可能 | version pointer/link |
| 16 | 検索/Contextを分離 | knowledge検索だけ | context/query service |
| 17 | Use/Evaluation追記履歴 | Use基盤のみ | evaluation service |
| 18 | Curator日次/週次能力 | 旧Runtimeは安全停止 | PostgreSQL scheduler |
| 19 | review/evaluation/curatorのlease | reviewだけ | job state machine |
| 20 | archive中心とredaction | retention未実装 | retention service |
| 21 | file移行、Bundle v4、v3読込 | Bundle v3のみ | migration/bundle v4 |
| 22 | 5番向け固定API/Event | 学習APIのみ | HTTP contract/event tests |

## 3. 対象ファイル

既存facadeを残し、巨大な `workspace-learning.ts` へ新責務を増やし続けない。主な対象は次のとおり。

- `packages/workspace-server/src/types.ts`
- `packages/workspace-server/src/schema.ts`
- `packages/workspace-server/src/workspace-completion-types.ts`
- `packages/workspace-server/src/workspace-completion-policy.ts`
- `packages/workspace-server/src/workspace-completion-service.ts`
- `packages/workspace-server/src/workspace-completion-files.ts`
- `packages/workspace-server/src/workspace-completion-jobs.ts`
- `packages/workspace-server/src/workspace-completion-curator.ts`
- `packages/workspace-server/src/workspace-completion-migration.ts`
- `packages/workspace-server/src/workspace-completion-bundle-v4.ts`
- `packages/workspace-server/src/workspace-bundle-v3.ts` と新規Bundle v4 service
- `packages/workspace-server/src/workspace-server-commands.ts`
- `apps/server/src/workspace-server/core.ts` と `http-server.ts`
- `scripts/verify-server-04-completion.mjs`、PostgreSQL probe、contract/failure-injection tests
- 正本5文書とこの台帳

## 4. 今回の対象外

- Codex、Claude Codeなどの実Adapter
- OAuth、MCP、Pluginの具体的接続
- Native AppのPolicy許可通知UI、Knowledge/Skill管理UIの完成
- 外部資料を取得するAdapter
- Chat/Session全文保存、Agent/Session所有関係変更
- Graph DB、Vector DB、CRDT、新しいMessage Bus、汎用Workflow、任意実行Policy DSL
- semantic Curatorの初期有効化、新しい自律Agent、UIデザイン変更、外部Credential管理UX

## 5. 既存検証状態

既存 `pnpm server:04:verify` は、architecture boundary、型検査、Native App build、focused test 7 files/29 testsまでは通過記録がある。一方、Docker不在時はPostgreSQL probeが `spawnSync docker ENOENT` で未実行となる。Migration、RLS、lease、Bundle Restore、file復旧、Hosted/Self-host、Realtimeを実DB検証済みとは扱わない。

Self-hostの物理本文編集は、`completion-physical-edit-prepare <resourceId>`で現行Versionを退避した後にだけ、`completion-physical-edit-import <resourceId> <expectedVersion> <reason>`で取り込む。取り込みは`physical_file_import`のEvidenceを残し、正確な編集者を推測しない。Hosted、Policy、退避前に上書きされた本文は拒否する。

## 6. フェーズと完了条件

| Phase | 実装 | 完了の目印 |
| --- | --- | --- |
| 0 | 差分、OSS、台帳、対象範囲 | この台帳、対象外、既存検証状態 |
| 1 | 型、追加schema、RLS | enum/DB CHECK/RLS一致、Memory/workspace_rule新規作成不可 |
| 2 | file正本、batch、PROFILE/SOUL | DB本文返却なし、再起動復旧、path/symlink拒否 |
| 3 | Activity/Episode | Session不要、確実な関連付け、Episode重複除外 |
| 4 | Policy | HTTP/Job/file/Curatorが同じguard、AIは要求のみ |
| 5 | Review/分類/repair | 全件原子、422 repair、Attestation Port |
| 6 | Version/昇格/競合 | AIは確定版非上書き、fixed強制、Room外自動昇格なし |
| 7 | 検索/Context/Use | Room限定、Skill段階読込、fileからindex再構築 |
| 8 | Evaluation | unknown保持、Episode重複除外、昇格へ接続 |
| 9 | Curator | 日次/週次能力、semantic初期OFF、snapshot/rollback |
| 10 | 移行/Bundle v4/保持 | hash/件数、v3 import、redaction、rollback |
| 11 | 5番向け契約 | operation ID/error/event/pagination契約 |
| 12 | 正本文書 | 5文書の用語と現状が一致 |
| 13 | 総合検証/自己レビュー | verifier、実DB、復旧、未検証の明記 |

## 7. 完成verifierの契約

最終入口は `pnpm server:04:complete:verify` とする。`reports/server04-completion/report.json`、`junit.xml`、`self-review.md` を出力し、最終表示はPASS/FAIL、失敗要件、未実行項目、report pathだけとする。実PostgreSQLを起動・接続できない場合はFAILとし、完成扱いにしない。
