# Core追加実装の参照OSS記録

## Hermes Agent

- Repository: `NousResearch/hermes-agent`
- 確認commit: `e589b739ca70eba00aa90fd3d0228bada00dbf8f`
- 実装: `agent/curator.py`, `agent/memory_manager.py`, `agent/skill_commands.py`, `cron/scheduler.py`
- Test: `tests/agent/test_curator.py`, `tests/agent/test_skill_commands.py`, `tests/tools/test_skill_usage.py`
- 採用: pin保護、archiveと復元、background review、Skill利用結果の評価。
- Samurai向け変更: 独立Agent Coreは持ち込まず、既存RuntimeとWorkspaceのDomain Commandへ統合した。
- 不採用: Hermes固有のprovider、CLI、Desktop、独自session保存。

## OpenClaw

- Repository: `openclaw/openclaw`
- 確認commit: `8809848b19995e93b4f4713b88ea51f92143b788`
- 実装: `src/pairing/pairing-store.ts`, `src/routing/session-key.ts`, `docs/gateway/security/index.md`
- Test: `src/pairing/pairing-store.test.ts`, `src/pairing/pairing-store-keys.test.ts`, `extensions/discord/src/resolve-allowlist-common.test.ts`
- 採用: Pairingの期限・承認、Allowlist、threadとSessionの安定対応、Channel境界。
- Samurai向け変更: SQLite実装の複製ではなく、Workspace正本の既存Gateway tableとDomain Commandへ統合した。
- 不採用: 全Messaging adapter、OpenClaw固有CLI、独自Browser engine。

## MulmoClaude

- Repository: `receptron/mulmoclaude`
- 確認commit: `1874d2564fb5ae1b0e8abb191118e54c24bf8a9b`（ローカル参照clone）
- 実装: `server/plugins/runtime-registry.ts`, `server/plugins/runtime-loader.ts`, `src/lib/wiki-page/graph.ts`, `src/utils/canvas/viewMode.ts`
- Test: `test/plugins/test_runtime_registry.ts`, `test/plugins/test_runtime_loader.ts`, `test/lib/wiki-page/test_lint.ts`, `test/lib/wiki-page/test_graph.ts`
- 採用: ToolとSurfaceの同居manifest、runtime plugin診断、Wiki lint/backlink、必要時だけ開くCanvas。
- Samurai向け変更: アプリ中心のWorkspace UXはコピーせず、Chat主導・Workspace正本・同一Domain Commandを維持した。
- 不採用: Claude Code専用Host、独自Todo/3D/Voice、完成済み画面の見た目コピー。

## 確認日

- 2026-07-13
