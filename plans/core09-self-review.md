# Core09 セルフレビュー

実施日: 2026-08-10

対象はCore09のみ。UI、Native App Chat、最終MCP／Plugin／OAuth／HTTP、Activity後の自動学習は判定対象外として残す。

## 1. 正本と依存方向

| 確認 | 対象ファイル | 確認結果・証拠 |
| --- | --- | --- |
| Workspaceが正本のまま | `workspace-store` Migration 015／016、Connection repository | Connection、scope、Automation provenance、管理停止、lock tokenはWorkspace SQLiteへ保存し、credential型は置かなかった。Migration／Backup testで保存と復元を確認。 |
| Roomが認可境界 | `external-app-context-resolver.ts`、`room-authorization-service.ts` | Connector evidence→Connection scope→委任元の現在Room権限の順で確認する。scope内でもRoom memberを自動作成しない否定テストを追加。 |
| Sessionが親へ戻らない | `external-app/`、`core09-automation-domain-service.ts` | Formal ingress、save／status／runにはSession作成関数がない。外部入力はsession／turn／message IDだけを受け、app IDは認証済みConnectionからServerが設定する。 |
| Gateway／AdapterがStoreを迂回しない | `formal-workspace-ingress.ts`、`external-app-ingress.ts` | GatewayはPortへ委譲し、AdapterはResolver→Query／Domain Operation／Activity Ingestだけを呼ぶ。`verify-core09.mjs`でStore参照を否定。 |

## 2. 認証・認可

| 確認 | 対象ファイル | 確認結果・証拠 |
| --- | --- | --- |
| PairingとConnectionの分離 | `formal-workspace-ingress.ts`、`gateway-domain-service.ts` | Formal ingressの入力はConnector evidenceとuntrusted targetだけ。Pairing／Chat dispatchを受け取らず、既存Gateway recoveryを回帰実行。 |
| Connectionが権限を追加しない | `external-app-connection-domain-service.ts` | 作成／scope変更時に管理者と委任元の双方の現在Room readを確認する。`core09-external-app-ingress.test.ts`で不在Humanのmember作成なしを確認。 |
| 改竄を拒否 | `external-app-context-resolver.ts`、`external-app-ingress.ts`、`agent-runtime.ts` | Connector／App不一致、scope外Room、外部SessionRefのapp ID注入、ActivityのPrincipal／usage scope／Job参照注入を拒否する。Connection metadataもlabel／environmentだけのstrict schemaにした。 |
| 失効が即時反映される | 同Resolver、`room-authorization-service.ts`、`core09-automation-domain-service.ts` | Connection revoke後のQuery拒否、Human／AgentのRoom権限削除、Agent無効化後のQuery拒否、Lock取得後のRoom失効によるAutomation blockをテストした。 |

## 3. 失敗・復旧

| 確認 | 対象ファイル | 確認結果・証拠 |
| --- | --- | --- |
| 権限失効とRetryを分離 | `core09-automation-domain-service.ts` | block時は`automation_runs.status=blocked`、Jobは`disabled`、`failure_count`と`retry_after_at`を変えない。Lock race testで確認。 |
| 管理停止と実行競合 | `core09-automation-domain-service.ts`、`automation-repository.ts` | Room managerのstopは`manager_stopped`とdisabledだけを保存し、進行中wiki reindexを強制中断しない。Executor直前の再読込で停止を検出し、Job／Runの終端は同一transactionで行う。 |
| LockとCrash recovery | Migration 016、`automation-repository.ts` | 15分lockにowner tokenを追加した。token一致時だけ終端でき、partial unique indexでJobごとのstarted Runを1件にする。期限切れstarted Runは`automation_execution_interrupted`として通常失敗へ終端する。 |
| 旧Jobの安全停止 | Migration 015、Automation repository、rebind operation | 旧JobのRoom／Authorityは推測せず`rebind_required`。scheduler対象外で、rebind後もdisabledのままをテストした。 |
| Backup／Restore | `core09-external-ingress-automation-migration.test.ts` | schema 014のv1 BundleをRestore stageで015へ移行し、新Backupは別Workspaceへimport／restoreしてConnection metadataとRun provenanceを確認した。 |
| Gateway recovery | 既存`verify-gateway-recovery.mjs` | pairing期限切れとconcurrency lockの復旧を一時Workspaceで成功確認。外部サービスは使っていない。 |

## 4. 実装の深さ

| 確認 | 対象ファイル | 確認結果・証拠 |
| --- | --- | --- |
| 同じResolverを3入口で使用 | `external-app-ingress.ts`、`reference-adapter.ts` | Query、Domain Operation、Activity Ingestが同じResolverを呼ぶ。Reference Adapter E2EでActivity→Artifact変更→revoke拒否を通した。 |
| Queryの完全read-only | `agent-runtime.ts`、Activity history query | External sourceではAccess auditも抑止する。Query前後のSession、Operation、Activity、Job、Auditが同一であることをテストした。 |
| Activityが学習を起動しない | `activity-ingest-service.ts`、`external-app-ingress.ts` | Activity後にJob、Memory、Knowledge、Skillを生成しない。外部Resourceは既知のRoom共有可能種別だけを同RoomのServer-owned usage scopeで保存し、Operation／Correction参照も同Roomを確認する。 |
| Automationの全kind分類 | `core09-automation-sessionless.test.ts`、Session依存分類 | `wiki_reindex`のみSessionなし実行、残り6種は理由付きblock。全7種を一括テストした。 |

## 5. 過剰設計の確認

| 確認 | 対象ファイル | 確認結果・証拠 |
| --- | --- | --- |
| 最終Protocolを固定していない | `reference-adapter.ts` | in-process fixtureのみ。HTTP route、MCP Server、OAuth、固定Token、Plugin SDKを追加していない。 |
| 万能Job／Event busを増やしていない | `external-app-ingress.ts`、Automation service | 入口はQuery／Domain Operation／Activity Ingestの3つだけ。外部Workspace Job APIを追加していない。 |
| Gateway全面改修をしていない | `formal-workspace-ingress.ts` | 既存Pairing、delivery、retry、recovery、outbound MCPを変更せず、薄いFormal ingressを追加した。 |
| Automationの一般化を増やしていない | `core09-automation-domain-service.ts`、Migration 016 | 新規状態は管理停止とtoken所有だけ。heartbeat、cancel状態、state version、AbortSignal、汎用Workflowは追加していない。 |
| UIを変更していない | Scope ledger、差分 | `apps/web`、UI protocol、表示状態は変更していない。 |

## 結論

重大な未解決項目はCore09の対象範囲では残していない。`pnpm core:09:verify`は生成契約、72件のFocused test、Gateway recovery、関連6 packageのtypecheck、`git diff --check`を通した。

これはFocused verificationの成功であり、全リポジトリの全テスト成功、実Credentialを使う外部Adapter確認、製品全体の完成を意味しない。
