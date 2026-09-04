# Workspace-first・Organization再設計 実装・検証報告

作成日: 2026-09-02

更新日: 2026-09-04

対象Plan: `plans/workspace-first-organization-realignment-master-plan.md`

## 今回の完了対象

- WorkspaceをOrganizationから独立させる再設計、Server間移転、Desktop接続UI、Self-host設定を実装対象とした。
- ドパガキくんの指定により「学習結果を次会話へ再利用」は今回の完了判定から外した。
- Hosted環境との実移転は、Hosted環境未用意のため今回の対象外とした。

## 実装した範囲

- WorkspaceをOrganizationなしで作成・招待・利用でき、Organizationは任意の管理機能としてattach/detach/deleteできるようにした。
- Organization MembershipだけではWorkspace本文を読めず、管理権限と内容閲覧権限を分離した。
- BundleからOrganization識別子・credential・絶対pathを除外し、通常RestoreをStandalone既定にした。
- `connection_id + workspace_id` をWorkspace targetにし、複数Serverの一覧、再認可、Server別offline表示、A→B移転後cutoverを実装した。
- Desktop設定画面でServer追加・切替、クリップボードからOS保護領域への鍵読み込み、本人情報の登録を実装した。Rendererに秘密鍵入力欄・受け渡しはない。
- GeminiのSSEを逐次`text_delta`として永続化・画面表示できるProvider経路を追加した。通信断、安全ブロック、空応答は成功扱いにしない。自動連打retryは行わず、120秒で明示的に失敗へ終端する。
- 実行可能Toolは`create_artifact`だけをProviderへ公開し、Tool実行はRoom権限確認後に正規のArtifact保存へ接続した。未対応Tool・Tool失敗はRun成功にしない。
- 保存済み`text_delta`の順序・重複を処理し、Run中からUIへ逐次表示する。Workspace/Room切替・停止・unmount時は古いpollingを止める。
- 左サイドナビゲーションを縦スクロール可能にした。
- 旧Organization必須DBをOrganization任意DBへ移行する互換Migrationと、旧形式のChat操作履歴を読める互換投影を追加した。
- Runtimeの完了記録は、同じ実行を二重保存せず、内容・主体が異なる衝突は明示的に失敗させる。callback失敗後は、Providerを再実行せず、保存済みRuntime結果だけを安全に再投影できるようにした。

## 実行済み検証

| 分類 | command / 条件 | 結果 |
| --- | --- | --- |
| 全体回帰 | `pnpm test` | 成功: 154 files / 844 tests |
| 全体型 | `pnpm typecheck` | 成功: 24 workspace projects |
| リリース統合 | `pnpm run backend:release:verify` | 成功（型、全体テスト、i18n、Web/Desktop build、Architecture、Doctorを含む） |
| Provider | focused Vitest | 成功: 39 tests（Gemini SSE、安全block、空応答、通信断、timeoutを含む） |
| Runtime終端互換 | focused Vitest | 成功: 10 tests（旧session-create履歴を含むcancel→投影→完了通知） |
| UI逐次表示 | focused Vitest | 成功: 50 tests |
| Web build | `pnpm --filter @samurai-agent/web run build` | 成功（bundle size warningのみ） |
| Desktop | `pnpm run desktop:verify` / `desktop:audit` / `desktop:build` | 成功: 14 checks / 24 of 24 / artifact verify成功 |
| Domain契約 | `pnpm run core:domain-contracts:verify` | 成功: 3 checks |
| PostgreSQL静的Migration | `pnpm run verify:postgres-migration:static` | 成功: legacy reference 0、API route 305（静的検査） |
| PostgreSQL runtime scope | `pnpm run verify:postgres-runtime-scope` | 成功: scanned 535、issue 0 |
| 書式・lint | `pnpm run format:check` | 成功: format 906、lint 787、issue 0 |
| 差分 | `git diff --check` | 成功 |

### 実PostgreSQL・二つの実Server検証

- このPCのDocker Desktopに、リポジトリ外の隔離Self-host Server A（`127.0.0.1:4317`）とB（`127.0.0.1:4318`）を用意した。検証DB・Storageは`~/.samurai-e2e`と専用Docker volumeにのみ置き、既存データ・リポジトリ・Git履歴は操作していない。volume削除もしていない。
- 旧v79のOrganization必須DBをv80〜v86へ実Migrationした。移行前はOrganization 2件、WorkspaceのOrganization紐付けあり、Room 1・Membership 2・Record 1・File 1・Event 1。移行後はOrganization 0件、Organization Membership 0件、WorkspaceのOrganization紐付けなしで、Room/Membership/Record/File/Eventは同数保持された。
- 現在のv87 MigrationをA/B両方の隔離PostgreSQLへ適用し、両Serverを最新コンテナで再起動後、health、PostgreSQL接続、RLS必須設定を確認した。
- この隔離環境にはmaintenance identityをあえて設定していないため、定期的な再投影workerはdisabledである。通常の直接保存は有効で、保存callbackが失敗した場合は成功応答にせず、同じ操作の再実行でProviderを動かさず保存だけ再試行する。運用環境で自動回復も使う場合は、別途maintenance identityを設定する。
- OrganizationなしのWorkspace、direct invite、revoke、Organization membershipと内容閲覧の分離、attach/detach/delete後の本文保持を実PostgreSQLで確認した。
- A→B移転で、Room、Chat session、Activity、Episode、Evidence、Knowledge、Skill本文と補助ファイル、Agent設定、Room権限、実ファイルを移転した。BでWorkspace active、General Room、Chat session、実ファイルhash一致を確認した。
- B再起動後も移転済みWorkspace、Chat、実ファイルhashを確認した。Aは削除せずarchive、transferはcommittedのまま保持された。
- 壊れたBundle・B側同ID衝突は拒否され、Bに残骸を作らず、Aをactiveのまま保つことを確認した。
- 旧Gemini検証Run 4件は、外部実行開始の可能性があるため`outcome_unknown`として終端した。安全な再実行扱いにはしていない。旧session-create履歴の投影がHTTP 500を返す不具合を発見し、互換変換とcancel→投影の回帰テストを追加した。更新後、終端済みRunのcancel APIは`outcome_unknown`を正常に返した。

### 実Electron・UI確認

- 実ElectronでWorkspace-firstの左ナビゲーションに多数のEnvironment行が存在すること、サイドバーCSSが`overflow-y: auto`であることを確認した。
- 接続設定画面には秘密鍵入力欄がなく、鍵読み込みの中間・成功・失敗状態はコンポーネントテストで確認した。
- 認証済みElectronでの手動スクロールと、A/B両方のidentityによる画面上の切替・cutover表示は未検証である。現在のElectronには検証identityが読み込まれていないため、成功扱いにしていない。

## 実Gemini検証の状態

- 隔離Aで実Geminiへの会話を1回実行し、完了Run、22件の保存済み`text_delta`、完了Activity/Evidenceを確認した。したがって「実AIとの会話・回答の逐次表示」の技術E2Eは確認済みである。
- Gemini APIへの不要なretryは実行していない。無料枠で429/5xxが起きた場合は、同じ検証を連打しない方針である。
- 実Artifact作成を依頼する残り1回は、既存の隔離テスト会話本文をGeminiへ送る操作であるため、外部送信の明示承認待ちで未実行である。拒否・失敗・429/5xx時の自動retryは行わない。
- よって「実AIが作ったArtifact保存」と「その実AI WorkspaceのA→B移転・B再起動後のArtifact確認」は未検証であり、成功扱いにしない。

## 残る手動1作業

ドパガキくんが「隔離E2Eの既存テスト会話本文をGeminiへ送って、成果物作成の残り1回を実行してよい」と明示承認する。その後、最大1回だけ実行し、成功時はA再起動→A→B移転→B再起動までを確認する。秘密鍵・APIキーはリポジトリ、報告書、チャット出力へ保存しない。

## Git操作

- `2dec491 実行結果保存の信頼性を改善` を `codex/native-app-productization` へcommitし、GitHubへpushした。
- PR #35を作成した。マージは実施していない。
- GitHub ActionsのCIは監視中。実Artifact作成を含む最後の隔離E2Eは、外部送信の明示承認後に実行する。
