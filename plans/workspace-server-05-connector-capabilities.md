# Workspace Server 05：Connector能力表

確認日: 2026-08-17

参照した公式仕様は、公開仕様が変わった場合に再確認する。CodexのTranscriptなど非公開形式は本番契約にしない。

| Connector | MCP Transport | OAuth | Context注入 | Hook / Event | 全文取得 | URL Elicitation | OS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Codex | Streamable HTTP / stdio | 対応 | Server instructions + 初回Tool | 公式Hookは補助経路 | 不保証 | クライアント能力に依存、Fallbackあり | macOS / Windows / Linux |
| Claude Code | Streamable HTTP / stdio | 対応 | MCP + Project設定 / Hook | Session・Tool・終了Hook | 不保証 | クライアント能力に依存、Fallbackあり | macOS / Windows / Linux |
| Hermes | MCP | クライアント設定に依存 | 初回Tool取得 | Shell Hookの`on_session_start`／`on_session_end` | Hook由来の部分Capture | 非対応時はFallback | macOS / Windows / Linux |
| OpenCode / OpenClaw | 後続Adapter | 未固定 | 未固定 | 未固定 | 未固定 | 未固定 | 後続確認 |

## 実装済みの導入経路（focused確認）

- Server起動時にCodex、Claude Code、Hermesの公式Manifestを登録する。各Workspaceでは本人が明示的にInstall／Enableするまで利用できない。
- `GET /connectors/config` は、ログイン済み本人・Workspace・Installationを確認してから、OS別のMCP設定と対応するHook設定を返す。TokenやClient secretは返さない。
- Hook設定は、Client側へインストールしたrelay commandを`SAMURAI_EXTERNAL_HOOK_COMMAND`またはCompositionへ明示した場合だけ返す。未設定時は`configuration_required`を返し、動かないScriptを設定済みとは表示しない。設定済みHookにはインストール済みConnector Versionを`--connector-version`で固定し、Upgrade後の古いHookをActivityへ混入させない。
- OAuthはProtected Resource Metadata、Authorization Code + PKCE、Resource audience、Redirect policy、短命Code、Refresh rotationを使う。
- Codex／Claude Code／HermesのShell HookはActivity／Capture入口へ送る。Hook入力はClient別Adapterで正規化し、Activityへ生ログを保存しない。

この経路は自動テスト済みだが、実Client／実ログイン／3OS／Hosted／Self-hostの証拠はまだない。

## 採用した作法

- MCPはサーバー側の共通Tool契約だけを持ち、Clientごとの差はAdapterへ閉じ込める。
- OAuthはAuthorization Code + PKCE、state、完全一致Redirect、短命Code、Refresh Rotationを必須にする。
- URLによる承認は、秘密をURLへ入れず、同じ本人のブラウザSessionで再認証してから一回だけ実行する。
- Hookで取れない会話全文やターミナルは「一部取得」または「非対応」と記録する。

## 採用しない設計

- 外部AgentがWorkspaceやKnowledgeの正本を所有する設計
- 外部PluginへDB・Workspaceファイル・生Tokenを渡す設計
- 非公開Transcript形式を必須のActivity入力にする設計
- 全文保存を標準有効にする設計

## 参照先

- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Claude Code Hooks](https://code.claude.com/docs/en/hooks)
- [Hermes Event Hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks/)
- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP URL Elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)
- Buzz: `f956e6fe06a76e50cbd8fba1a162482e752e7f1a`
- Hermes: `bab7be3ca7ee2ca58d38f29c189ddb4dd38035ff`
- MulmoClaude: `f02d8a4c7a93924e5704e1894ed58dc4456696da`
- OpenClaw: `327974f2d0e2801917562de1500b3664e99cbdb`
