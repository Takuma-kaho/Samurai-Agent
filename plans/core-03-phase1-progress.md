# Core03 Phase1残件＋Phase2外部Backend 実装Evidence

更新日: 2026-07-27

## 判定

プランで指定された4点を実装済み。実CLI・E2E・全テスト・remote CIは実施していない。

| 対象 | 判定 | 根拠 |
| --- | --- | --- |
| 開始責任者 | 実装済み | `ClaudeCodeBackend`／`CodexBackend`だけが`execution_owner = "backend"`を持ち、開始Eventは各Providerの初期Eventから生成する。共通runnerは開始Eventを生成しない。 |
| Module分割 | 実装済み | `contract.ts`はBackend契約・入力型・Registry、`process-runner.ts`はraw process lifecycle、`external-cli.ts`は共通CLI実行・close後terminal判定・接続状態、`external-backend-context.ts`はprompt／env、`mock-backend.ts`はMock、`claude-code.ts`／`codex.ts`はProvider固有引数・Session・decoder・最終メッセージを担当する。 |
| Event契約 | 実装済み | `BackendOutputEventSchema`と`BackendEventRecordSchema`はEvent種別ごとのstrict schema。未知・非JSON・必須項目不足は`backend_protocol_diagnostic`経由で成功扱いにしない。旧履歴はStore読み取り互換を維持する。 |
| Event対応表 | 整備済み | 下表に固定OSS Event、Samurai Event、必須項目、producer／consumer、保存場所、不正時の動作を記録した。 |

## Event対応表

| 元Event | Samurai Event | 必須項目 | producer | consumer／保存 | 不正・未知時 |
| --- | --- | --- | --- | --- | --- |
| Claude `system/init` | `run_started` | `session_id` | `claude-code-decoder.ts` | `TurnExecutor`／`RunLifecycle`のSession CAS → `BackendEventJournal` → `backend_events` | Sessionなしは診断、close後にfailed |
| Claude `stream_event` のtext delta | `text_delta` | deltaの`text` | `claude-code-decoder.ts` | `TurnExecutor`／`BackendEventBridge` → `backend_events` | 空deltaは出力せず、異常JSONは診断 |
| Claude `assistant` text | `text_delta` | text | `claude-code-decoder.ts` | `TurnExecutor`／`BackendEventBridge` | stream出力済み部分は重複排除 |
| Claude `assistant` tool use | `tool_call_started` | tool ID、tool name | `claude-code-decoder.ts` | `TurnExecutor`／`BackendEventBridge` → `backend_events`（`execution_owner=backend`のためHostは再実行しない） | ID・nameなしは診断、Toolは実行しない |
| Claude `user` tool result | `tool_call_output` | `tool_use_id` | `claude-code-decoder.ts` | `TurnExecutor`／`BackendEventBridge` → `backend_events` | IDなしは診断 |
| Claude `result` | terminal判定材料 | result／error | `claude-code-decoder.ts` | `external-cli.ts`のprocess close判定 → 既存Settlement | close前に確定しない。重複resultは無視 |
| Codex `thread.started` | `run_started` | `thread_id` | `codex-decoder.ts` | `TurnExecutor`／`RunLifecycle`のSession CAS → `BackendEventJournal` → `backend_events` | IDなしは診断 |
| Codex `item.started` のTool | `tool_call_started` | `item.id`、item type | `codex-decoder.ts` | `TurnExecutor`／`BackendEventBridge` → `backend_events`（`execution_owner=backend`のためHostは再実行しない） | IDなし・未知Toolは診断 |
| Codex `item.completed` のTool | `tool_call_output` | `item.id`、completed | `codex-decoder.ts` | `TurnExecutor`／`BackendEventBridge` → `backend_events` | IDなし・途中結果は成功扱いしない |
| Codex `item.completed` agent message／reasoning | `text_delta`／`agent_reasoning` | completed text | `codex-decoder.ts` | `TurnExecutor`／`BackendEventBridge` → `backend_events` | 未完了・空文字は出力しない |
| Codex `item.updated`／`todo_list` | `host_progress` | 表示可能なtext | `codex-decoder.ts` | `BackendEventBridge` → `backend_events` | 表示内容なしは出力しない |
| Codex `turn.completed`／`turn.failed` | terminal判定材料 | terminal種別 | `codex-decoder.ts` | `external-cli.ts`のprocess close判定 → 既存Settlement | close前に確定しない |
| 非JSON／未対応Provider Event | `backend_protocol_diagnostic` | provider、reason、短い概要 | `cli-parser.ts`（非JSON／canonical）／Provider decoder（未対応Provider Event） | `TurnExecutor`／`BackendEventBridge` → `backend_events` | 回答・Tool・状態判断には使わず、close後failed |

## 共通producer／consumer

- producer: `claude-code-decoder.ts`、`codex-decoder.ts`、既存Native／Tool Bridgeのcanonical Event生成箇所。
- 共通処理: `process-runner.ts`はspawn、stdin／stdout／stderr、abort、closeだけを担当し、`external-cli.ts`はCLI preflight、Provider decoderの呼び出し、close後terminal判定、接続状態を担当する。prompt／envは`external-backend-context.ts`、Mockは`mock-backend.ts`へ分離した。
- consumer: `TurnExecutor`、`BackendEventBridge`、`BackendEventJournal`、Workspace Storeの`backend_events`保存。
- `contract.ts`はBackend契約・入力型・Schema・Registry・Statusだけを公開し、Provider固有処理を持たない。Provider decoderの選択は`claude-code.ts`／`codex.ts`が所有し、`cli-parser.ts`はgeneric canonical JSONだけを扱う。

## 過剰実装を避けた範囲

- 実CLI、E2E、全テスト、全build、PR、remote CIは実施していない。
- retry、fallback、新DB、汎用Protocol Frameworkは追加していない。
- 既存の実CLI／E2E検証器の差分は変更していない。

## 最小確認

- `@samurai-agent/core-schemas` typecheck: exit code 0
- `@samurai-agent/agent-backends` typecheck: exit code 0
- `@samurai-agent/runtime` typecheck: exit code 0
- `@samurai-agent/workspace-store` typecheck: exit code 0
- Claude／Codex・開始責任者・canonical Eventのfocused test: 6 tests passed
- backend delegated-capabilities fixture: passed
- Core Event schema focused test: 2 tests passed
- EventBridge／TurnExecutor focused test: 13 tests passed
- Workspace Store focused test: 1 test passed
