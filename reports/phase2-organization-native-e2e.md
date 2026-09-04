# Phase 2 Organization / Native App 実装・E2E検証記録

実施日: 2026-08-31
対象branch: `codex/native-app-productization`
対象plan: `plans/native-app-productization-master-plan.md`

## 実装した範囲

- Organization、Member、Invitation、Organization配下Workspace、Workspace移動、Lifecycle、Bundle export/restore の公開Operation・Server API・PostgreSQL migrationを追加した。
- OrganizationのRoleだけではWorkspace/Room本文を読めない境界を維持した。
- Workspace移動は事前確認を永続化し、actor・Organization・Workspace・版番号・期限・一回消費をcommit時に検証する。
- 移動後も旧Organizationの`workspace_events`履歴を保持し、新規eventだけ現在のOrganizationと一致するようにした。
- 招待のtoken-only受諾、削除済みOrganizationの招待失効、招待受諾と削除のlock順、逆方向Workspace移動のlock順を補正した。
- Self-hostの固定Workspace IDをbootstrap互換に限定し、通常routing・recovery・workerを複数active Workspace列挙へ変更した。
- Bundleはserver-managed pathのみを使い、V3/V4 service経由でmanifest・integrity・対象Organizationを検証する。復元先は新規のserver生成Workspace IDを使う。
- Webのproduction entryをReactへ切替え、Organization / Workspace / Room / Chat / Evidence / Bundle管理を追加した。Electron preload/Mainにも同一の認可済みAPI bridgeを追加した。

## 実行済み検証

| 検証 | 結果 |
| --- | --- |
| `pnpm exec vitest run`（今回の関連17 files） | 81 tests 成功 |
| `pnpm --filter @samurai-agent/{workspace-server,server,web,desktop} run typecheck` | 成功 |
| `node scripts/generate-domain-operation-index.mjs --check` | 196 bindings を確認 |
| `pnpm verify:postgres-migration:static` | 成功（legacy reference 0） |
| `pnpm verify:postgres-runtime-scope` | 成功 |
| `pnpm verify:local-light` | 失敗なし。Docker / network / browser / Electron packagingは意図的に未検証 |
| `pnpm verify:ci-full` | 失敗なし。full typecheck / Web build / full test は成功。実PostgreSQLのみ未検証 |
| `pnpm --filter @samurai-agent/desktop run build` | 成功 |
| `pnpm desktop:verify` / `pnpm desktop:audit` | 成功（static score 24/24） |
| `git diff --check` | 成功 |

## Desktop起動修正（2026-09-01）

- ElectronのMain / preloadをViteでJavaScriptへbundleし、実行時にworkspace内のTypeScriptソースを直接読まないようにした。
- `pnpm desktop:dev`はAPI・Webのhealth確認後にDesktopを起動する単一の公式コマンドにした。`NODE_OPTIONS=--experimental-transform-types`は不要である。
- Desktopを通常終了した場合、子プロセスを終了する場合、API / Webがready前に失敗した場合を自動テストで確認した。ready前の失敗はtimeoutまで待たず、子プロセスの標準エラーを残して終了する。
- `node --test scripts/dev-orchestrator.test.mjs scripts/verify-desktop-artifact.test.mjs`は14件成功、`pnpm desktop:build`、`pnpm desktop:verify`、`pnpm desktop:audit`も成功した。
- この環境で`pnpm desktop:dev`を実行したところ、API設定の`samurai_server_mode_required`で約2秒後に安全に停止した。Electron起動前の停止であり、画像のraw TypeScript読込エラーは発生していない。

## 未検証（成功扱いにしないもの）

実PostgreSQLのHosted/Self-host migration、RLS allow/deny、worker recovery、Bundle rollbackは未実行である。以下の環境変数と、明示的な破壊的probe許可がこの環境にないためである。

- `SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_URL`
- `SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_ADMIN_URL`
- `SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_RUNTIME_ROLE`
- `SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_URL`
- `SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_ADMIN_URL`
- `SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_RUNTIME_ROLE`
- `SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE=yes`

実ブラウザ、実Electron、実Agent backend、実ファイルストレージを使うE2Eも未実行である。

Desktopの視覚E2Eも未実行である。現在の環境ではWorkspace Server設定が未完のため、APIが起動前に停止する。

## 手動E2Eチェックリスト

1. HostedでAccount AがOrganization、Workspace、Roomを作り、Chat・file・Evidenceを作成する。
2. Account BへOrganization招待を発行し、tokenだけで受諾できることを確認する。Workspace grant前はBがRoom本文・Chat・file・Evidenceを読めず、grant後だけ読めることを確認する。
3. 招待の再発行、期限延長、期限切れ、revoke、削除済みOrganizationのtoken受諾拒否を確認する。
4. Aが所有するWorkspaceを別Organizationへ移動し、Guest補完、移動後の権限、旧Organizationの履歴、Chat・file・Evidenceの保持を確認する。逆方向同時移動も失敗や待機から安全に復帰することを確認する。
5. Workspace archiveで書込みが拒否され、restore後に再開し、deleteの確認操作が必要なことを確認する。
6. Bundle export後、別Organizationへrestoreし、sourceと異なるWorkspace ID、manifest integrity、ファイル数・内容、失敗時のDB/filesystem残骸ゼロを確認する。
7. Self-hostを`SAMURAI_SELF_HOST_WORKSPACE_ID`なしで起動し、複数Organization / Workspaceを作成する。再起動後に全active Workspaceのfile / completion recoveryが走ることを確認する。
8. Electronで接続を追加し、Organization切替、Chat stop / retry / reconnect、権限剥奪時の再認証、Agent失敗とnetwork断からの復帰を確認する。

## 起動

有効なHostedまたはSelf-hostのWorkspace Server設定を用意したうえで、次の単一コマンドを実行する。API・Webが未起動ならDesktop側が起動し、準備完了後にElectronを開く。

```bash
pnpm desktop:dev
```

以前のDesktopが起動中なら、先に終了してから確認する。設定不足・別サービスによるport占有・legacy APIは、Desktopを開かず明示的に失敗する。

コミット・pushは実施していない。
