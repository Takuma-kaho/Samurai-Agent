# Backend Architecture Contract Map

最終更新: 2026-06-26

このメモは `ARCHITECTURE.md` の backend 契約を、現在の実装単位へ落とすための内部用マップ。公開面では `PUBLIC_NAMING.md` を優先し、参照 OSS 固有名は出さない。

## 参照 OSS から採用する判断

- MulmoClaude:
  - Host と backend seam を分け、backend 固有イベントを portable event に変換する。
  - Workspace のファイルを正本にし、Collection / Skill / Wiki を「アプリ定義としてのファイル」に寄せる。
  - Collection は domain 固有コードではなく、schema / record / derived / action / notes の汎用 engine として扱う。
- Hermes Agent:
  - Memory / Skill / Session Search は混ぜず、Memory は短い理解、Skill は手順、Search は過去会話検索として分ける。
  - 外部 provider は補助であり、正本は Workspace 内の Markdown と SQLite read model に置く。
  - Curator は削除ではなく stale / archive / proposal / rollback を基本にする。
- OpenClaw:
  - Gateway は pairing / allowlist / source identity / session routing を担当し、Workspace 正本を直接更新しない。
  - sandbox / allowed tools / path safety は Gateway または Backend edge の責務であり、ActionCatalog には持ち込まない。
  - doctor は単なる疎通確認ではなく、危険設定や drift を説明し、repair plan を出す。

## 実装契約

### Workspace Store

- 正本:
  - Artifact / Memory / Knowledge Wiki / Skill / Collection 本文は filesystem。
  - SQLite は index / history / status / queue / audit 相当の read model。
- 実装済み:
  - Knowledge Wiki の `workspace/wiki/pages/*.md` と `wiki_index`。
  - `inspectWorkspace()` による layout / Wiki index drift / repair plan。
  - `reindexWiki()` による Markdown 正本からの `wiki_index` 再構築。
  - Collection schema / records の filesystem と SQLite index の drift 検査。
  - `reindexCollections()` による schema / record file からの Collection index 再構築。
  - `checkIntegrity()` による SQLite integrity と Workspace drift の統合確認。
  - `createWorkspaceBackup()` / `restoreWorkspaceBackup()` による filesystem 正本 + SQLite index/history の backup / restore。
  - doctor に Skill support files の orphan check を追加。
  - `migration_journal` に schema migration の成功/失敗履歴を保存し、doctor で最新行を確認。
  - `repairWorkspace({ dryRun })` / `POST /api/workspace/repair` による repair dry-run / apply 分離。
- 次:
  - migration failure recovery の自動復旧範囲整理。

### Agent Backend Cassette

- 正本:
  - Host が session / context / routing / result persistence を持つ。
  - Backend cassette は `runTurn` と event stream を返す。
- 実装済み:
  - `AgentBackend` に optional `startSession` / `streamEvents` seam。
  - Run metadata に backend native session id を保存できる hook。
  - ClaudeCode / Codex を含む External CLI backend の session handle を Run metadata に保存。
  - `POST /api/backend-runs/:runId/cancel` から Backend cassette の `cancelRun` を呼ぶ Host API。
  - `backend_cancelled` event は BackendRun `cancelled` として保存。
  - Runtime 側で Backend event payload / resource refs を保存前に正規化。
  - `POST /api/backend-runs/:runId/resume` から `resumeRun` event を保存し、非対応時も run state に残す。
  - Backend event projection fixture test。
- 次:
  - 外部CLIが実 native session id を返す場合の抽出 adapter。

### Surface Protocol / Host

- 正本:
  - Web UI からの操作は自由文だけでなく、typed surface operation として Host に渡す。
  - Host は operation を session / context / backend run / workspace write path へ変換する。
- 実装済み:
  - `SurfaceOperation` 型: message / form / table / chart / artifact / collection / custom-view。
  - `SurfaceOperationSchema` / `parseSurfaceOperation()` による Zod validation。
  - `AgentRuntime.runSurfaceOperation()` による typed operation dispatch。
  - `POST /api/surface/operations` による API entrypoint。
  - `surface_operation_id` / `surface_operation_kind` の BackendRun metadata 保存。
  - response の `result_kind` による frontend renderer contract。
- 次:
  - Surface Protocol の追加 renderer kind が必要になった時の互換方針。

### Gateway

- 正本:
  - external input は `GatewayInboundMessageRecord` と pairing 状態に保存。
  - paired / trusted になった後だけ Host へ渡す。
- 実装済み:
  - pairing / inbound routing の最小 table と API。
  - `/api/health` の Gateway summary。
  - Gateway source identity の入力正規化と session key 用 escaping。
  - Gateway inbound の短時間 duplicate guard。
  - Gateway inbound の source identity 単位 rate guard。
  - `SAMURAI_GATEWAY_SOURCE_ALLOWLIST` による Gateway allowlist enforcement。
  - doctor の Gateway allowlist warning。
- 次:
  - channel adapter の dry-run test。

### Memory / Knowledge Wiki / Skill

- 正本:
  - `Memory`: 短い個人理解。
  - `Knowledge Wiki`: 濃い知識資産。`state=active` だけを retrieval の根拠にする。
  - `Skill`: 再利用手順。support files は必要時に読む。
- 実装済み:
  - Knowledge Wiki proposal / accept / reject / patch / archive / reindex。
  - Skill support files の保存と API 表示。
  - doctor で Skill support files と Skill index の対応を確認。
  - Context Preview / BackendRunInput の Knowledge Wiki entry に `source_refs` を付与。
  - Reflection suggestion から Wiki / Skill proposal へ `source_refs` / provenance を引き継ぐ。
  - Curator は stale / archive 候補を suggestion として出すだけで自動削除しない。
  - Memory / Knowledge Wiki archive は Runtime operation + rollback point で保護。

### Doctor / Recovery

- 正本:
  - doctor は「今どこが壊れているか」と「次に何を実行すれば直るか」を返す。
- 実装済み:
  - workspace layout / db / provider / backend / API / latest run / Gateway / Knowledge Wiki index drift。
  - API 起動時は `/api/health` の Workspace summary も doctor に表示。
- 次:
  - migration failure recovery の自動復旧範囲整理。

## 現時点の優先順位

1. Workspace Store の drift detection / Wiki reindex / doctor。
2. Backend cassette lifecycle seam。
3. Skill support files の doctor 表示。
4. Gateway allowlist / source identity hardening。
5. Curator / backup / archive flow。
6. `web-front.md` に frontend 実装者向けの backend 前提を集約。
