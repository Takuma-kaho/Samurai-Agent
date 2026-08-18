# Workspace Server 05：外部連携要件台帳

作業ブランチ: `05-External-integration`
正本: 2026-08-17に確定した「技術版：5番 外部連携」17項目

## 実装範囲

| # | 要件 | 実装場所 | 現在の証拠 | 判定 |
| ---: | --- | --- | --- | --- |
| 1 | Codex、Claude Code、HermesをAdapterで扱う | `adapters.ts`、公式Manifest、`/connectors/config` | 本番CompositionでManifest登録・設定生成・Hook relay契約 | コード完成。実Client確認は未実施 |
| 2 | UIと外部連携で同じRoom認可を使う | 既存Core09 `ExternalAppIngress` とMCP Context | Formal Ingress接続 | コード完成。live未実施 |
| 3 | 外部AI→Samurai方向だけ | MCP Server / Formal Ingress | 境界コード確認 | focused確認 |
| 4 | macOS、Windows、Linux | `adapters.ts` のOS別設定 | 3OS設定Fixture | コード完成。実Client確認は未実施 |
| 5 | OAuth Authorization Code + PKCE | `oauth.ts` / `http.ts` | PKCE・失効・Callback・Resource audience・Protected Resource Metadata | コード完成。browser実機は未実施 |
| 6 | 第三者Connector Manifest | `connectors.ts`、`connector-sdk.ts`、`sample-connector.ts` | Manifest・Installation・Sample Connector・Contract Test Kit | コード完成。本番Sample未接続 |
| 7 | Project→Room Binding | `room-binding.ts` | version競合・再開始境界 | コード完成。live未実施 |
| 8 | 固定Context Snapshot | `context-snapshot.ts` / server Composition | 1,500 token上限・実Query接続 | コード完成。live未実施 |
| 9 | Knowledge、Skill、Artifact、Collection、ActivityのQuery | `mcp.ts` / Runtime Port / Domain Query | 個別Schema・共有Ingress・Room／Query条件付きCursor・Activity ID指定 | コード完成。大量データlive未実施 |
| 10 | 構造化Activity回収 | `activity.ts` + Formal Ingress | payload競合・dedupe | コード完成。Hook実接続未実施 |
| 11 | 全文保存は標準無効 | `capture.ts` / server Composition / 本人用HTTP境界 | 伏字・AES-GCM・Quota・Retention Worker・期限削除・分割Export・個別削除 | コード完成。本番期限削除live未実施 |
| 12 | 書込みと重大操作承認 | `approval.ts` + MCP Tool | 実在Catalog Operation・hash・CAS | コード完成。live保存未実施 |
| 13 | 共有設定と個人Grantを分離 | `contracts.ts` + Store | Grant失効・現在Installation選択 | コード完成。再導入live未実施 |
| 14 | Hosted / Self-hostで契約共通 | OAuth/MCP契約 | 同一コード契約 | コード完成。両運用live未実施 |
| 15 | 再接続、bounded retry、二重保存防止 | `activity.ts` / adapters | idempotency・再送境界 | コード完成。再接続live未実施 |
| 16 | OAuth認可と承認の最小Web境界 | `http.ts` | 302 Callback・本人確認・拒否・Connector導入・Capture本人操作 | コード完成。browser実機未実施 |
| 17 | `pnpm server:05:verify` | `scripts/verify-server-05.mjs` | 段階Report | コード完成判定。C31実機Matrixは未実施 |

## C01〜C31 修正台帳

「focused確認」は自動テスト・静的検査で確認できた範囲だけを指す。実Client、実Account、実OS、Hosted／Self-hostの確認は、証拠Matrixがそろうまで未完了とする。

| ID | 修正対象 | 実装場所 | 自動確認 | 現在の判定 |
| --- | --- | --- | --- | --- |
| C01 | 実Clientの導入経路 | Connector Registry、`adapters.ts`、Server Composition、`/connectors/*` | 公式Manifestの起動時登録、Workspace導入、設定取得、OAuth discovery | コード完成。実Client確認は未実施 |
| C02 | Adapterを実設定・Hookへ接続 | `adapters.ts`、明示relay command、Connector Version固定、`/connector/activity`、`/connector/capture` | 3Client Config／Hook正規化・Activity/Capture入口。relay command未設定時は設定不足を返す | コード完成。実Client Hook送信は未実施 |
| C03 | Project参照の保持 | Adapter URL、MCP Transport Context、Room Binding | Project／Session不一致拒否 | コード完成。実Client確認は未実施 |
| C04 | OAuth本人を実ログインSessionで確認 | `external-integration.ts` のBrowser Session Port | 開発固定Accountを本番既定から除外 | コード完成。browser実機は未実施 |
| C05 | OAuth承認とCode保存を一体化 | `oauth.ts`、Integration Store atomic | OAuth focused test | focused確認 |
| C06 | MCP入出力Schema | `mcp.ts`（Ajv）、Runtime MCP Port | 固定`item/items`結果Envelope、保存用Version、入力・出力Schema test | focused確認 |
| C07 | MCPからStore直接参照を除去 | Runtime MCP Port、`resource.version.get` | 境界静的検査・Ingress test | focused確認 |
| C08 | 保存Transaction内のVersion確認 | Artifact／Collection／Knowledge／Skill Repository、Runtime Port | stale Version・削除・転送 focused test | コード完成。live未実施 |
| C09 | Cancel／Timeoutの停止 | MCP Request Control、Formal Ingress | timeout／cancel test | focused確認 |
| C10 | 必須書込みToolを公開 | Domain Operation Catalog、Server mutation list | 必須操作Coverage・Catalog／MCP contract test | コード完成。実Client保存未実施 |
| C11 | 範囲外Automation操作の非公開化 | Published mutation list、Catalog source、Migration 024 | 公開Tool一覧・同時Connector Install検査 | focused確認 |
| C12 | Contextを正本の実データから作る | `workspace.context.get`、Runtime Context Snapshot Source、Room認可Service | Workspace名・Room目的・作業目標・ルール・現在の許可／禁止操作のFormal Query test | コード完成。実Client Snapshot未実施 |
| C13 | Context削減順序 | `context-snapshot.ts` | 1,500 token／優先順 test | focused確認 |
| C14 | 最終本文Hash | `context-snapshot.ts` | 本文・Version・省略情報hash test | focused確認 |
| C15 | 標準Room初回適用 | Room Binding Service | 初回Binding test | コード完成。実Client確認は未実施 |
| C16 | 承認期限の全状態再確認 | `approval.ts` | pending／approved期限 test | focused確認 |
| C17 | 承認再利用の完全比較 | `approval.ts` | Account／Room／Input／Version test | focused確認 |
| C18 | 承認実行後の状態保存 | `approval.ts`、Audit | executing／outcome_unknown recovery test | focused確認 |
| C19 | 承認画面の拒否・影響表示 | `http.ts`、OAuth拒否callback | HTTP route test | コード完成。browser実機未実施 |
| C20 | Captureの本番入口 | `/connector/capture`、MCP Capture Hook、Hook relay | 認可・Binding・dedupe・本人用Export/Delete test | 部分実装。3Client コード完成。Hook実接続未実施 |
| C21 | JSON・自由文のSecret除去 | `capture.ts` | structured／text redaction test | focused確認 |
| C22 | Capture Quotaの原子性 | Integration Store reservation | Memory／SQLiteの並行保存 test、予約行の競合retry | focused確認 |
| C23 | Retention削除のAudit | `capture.ts`、Audit | retention audit test | focused確認 |
| C24 | `not_run`を保持 | `activity.ts`、MCP mapping | verification mapping test | focused確認 |
| C25 | ConnectorのWorkspace分離 | Connector Registry、OAuth DCR | cross-workspace negative test | focused確認 |
| C26 | SemVer互換性 | `connectors.ts`（`semver`） | incompatible version test | focused確認 |
| C27 | focused／integration／liveの分離 | Server 05 Verifier | report category test | focused確認 |
| C28 | 未完成の非0終了 | Server 05 Verifier | `INCOMPLETE` exit 2 | focused確認 |
| C29 | Evidenceから全要件を判定 | Server 05 Verifier | source hash／Matrix test | focused確認 |
| C30 | 未追跡ファイルを含む差分検査 | Server 05 Verifier | `git diff --no-index --check` | focused確認 |
| C31 | 実Client・3OS・Hosted／Self-host証拠 | `live-evidence.json` Matrix | 実行日時・source hash検査 | 未実施。コード完成判定から分離 |

## 既存契約との接続

- 外部入力は既存の `ExternalAppIngress` へ渡す。
- MCPから `WorkspaceStore`、ファイル、DBを直接呼ばない。
- Room ID、Account、Roleは外部入力を信頼せず、Connectionと現在の認可から解決する。
- Sessionは外部Session参照としてだけ保存し、Workspaceの必須親にしない。
- 全文記録はActivityと別の期限付き暗号化記録にし、Knowledgeへ自動変換しない。

## 未検証の扱い

実Credentialを使うOAuth、実Codex／Claude Code／Hermes、Hosted／Self-hostの実DB、3OSの実端末は、focused verifierの成功とは別に記録する。取得できない情報を取得済みとは表示しない。
