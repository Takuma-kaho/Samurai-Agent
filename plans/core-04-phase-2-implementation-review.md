# Core 04 Phase 2 実装レビュー

2026-07-29。最終コマンド検証の前後に、移動後のproduction sourceと差分を6視点で確認した記録。後半の「責務境界の是正」は、初回レビューで見つかった2件を修正した追記。

## 1. 責務

- 確認: `workspace-store.ts`、`kernel/workspace-resource-catalog.ts`、各`repositories/`、各`rows/`。
- 判断: `WorkspaceStore`は初期化、終了、root/db path、組み立て、既存APIの明示的な委譲だけを持つFacadeになった。Node filesystem、path、Kysely、SQL、Row変換、Resource固有状態遷移は残っていない。
- 判断: Catalogは静的な定数だけで、SQLite全テーブルに一つの書込み担当、必要ディレクトリ、Backup対象を定義する。動的登録、Plugin読込、Service Locatorは追加していない。
- 判断: 旧StoreのResource固有実装とRow型を同じ変更で各担当へ移し、旧実装を残していない。`WorkspaceDb`は担当Row型を合成するだけになった。

## 2. 一括保存

- 確認: `repositories/session-execution-repository.ts`、`repositories/collection-repository.ts`、`transactions/`、Core 02 focused tests。
- 判断: Session、Message、Operation、Run、Event、Reservation、Tool Run、Workspace Changeを同じ`SessionExecutionRepository`に置いた。`admitTurn()`と`commitTurnSettlement()`のtransaction、CAS、idempotency、busy retry、再実行判定は移動前の契約を維持している。
- 判断: 終端後のManaged Resource同期はSettlement transactionの外で行う。同期失敗は完了済みRunやReservationを戻さず、既存Backend Event形式のHost Diagnosticへ残す。
- 判断: Collectionのファイル・SQLite一括更新と既存File Transaction復旧はCollection担当と既存Coordinatorに維持し、別の競合制御や`BEGIN IMMEDIATE`は追加していない。

## 3. 正本

- 確認: `repositories/managed-resource-synchronizer.ts`、Memory/Wiki/Skill/CollectionのParser・Repository、`workspace-store.ts`の起動順。
- 判断: Memory、Wiki、Skill、Collectionだけをfilesystemから再Indexする。相対パス順に既存本番Parser/Schemaで読むだけで、同期自体はファイルを変更・削除しない。
- 判断: 各モジュールは全I/O読込後に一つのSQLite transactionでIndexを追加・更新・削除する。I/O失敗時は対象Indexを変えず、別モジュールの同期を続ける。重複は辞書順で最初の正常ファイルを採用し、不正形式はIndexから除外する。
- 判断: 起動順はWorkspace directory、Migration、未完了File Transaction復旧、Default Settings、Managed Resource同期、Session Search初期化の順になっている。

## 4. 依存方向

- 確認: `packages/memory/src/index.ts`、`packages/artifacts/src/index.ts`、`packages/runtime/src/`のproduction import。
- 判断: Memory、Artifact、Runtimeの各Serviceは必要な専用Portだけを受け取る。巨大な`WorkspacePorts`、`Pick<WorkspaceStore, ...>`、BackendからのWorkspace永続化実装依存は追加していない。
- 判断: 具体的な`WorkspaceStore`をimportするproductionコードは`AgentRuntime`とcompositionに限定した。複数担当を読むTranscript、Search、Activity、Correlation Traceは読み取り専用`WorkspaceQueryService`で合成する。

## 5. 障害復旧

- 確認: `kernel/workspace-kernel-service.ts`、`services/workspace-maintenance-service.ts`、`services/managed-resource-post-turn-service.ts`、Focused verify fixture。
- 判断: Migration v1〜v6、File Transaction復旧、Restore、Session Searchの既存契約とchecksumを変更していない。Restore後も起動時と同じ再構成順でStoreを使い直す。
- 判断: 同じfilesystem状態で二回同期した場合、二回目のIndex変更数は0になる。I/O失敗、重複、不正ファイル、終端後同期失敗を実WorkspaceとSQLiteで確認した。
- 判断: Host Diagnosticは既存の厳格なBackend Event payloadに合わせ、操作名を`command_name`、補足値を`usage`へ保持する。Run状態を変更しない。

## 6. 簡潔性と範囲

- 確認: 全差分を通常順・逆順で読んだ結果、Catalog、Facade、Repository、Query、Maintenanceの境界に未使用抽象や将来用Hookは見つからない。
- 判断: 本変更はPhase 2の責務移動、filesystem再Index、Facade化、狭いPort、Focused verify、レビュー記録に限定した。Migration、DB Schema、Watcher、動的Plugin、Event Sourcing、Actor方式、新製品機能は追加していない。

## 7. 責務境界の是正

- 指摘: 初回実装では`ManagedResourceSynchronizer`が4種類のfilesystem読取り、Parser、Index SQLを直接持っていた。また`WorkspaceMaintenanceService`がResource固有SQLとParserを直接使っていた。Catalog上の担当と実装上の担当が一致していなかった。
- 是正: Memory、Knowledge Wiki、Skill、Collectionの各Repositoryへ、全I/O読取り後の検証・差分判定・1 transactionのIndex更新を移した。`ManagedResourceSynchronizer`は4担当を順番に呼ぶだけで、SQL、Kysely、filesystem、Parserを持たない。
- 是正: Artifact/Memory/Wiki/Skill/CollectionのHealth確認は各担当の狭いPortへ移し、横断するCollection参照切れとSession Search確認は読み取り専用`WorkspaceQueryService`へ移した。SQLite integrity checkと段階Restore時のDB検査はKernelが担当する。
- 確認: `WorkspaceMaintenanceService`からResource SQL・Row変換・Resource Parserを除去した。Backup/Restoreのファイル入替だけはMaintenanceに維持し、既存の復旧契約を変えていない。
- 確認: Focused fixtureはCatalogだけでなく、非Migration production sourceの実際の書込み箇所を全テーブルごとに走査する。書込み元がCatalogの担当外なら失敗し、SynchronizerとMaintenanceの禁止依存も失敗する。

## 最終確認

- `pnpm --filter @samurai-agent/workspace-store --filter @samurai-agent/memory --filter @samurai-agent/artifacts --filter @samurai-agent/runtime run typecheck` は成功。
- `pnpm core:workspace-persistence:verify` は成功。
  - 実SQLiteの全テーブル所有者と、非Migration production sourceの実書込み担当、Facadeと依存方向、既存APIの主要保存・取得・更新を確認。
  - Memory/Wiki/Skill/Collectionの追加・更新・削除・重複・不正形式・I/O失敗・二回目無変更を確認。
  - `mock`、`samurai_native`、`claude_code`、`codex`、`external`の全種別で、終端後同期経路を確認。
  - Migration checksum、File Transaction復旧、Restore、Session Search、WorkspaceStore互換34件、Core 02のAdmission/Event identity/Settlement 14件、Host terminal diagnostic 1件を確認。
- `git diff --check` は成功。

## 結論

- 初回の2件（同期担当の二重化、Maintenanceの直接Resourceアクセス）は解消した。Phase 2範囲に重大な未解決指摘はない。Facade、実書込み担当、Core 02の一括保存、filesystem再Index、既存復旧契約、依存方向をFocused verifyで確認済み。
