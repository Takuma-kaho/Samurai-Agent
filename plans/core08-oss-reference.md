# Core08 参照OSS調査

確認日: 2026-08-09

Core08では、製品構造や公開名を移植せず、権限の再確認、入力検証、互換Migration、冪等性、失敗テストという作り方だけを採用する。

## Buzz

- Repository URL: <https://github.com/block/buzz>
- 固定Commit SHA: `5bf78671f45178f8de02ba18d3d321cbbf19cd1f`
- 読んだ実装: `crates/buzz-db/src/channel.rs`
- 読んだテスト: 同ファイル内のchannel membership・role・競合テスト
- Samuraiへ採用する作り方: 候補を絞った後、更新直前に参加状態と権限を再確認する。作成と所属変更はDBの一意制約・transactionで冪等にする。
- 採用しない製品設計: Chat中心のChannel、Relay、Event配送モデル。
- Samurai側の対応箇所: `RoomAuthorizationService`によるArtifact・Collection・Surfaceの候補後再認可、Resource Mutationの再試行処理。
- 検証方法: Room越境ID指定、解除後アクセス、同一idempotency keyの再試行、競合更新のFocused test。

## Hermes Agent

- Repository URL: <https://github.com/NousResearch/hermes-agent>
- 固定Commit SHA: `961f7481a7a75456e5e13b71e5343c70ea2ec74b`
- 読んだ実装: `acp_adapter/provenance.py`、`tools/file_state.py`
- 読んだテスト: `tests/acp/test_session_provenance.py`、`tests/tools/test_file_state_registry.py`
- Samuraiへ採用する作り方: Session由来の情報は既存正本へ付加する任意provenanceとして扱う。状態管理は責務を小さくし、直接結線のテストで確認する。
- 採用しない製品設計: Agent-firstのMemory・学習・Session中心の製品モデル。
- Samurai側の対応箇所: `SessionRef`、`ResourceMutationActivityService`、Artifact／Collection／Surfaceの互換Adapter。
- 検証方法: SessionRefの有無で同じResourceを読めること、SessionRef偽造で認可されないこと、直接操作Activityの重複防止。

## MulmoClaude

- Repository URL: <https://github.com/receptron/mulmoclaude>
- 固定Commit SHA: `e0241304061137f492c877b1489351fc8fa92770`
- 読んだ実装: `packages/core/src/collection/server/mutate.ts`
- 読んだテスト: `test/workspace/collections/test_mutate.ts`
- Samuraiへ採用する作り方: 入力検証、現在状態の読取、実データへの最終gate、書込みを一つのMutation経路に置く。実Workspaceを使って失敗回復を検証する。
- 採用しない製品設計: Chat／Plugin／アプリがWorkspaceを所有する構造。
- Samurai側の対応箇所: CollectionのSchema・Record・Patch操作、File Transaction／SQLite recovery、Room候補後再認可。
- 検証方法: stale Version、ファイル書込み失敗、DB書込み失敗、再起動後読取、Viewが副作用を持たないこと。

## OpenClaw

- Repository URL: <https://github.com/openclaw/openclaw>
- 固定Commit SHA: `dba99b355b4e75cc97fddaf78bbf9c5a3058ca34`
- 読んだ実装: `src/context-engine/registry.ts`
- 読んだテスト: `src/context-engine/quarantine-health.test.ts`
- Samuraiへ採用する作り方: server-ownedの信頼済みContextを公開payloadから分離する。互換経路は狭く明示し、失敗・隔離・再試行を実テストする。
- 採用しない製品設計: Session中心Gateway、Plugin実行基盤、一般化されたContext Engine。
- Samurai側の対応箇所: `TrustedDomainContext`、Session互換Adapter、Migration 014、Core08 verifier。
- 検証方法: 公開payloadのRoom／Principal／Activity注入拒否、旧Session付き行の読取、Sessionなし新規保存、静的境界検査。
