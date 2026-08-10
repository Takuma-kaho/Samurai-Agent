# Core09 Session依存分類

状態: **実装・集中検証済み**

| 分類 | 現在の代表箇所 | Core09での扱い |
| --- | --- | --- |
| A: GatewayがChat用Sessionを作る | `GatewayDomainService`、`AgentRuntime.ensureSessionForContext`、`gateway.inbound.route` | 既存Chat互換として残す。Formal External App ingressからは呼ばない。 |
| B: Automation mutation用のSession | 旧`automation.job.save`、`automation.job.set_status`、旧`AutomationDomainService` | 削除済み。Trusted Domain ContextだけでOperation・Activityを記録する。 |
| C: Automation実行用のSession／Envelope | 削除済み`execute-automation-job.ts`、旧`automation.memory_review.run`実行経路 | 削除済み。SessionなしExecutorがあるkindだけ実行し、ないkindは理由付き安全停止にする。 |
| D: `delivery_target.room_id`からRoomを得る | 削除済み`execute-automation-job.ts`のresource translation | 削除済み。Jobの永続`room_id`とTrusted Contextを使う。delivery targetは配信先であり権限根拠にしない。 |
| E: `system:unbound-gateway` fallback | `AgentRuntime.resolveTrustedParticipant`、`gateway.inbound.route` | Gateway admission専用の旧Chat互換に閉じる。Formal ingress／AutomationのPrincipalとして使わない。 |
| F: public transportからTrusted Context相当を受ける | `apps/server/src/domain-ingress.ts` の既存Runtime API互換入口 | Formal External App ingressでは拒否する。Room・Principal・Connector・App・SourceはResolverだけが設定する。 |
| G: optional SessionRef | `TrustedWorkspaceContext`、Activity、Operation、Run | 任意provenanceとして維持する。形式とApp一致だけを検証し、存在確認・権限判定・自動Resumeはしない。 |
| H: Native App Chat／Session | `apps/server/src/api-server.ts` のChat API、Session一覧・再開 | Core09対象外。既存の互換経路として変更しない。 |

確認結果:

- GatewayのPairing、routing、deduplication、rate limit、delivery、lock、retry、restart recovery、sandbox、outbound MCPは保持対象である。
- Core09の正式入口はA〜Fを通らず、Query／Domain Operation／Activity Ingestだけへ接続する。
- 既存Session列は互換読取用に残し、新規Formal ingressとCore09 Automation経路は書き込まない。

## Automation kindの最終分類

| kind | Core09の扱い | 根拠となる実行境界 |
| --- | --- | --- |
| `wiki_reindex` | Sessionなしで実行 | `Core09AutomationDomainService.executeSessionlessKind`から既存`reindexWiki`だけを呼ぶ。 |
| `memory_review` | 安全停止 | 既存ReviewはSession依存の候補・会話文脈を必要とする。自動学習を再設計しない。 |
| `learning_evaluation` | 安全停止 | Sessionなしの確定した評価入力境界がない。 |
| `skill_curator` | 安全停止 | Sessionなしの確定したCurator入力境界がない。 |
| `daily_digest` | 安全停止 | Chat／Backend turnを作らず、外部作業APIにも変換しない。 |
| `custom_instruction` | 安全停止 | 任意の指示を万能Workflowへ昇格させない。 |
| `resource_translation` | 安全停止 | 旧Session／Envelope実行を復活させず、翻訳方式は後続決定に残す。 |

安全停止では、Backend、Resource、Workspace Job、Sessionを作らない。`automation_runs`へ`blocked`を残し、Jobを`authorization_state=blocked`かつ`disabled`にし、Retry budgetを消費しない。
