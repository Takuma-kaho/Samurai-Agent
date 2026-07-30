# Core 04 Phase 3 実装レビュー

2026-07-29。最終Sourceと最終検証結果を対象に、Backup・Restore完成範囲を確認した記録。

## 1. 責務

- `WorkspaceMaintenanceService`はHealth確認、filesystem/SQLite再同期、Retention判断だけを持つ。Backupの作成・削除・Import/Exportは`WorkspaceBundleService`、Stage・swap・rollback・起動時回復は`WorkspaceRestoreCoordinator`へ移した。
- `WorkspaceStore`は3サービスの組み立てと既存APIの明示的委譲だけを持つ。Facadeにfilesystem、path、Kysely、SQL、Bundle固有処理は置いていない。
- RetentionはMaintenanceが削除候補を決め、実削除はBundleへ委譲する。Backup/Import/Export/Restore/Repair/Retentionは同一Store内の狭いguardで直列化する。

## 2. Bundleの完全性

- SQLiteはOnline Backup APIでSnapshotを作り、Snapshotをcheckpointしてintegrity checkする。WAL内の確定rowを含むことをfixtureで確認した。
- 作成は隠しStageで行い、file transaction回収・pending件数確認・固定rootのcopy・hash照合・Manifest最後書込みを終えてから同一directory内でrenameする。失敗したStageは公開しない。
- payloadは`workspace.sqlite`と8つの固定rootだけである。`backups`、cache、派生学習データ、未知fileは対象外である。copy前後のmetadata snapshotが変わった場合もBundleを破棄する。

## 3. Manifestと移植性

- 新規Manifestはv2だけを出し、相対POSIX path、`source_root: "."`、migration番号、固定root、SHA-256を保存する。hashはstreamで計算する。
- Restore/Import前に、絶対path、`..`、backslash、重複root/hash、未知root、extra/missing file、hash不一致、symlinkなどのspecial file、未来format、未来schemaを拒否する。`resource_boundaries`は説明だけで、読込み許可に使わない。
- v1は読込み時に正規化し、schema番号をBackup DBから取得する。欠けた管理rootは空のStageとして作るため、復元先にある古いデータを混ぜない。
- 別rootへの移植で、Session、Event、Artifact、Surface、Memory、Wiki、Skill、Collection、Settings、Queue、Historyの参照と内容が一致した。

## 4. Restoreと中断回復

- Restoreは候補をStageで通常起動し、migration、file transaction回収、default settings、managed resource同期、Session検索初期化、DB integrityを完了してから現在Workspaceへ触る。
- swap前に現在状態のBackupを必ず作り、成功結果へ`pre_restore_backup_id`を返す。checkpoint busy/errorならswap前に中止する。
- journalは`prepared`、`current_moved`、`replacement_moved`、`verified`、`committed`をatomicに更新する。DB/WAL/SHMと全管理rootをrollback領域へ退避し、新DBへ古いWAL/SHMは使わない。
- `committed`前の強制終了では`WorkspaceStore.create()`が元状態へ戻す。`committed`後は復元状態を維持して残骸を片付ける。直接constructorは未処理journalを検出してDBを開かず停止する。

## 5. 既存契約

- 公開名`createWorkspaceBackup`、`listWorkspaceBackups`、`exportWorkspaceBundle`、`importWorkspaceBundle`、`restoreWorkspaceBackup`は維持した。
- Manifestはv1/v2 union、Restore結果は`pre_restore_backup_id`を必須化した。`workspace.backup.create`と`workspace.backup.restore`を2.1へ上げた。
- canonical ledger再生成で検出した既存Schemaとの差分は、承認済みのversion整合化として`automation.memory_review.run`、`chat.turn.run`、`collection.action.run`、`evaluation.run`、`gateway.inbound.route`、`reflection.run`だけをそれぞれ1段階上げた。Phase 3でこれらの実装振る舞いは追加・変更していない。
- Phase 1のfile transactionとPhase 2のCore 02 admission/event identity/settlementを、最終verifierで回帰確認した。

## 6. 簡潔性と範囲

- 分散lock、待機queue、retry framework、クラウド/暗号化/圧縮Backup、Event Sourcing、Actor、UI/route、DB migration/tableは追加していない。
- 強制終了回復はlocal journal、同時実行防止はStore instance内guardに限定した。単一Runtime前提を超える競合管理は持ち込んでいない。
- 旧Maintenanceの単純SQLite copy、copy後公開、直接swap、Import失敗時のBundle削除、Facade内の保存処理は同じ変更で削除した。

## 7. 最終確認

- `pnpm --filter @samurai-agent/workspace-store --filter @samurai-agent/domain-operations --filter @samurai-agent/runtime run typecheck` は成功。
- `pnpm core:workspace-persistence:verify` は成功。
  - WAL Snapshot、v2/v1、Stage公開、path/hash/type検証、future schema拒否、legacy Stage migration、pre-restore Backup、prepared/swap/restart failure rollback、kill recovery、portabilityを確認。
  - WorkspaceStore互換34件、Core 02契約14件、Host terminal diagnostic 1件も成功。
- `node scripts/generate-domain-operation-index.mjs --check`と`pnpm core:domain-commands:ledger`は成功し、canonical ledgerは102 Command、17 Query、5 Deprecatedで再生成した。ledgerの契約差分は上記6件とCore 04の2件だけである。
- `git diff --check` は成功。

## 結論

- 独立した読み取り専用レビューで、journal書込み失敗時に同一Storeが閉じたままになる経路を検出し、swap前に通常再起動してjournalを片付けるよう修正した。`prepared`失敗注入でも元状態とStore再利用を確認した。
- 修正後の独立した読み取り専用レビューの最終判定は、重大指摘なしである。
- 承認済みの既存version整合化とcanonical ledger再生成を完了した。Backup・Maintenance・Restoreの責務重複、SQLite/Filesystemの正本混同、未検証のswap経路、未解決の重大指摘は残っていないため、Core 04を完了とする。
