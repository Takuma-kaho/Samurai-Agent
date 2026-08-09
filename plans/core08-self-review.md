# Core08 セルフレビュー

状態: **完了**

## 反証する観点

- [x] Sessionを別名で再生成していない。
- [x] Artifact・CollectionはSessionRefを消しても存在・読取できる。
- [x] SurfaceがWorkspace正本、共有対象、新しい保存先になっていない。
- [x] Room候補後に返却・変更直前の再認可がある。
- [x] 公開payloadがRoom、Principal、Activityを注入できない。
- [x] 旧データをRoomへ推測移動・削除していない。
- [x] retryでResource、Revision、Patch、Change、Activityが増殖しない。
- [x] ファイルとSQLiteの途中失敗を成功扱いしない。
- [x] Workspace Job、Memory、Knowledge、Skill、UI、Gatewayを追加していない。

## 実装後に記録する項目

| 問題 | 修正 | 再検証 |
| --- | --- | --- |
| SessionなしCollection RecordのRoom境界がraw record IDになり、正規化された候補・再認可IDと一致しなかった | `runRecordedMutation`の境界保存で、Collection RecordのURI／collection IDから衝突しない`collectionRecordResourceId`を使うよう修正 | SessionなしSchema／Record／Patch、別Room・偽造SessionRefのPatch拒否を`core06-room-authorization.test.ts`で確認 |
| Backend Run内のArtifact操作で、親Activityの`workspace_id`と操作ContextのID形式が異なった | 親ActivityのPrincipal／Sourceを再利用しつつ、操作側のcorrelation／RunをWorkspace Changeへ残す小さいActivity接続Serviceに分離 | SessionなしBackend Tool BridgeのArtifact作成、Run・Room・Activity・ResourceUsage接続を`core06-workspace-execution.test.ts`で確認 |
| Artifact作成者が公開入力ではないものの、互換Contextのactor種別名になり得た | 作成者はTrusted ContextのPrincipal participantから決め、単体テストの明示Contextだけに限定して既存actor IDへfallbackする`trustedCreatorId`へ統一 | Artifact create／graph create／image generate／PDF exportとRoom認可テストで、保存値が信頼済みPrincipalであることを確認 |
| Resource保存後の証跡保存が失敗した時、Change／Usage／Activityの一部だけが残り得た | Change、Usage、直接操作用Activityの完了を1トランザクションにし、失敗時は保存済みResourceを再作成せず失敗Activityと決定的なエラーだけを残すようにした | `resource-mutation-activity-service.test.ts`、`core06-room-authorization.test.ts`、`domain-command-bus.test.ts`で原子性・再試行・同じエラーの再生を確認 |
| Surfaceのbundleを新Backupの正本として含めると、復元可否が派生表示に依存する | 新Backupから`surfaces`を外し、Restore時は旧bundleを許容しつつ新bundle不在でも正本を復元する | `core08-resource-session-boundary-migration.test.ts`とSurface lifecycle fixtureで確認 |
| SessionなしSurfaceの`opened`や`pinned`がWorkspaceへ残れば、表示状態を正本化してしまう | 表示状態のInteraction／State Operationは実Sessionを必須にし、SessionRefだけの呼出しを拒否した | `generated_surface/interaction/record.operation.test.ts`、`generated_surface/state.operation.test.ts`で保存されないことを確認 |
| 新しいWorkspace Changeが旧互換列やRoomなしで書けると、追跡と認可の根拠が曖昧になる | 新規書込み専用Schemaを追加し、RoomとActivity／Operation／Runの原因を必須化、`legacy_operation_id`新規書込みを拒否した | `core08-resource-session-boundary-migration.test.ts`で旧読取互換と新規拒否を確認 |
| Reindexがユーザーデータ変更と同じ証跡を作ると、履歴が実態より増える | Collection ActionのReindexを派生Index修復として明示し、通常Mutation証跡を作らない | `reindex.operation.test.ts`と`core06-room-authorization.test.ts`で確認 |
| 旧Generated Surface共有がMigration後に確認も解除もできなくなる | 新規共有だけを禁止し、旧共有は一覧・解除の互換経路を維持した | `core06-room-authorization.test.ts`で確認 |

## Core08対象外として残す確認

- `pnpm core:test:command-ingress`は、既存の`automation.job.save`がtrusted Sessionなしで呼ばれるため、base HEADにもある`session_compatibility_required`で停止する。Automationの正式なtrusted Context供給はCore09対象であり、Core08では偽Sessionを作って通過させない。

最終確認: `pnpm core:08:verify`（2026-08-09、base HEAD `ce205d2`）成功。Focused Vitest 19 files / 105 tests、Artifact／Collection／Surface／Backup fixture、8 packageのtypecheck、`git diff --check`を含む。全Repository test／CIは未実行であり、Core09対象の外部接続は判定に含めていない。
