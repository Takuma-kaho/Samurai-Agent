# Core08 Scope Ledger

状態: **完了（修正後のFocused verification済み）**  
開始時点: 2026-08-09  
開始HEAD: `ce205d2`

## 対象

- `packages/core-schemas`: Workspace Change、Surface、SessionRefの互換契約。
- `packages/domain-operations`: Artifact、Collection、Generated SurfaceのSessionなしMutation。
- `packages/runtime`: Trusted Context、Room Resource再認可、Resource MutationとCore07 Activityの接続、Session互換Adapter。
- `packages/workspace-store`: Migration 014、row codec、Artifact／Collection／Surface repository、Backup／Restore境界。
- `packages/room-permissions`: Generated Surfaceの新規共有禁止とlegacy共有の読取・解除互換。
- `packages/action-catalog`、`apps/server`: 契約整合と既存Session経路の一方向接続だけ。
- `scripts/verify-core08.mjs`、`package.json`、Focused test、`plans/`、正本の古い現状説明。

## 対象外

- Web／Native App UI、Session一覧、画面状態、DOM状態、表示順。
- HTTP／MCP／Pluginの新規正式API、Gateway、Pairing、Automationの再設計。
- Memory／Knowledge／Skill生成、学習Processor、Activity後の自動Workspace Job。
- Collection Schemaの全面再設計、SurfaceのUI品質、Nostr／Relay／Event Bus／Workflow DSL。
- 旧Resource、旧Surface行、旧Backupの削除。

## 境界

- WorkspaceはArtifact・Collectionの正本、Roomは権限境界、SessionRefは任意の出所である。
- Artifact本体・Collection本体へRoom IDを重複保存しない。`resource_access_boundaries`がRoom境界の正本である。
- SurfaceのHTML／CSS／JSと`pinned`は互換・派生データであり、新しいWorkspace正本ではない。
- 公開payloadはRoom、Principal、Activity IDを決められない。Trusted Contextだけが決める。
- 通常保存はDomain Operationから行い、SurfaceはStore／DBを直接更新しない。
- Activityは変更証拠であり、Memory／Knowledge／Skill／Jobを自動作成しない。

## 完了した確認項目

- [x] Migration 013→014、restart、旧Backup restore。Migration 014は旧行のRoomを推測せず保持する。
- [x] Artifact／Collection／SurfaceのSessionなし主要Mutation。新しいMutationでSession行を生成しない。
- [x] Room越境、共有、解除後、偽造SessionRef、候補後再認可。新しいGenerated Surface共有は拒否し、旧共有の読取・解除互換は残す。
- [x] retry、Revision／Patch conflict、ファイル／DB失敗回復。
- [x] Activity・Workspace Change・ResourceUsageの重複防止。親RunのActivityは再利用し、直接操作だけを完了・失敗にする。
- [x] 保存後の証跡失敗は、Resourceを再保存せず明示エラーとして記録・再試行する。Change／Usage／直接Activityの成功確定は1トランザクションで行う。
- [x] 新しいWorkspace ChangeはRoomと原因を必須にし、旧`legacy_operation_id`の新規書込みを拒否する。
- [x] SessionなしSurfaceの表示状態は保存せず、SessionRefだけで保存や認可を通過できない。
- [x] Collection Reindexは派生Index修復であり、Activity／Workspace Changeを追加しない。
- [x] 新BackupはSurface bundleを必須にせず、旧bundleと旧Surface共有は復元・確認・解除できる。
- [x] `pnpm core:08:verify`、typecheck、diff check、セルフレビュー。

## 未検証範囲

- 全Repository testとCIは実行していない。Core08専用Verifierのfocused範囲だけを完了根拠にする。
- Gateway、Automation、HTTP／MCP／Pluginの正式な外部接続はCore09対象であり、実装・検証していない。
