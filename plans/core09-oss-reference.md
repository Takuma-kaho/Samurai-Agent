# Core09 参照OSS調査

確認日: 2026-08-10

Core09では、外部OSSの製品構造、公開名、接続プロトコルを移植しない。採用するのは、認可を接続可否と混同しないこと、永続ledger、冪等なclaim、Adapterの分離、否定テストの作り方だけである。

## Buzz

- Repository URL: <https://github.com/block/buzz>
- 固定Commit SHA: `5bf78671f45178f8de02ba18d3d321cbbf19cd1f`
- 読んだ実装: `crates/buzz-relay-mesh/src/membership.rs`
- 読んだテスト: 同ファイル内の、未anchor拒否・foreign relay identity拒否・attestation改竄拒否テスト
- Samuraiへ採用する作り方: 接続証拠は期待する接続元と一致した時だけ採用し、未設定・不一致はfail closedにする。到達性やPairingを権限と扱わない。
- 採用しない製品設計: Relay mesh、署名Event、Relay memberを中心にした権限モデル。
- 理由と守る不変条件: RoomはSamuraiのKnowledge・権限境界であり、Gateway／PairingはRoom権限を付与しない。

## Hermes Agent

- Repository URL: <https://github.com/NousResearch/hermes-agent>
- 固定Commit SHA: `2446c8bb6755ff5e6feff4d26e425661edd4019b`
- 読んだ実装: `cron/executions.py`
- 読んだテスト: `tests/cron/test_claim_job_for_fire.py`
- Samuraiへ採用する作り方: 実行前のclaim、terminal stateの一方向遷移、所有processが死亡した場合だけの復旧、実Storeを使う競合テスト。
- 採用しない製品設計: Agent-firstの自動Memory／Skill化、Session中心Cron実行。
- 理由と守る不変条件: Automationは現在の権限を再評価し、認可停止を通常Retryに変換しない。Activity保存後に学習を自動起動しない。

## MulmoClaude

- Repository URL: <https://github.com/receptron/mulmoclaude>
- 固定Commit SHA: `d9fbd9bbdfa9e78e81dfb69ec628193bc21c5a9e`
- 読んだ実装: `packages/bridges/telegram/src/router.ts`
- 読んだテスト: `packages/bridges/telegram/test/test_router.ts`
- Samuraiへ採用する作り方: Transportの入力正規化・allowlist判定・外部送信をRouterに閉じ、Core側の処理を注入可能なPortにする。拒否時にCore呼出をしない否定テストを置く。
- 採用しない製品設計: Chat／Plugin／BridgeがWorkspaceを所有する構造、Telegram等の具体チャネル仕様。
- 理由と守る不変条件: Transport AdapterはRepository／Storeを直接呼ばず、正式入口だけがWorkspace Coreを使う。

## OpenClaw

- Repository URL: <https://github.com/openclaw/openclaw>
- 固定Commit SHA: `46e6f93a86ae21b66a09f01910cb7c6b544af982`
- 読んだ実装: `src/channels/plugins/pairing.ts`
- 読んだテスト: `src/channels/plugins/pairing-adapters.test.ts`
- Samuraiへ採用する作り方: Pairingのplugin Adapter解決と承認通知を、後続の処理から分離する。Adapterごとの入力正規化を小さな境界テストで確認する。
- 採用しない製品設計: Personal AssistantのSession中心Gateway、最終Plugin／HTTP／MCPプロトコル。
- 理由と守る不変条件: PairingはTransport admissionだけであり、Connection・Room権限・Domain Operation権限にはならない。

## Core09での適用

- `ExternalAppContextResolver`は、Connector evidence、Connection、委任元、Room権限を順に再確認し、いずれも欠けた時は副作用前に拒否する。
- Automationは既存Lock・Retry・restart recoveryを保持し、権限失効は`blocked` ledgerとして終端する。
- Reference Adapterはin-process fixtureだけとし、本番HTTP／MCP／OAuth仕様は追加しない。
