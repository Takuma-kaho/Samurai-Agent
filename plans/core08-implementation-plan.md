# Core08: Artifact・Collection・SurfaceのSession分離

状態: **完了（修正後のFocused verification済み）**
開始日: 2026-08-09
開始HEAD: `ce205d2`

## 目的

Artifact・CollectionをWorkspace／Roomが所有する正本へ寄せ、Sessionを任意の出所参照にする。Surfaceは再生成可能な表示投影として残す。

```text
Trusted Context → Domain Operation → Artifact / Collection → Activity + Workspace Change
                                          ↓
                                  Surface（派生表示）
```

## 固定した実装順

1. Session依存をA〜Eへ分類し、OSSの採用範囲を記録する。
2. Core Schema、Migration 014、Store codecをSessionなしの変更履歴へ更新する。
3. Resource MutationとCore07 Activity／ResourceUsage／Workspace Changeを狭いServiceで接続する。
4. ArtifactとCollectionの主要MutationをTrusted Contextのみで実行できるようにする。
5. Generated Surfaceの永続行から必須`session_id`を外し、Room Resource境界で認可する。
6. Session付きNative App経路を新Coreへ一方向接続し、旧データ・旧Backupを保持する。
7. Focused testと`pnpm core:08:verify`、セルフレビューで完了を判定する。

## 変更しない範囲

- Native App／Web UI、Gateway、MCP、Pluginの新しい公開接続。
- Memory、Knowledge、Skill、自動学習、Activity保存後のJob自動作成。
- Collection Schemaの全面再設計、Surfaceの見た目・UI状態、Nostr／Relay／Event Bus／Workflow DSL。
- Migration 001〜013と既存データの削除。

## 完了判定

- Sessionが0件でもArtifact・Collectionの主要MutationとSurface作成／Revisionが動く。
- Room Resourceの候補後再認可、競合、再試行、失敗回復、旧データ／Backup互換をFocused testで確認する。
- Operation、Workspace Change、Activity、ResourceUsageが同じResourceを追跡する。
- Surfaceを除いた新BackupでもArtifact／Collectionの復元結果が変わらない。
- `pnpm core:08:verify`と`git diff --check`が最新差分で成功する。

詳細な対象・対象外・証拠は[Scope台帳](./core08-scope-ledger.md)、Session分類は[Session依存分類](./core08-session-dependency-classification.md)、反証レビューは[セルフレビュー](./core08-self-review.md)に残す。

最終確認は`pnpm core:08:verify`で実行した。全Repository test／CIと、Core09の外部接続はこの計画の完了判定に含めない。

## 修正後の再確認（2026-08-09）

- Resource保存後の証跡は、Workspace Change・ResourceUsage・直接操作用Activityの完了を1トランザクションで確定する。失敗時は保存済みResourceを作り直さず、再試行でも同じ失敗を返す。
- 新しいWorkspace ChangeはRoomと原因（Activity／Operation／Runのいずれか）を必須にし、旧`legacy_operation_id`は読取互換だけにした。
- SessionなしSurfaceは表示状態を保存できず、Surface bundleは新Backupでは派生cacheとして省く。旧bundle・旧共有は読取／解除互換を維持する。
- CollectionのReindexは派生Index修復として扱い、通常の変更証跡を増やさない。
- `pnpm core:08:verify`はFocused Vitest 19 files / 105 tests、Artifact／Collection／Surface／Backup fixture、8 packageのtypecheck、`git diff --check`まで実行する。
