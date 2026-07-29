# Core 04 Phase 1 実装レビュー

コマンド検証の前に、修正後のSourceを5視点で確認した記録。

## 1. 責務

- 確認: `workspace-store.ts`、`kernel/workspace-paths.ts`、`kernel/workspace-database.ts`、`kernel/session-search-index.ts`、`transactions/workspace-file-transaction-coordinator.ts`。
- 判断: Facadeは既存CRUDを維持し、配置・DB接続・Migration・FTS初期化・File Transaction復旧をKernel所有者へ委譲している。Kernel／TransactionのimportはNode、Kysely、Core Schema、同package内に閉じ、Runtime／Server／Backend packageへは依存していない。
- 判断: Coordinatorはjournal、staged file、SQLite transaction、renameの順序だけを所有する。Collectionのversion・patch・rollback条件は`collection-record-recovery-handler.ts`に閉じており、KernelへResource意味を戻していない。

## 2. Migration

- 確認: `kernel/migration-runner.ts`、`migrations/001-core-baseline.ts`〜`006-pre-core04-schema-normalization.ts`、`scripts/fixtures/workspace-migration.ts`。
- 判断: v1〜v5は過去のname・statement順・checksumを固定し、v6だけが既存の起動時補修を一度限りの履歴へ移す。履歴不正時にmetadata tableを新規作成しない順序へ修正した。
- 判断: v6はtransaction内の一時tableで「Knowledge Wikiの新列が移行前から存在したか」だけを記録し、legacy列は新列が未存在だった時だけ転記する。一時tableは同migrationの最後で削除されるため、永続SchemaやMigration step型を増やしていない。

## 3. 障害

- 確認: `kernel/workspace-database.ts`、`workspace-store.ts`の`create`／Restore経路、`transactions/workspace-file-transaction-coordinator.ts`、`transactions/collection-record-recovery-handler.ts`。
- 判断: 初期化失敗では接続を閉じ、Migrationは1件単位でrollbackする。Collectionの意味はHandlerに閉じ、未知kindは削除せず起動を止める。
- 判断: DB確定前はjournalを通常片付ける。DB確定後かつrename前、rename完了後、rollback失敗時はjournalとstaged fileを残して再起動時の既存Recoveryへ渡す。rename失敗時だけDB rollbackとjournal削除を同一transactionで試みるため、完成済みfileに対してDBを戻さない。
- 判断: Handlerのrollbackはafter versionだけをbeforeへCASで戻す。既にbeforeなら冪等に完了し、より新しいversionまたは欠損なら`workspace_file_transaction_rollback_conflict`でjournalを残して停止する。

## 4. 簡潔性

- 確認: 新規Kernel／Migration／Transactionの公開型と呼出箇所、`scripts/fixtures`の障害ケース。
- 判断: 実際に使うPaths、DB lifecycle、固定Migration、検索Index、Collection Handlerだけを追加した。追加したのはCoordinator内の状態flagとHandler内のprivate CAS helperだけで、Plugin registry、汎用Event Sourcing、Resource Repository化、テスト専用production hookは追加していない。

## 5. 参照OSSの境界

- 確認: `kernel/workspace-db-schema.ts`、`kernel/session-search-index.ts`、`workspace-store.ts`のRestore経路、検索／Restore fixture。
- 判断: SQLiteの接続設定・Schema履歴・FTS派生Index・filesystemとの確定順を別所有者にし、人間向けWorkspace filesとSQLite運用状態の境界を保持している。FTSは起動時に既存tableを利用し、明示的reindexだけが全件再構築する。FTS障害時は同一検索からLIKEへ戻る。
- 判断: 参照OSSと同じく、永続化の単位を「Workspace本体」「SQLite履歴」「派生検索Index」「file transaction journal」に分けた。一方でPhase 2以降のPlugin化やRepository移行には踏み込んでいない。

## 結論

- 上記5視点で、Phase 1範囲に残る重大な責務混在、Migrationの値上書き、DB確定後のjournal喪失は見つからない。次は同じproduction sourceを通るfocused検証で確認する。
