# Core06 参照OSS調査

調査時点: 2026-08-06

## Buzz

Repository: https://github.com/block/buzz
Commit SHA: `38bf642fcfa7a9fc1e06d6cf87d66ae94da29341`
確認した実装: `ARCHITECTURE.md`、`crates/buzz-core`、`crates/buzz-auth`、`crates/buzz-relay`。I/Oを持たないCore、server-ownedな`TenantContext`、認証済み接続状態、登録前と配信前のmembership再確認、検索候補と最終認可の分離を確認した。
確認したTest: `crates/buzz-core/src/filter.rs`、`crates/buzz-auth/src/access.rs`、`crates/buzz-relay/src/conformance/mod.rs`、`crates/buzz-relay/tests/e2e_relay.rs`の認証・membership・再認可テスト。
Samuraiへ採用: 認証済みContextをServer側で作り、Domain Operationへ渡す責務分離。検索候補取得後と返却直前のRoom権限再確認。
Samurai向けに変更: BuzzのTenant/Channel/Eventではなく、SamuraiのWorkspace/Room/Principal/Resource境界へ置き換える。
不採用: Nostr Event正本、Chat中心のRoom、Buzz固有のRelay製品設計。
理由: SamuraiのWorkspaceをKnowledgeの正本として維持し、Roomは会話ではなく共有・閲覧権限の境界にするため。

## Hermes Agent

Repository: https://github.com/NousResearch/hermes-agent
Commit SHA: `01a1037d1e6d7b6eb96a786ef282c3aea4818194`
確認した実装: `tools/registry.py`、`tools/memory_tool.py`、`tools/skills_guard.py`、`tools/skill_provenance.py`、`gateway/session.py`、`gateway/session_state.py`、`gateway/authz_mixin.py`、`gateway/pairing.py`のRegistry、Memory/Skillの出所、Lifecycle、認証・委任境界を確認した。
確認したTest: `scripts/whatsapp-bridge/allowlist.test.mjs`、`scripts/whatsapp-bridge/owner_message_gate.test.mjs`、Gateway/Skill/Memory関連の`tests/`とTUIテスト。
Samuraiへ採用: Registryを閉じた一覧で管理すること、Skill/Memoryの出所と失敗状態を明示すること、Lifecycleをテスト可能な単位へ分けること。
Samurai向けに変更: Agentの内部Registryを、Workspace側のDomain Operation・Room権限・Backend cassetteの契約へ適用する。
不採用: Agent-firstの製品構造、Hermes固有のSession保存、自律Agent全体。
理由: SamuraiではAgentはWorkspaceのparticipantであり、Workspaceが正本だから。

## MulmoClaude

Repository: https://github.com/receptron/mulmoclaude
Commit SHA: `81320eff4fbe1a0afb30a73518f72907d0d2338c`
確認した実装: `server/plugins/runtime-loader.ts`、`server/plugins/runtime.ts`、`server/plugins/diagnostics.ts`、`server/plugins/builtin-dispatch.ts`、`server/agent/backend/types.ts`、`server/remoteHost/`のHost、Plugin、Workspaceファイル、診断の境界を確認した。
確認したTest: `server/`のPlugin、Runtime、Remote Host関連テストと、診断・Preset読み込みのテスト配置。
Samuraiへ採用: Hostと実行Pluginを分離し、Workspaceファイルをユーザー所有の正本として扱い、診断を独立した確認経路にすること。
Samurai向けに変更: Claude専用Hostではなく、Claude Code・Codex・Native Backendが同じBackend cassette契約を使う形にする。
不採用: Claude専用のHost、Chat中心のWorkspace、画面構造。
理由: Backendは交換可能な実行エンジンであり、Native Appだけを特別扱いしないため。

## OpenClaw

Repository: https://github.com/openclaw/openclaw
Commit SHA: `ddcc3fbd80bfa163a458f1d8e8318d3d911bf424`
確認した実装: `src/gateway/auth.ts`、`src/gateway/server-live-state.ts`、`src/gateway/session-create-service.ts`、`src/gateway/session-utils.ts`、`src/channels/allowlists/`、`src/channels/message-access/`、`src/infra/node-pairing.ts`のserver-owned Context、Pairing、Allowlist、Session routing、Gateway securityを確認した。
確認したTest: `src/gateway/*pairing*.test.ts`、`src/channels/*allowlist*.test.ts`、`src/channels/message-access/*.test.ts`、`test/gateway.multi.e2e.test.ts`。
Samuraiへ採用: 接続元の認証・Pairing・AllowlistをGateway境界で確定し、Coreへは検証済みContextだけを渡すこと。Session routingと権限判定を分離すること。
Samurai向けに変更: SessionRefは外部参照に限定し、Roomと委任元Principalを権限の正本にする。
不採用: Messaging adapter群、SessionをCoreの中心にする構造、OpenClaw固有のGateway製品設計。
理由: Core06では実外部接続をCore09へ送り、Sessionは元アプリへ戻るための参照に限定するため。
