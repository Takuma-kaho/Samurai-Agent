# PR #9 CI・セキュリティ修正プラン

## 0. 目的

PR #9 `Electron Desktop ShellとCore境界を実装` で失敗している次の2チェックを、判定の緩和や一時回避なしで通過させる。

- `release-readiness`: Mobile Gateway追加後のテスト期待値更新漏れを直す。
- `security-audit`: サポート終了済みの `electron@31.7.7` を、サポート中の安定版へ更新する。

この修正では、Gatewayの実装仕様、Desktop ShellとCoreの責務境界、公開API、UI文言は変更しない。

## 1. 確定している原因

| チェック | 直接原因 | 修正方針 |
| --- | --- | --- |
| `release-readiness` | `gatewayChannels` には `mobile` が追加済みだが、`apps/server/src/index.test.ts` のpairing/routing policy期待値には未追加 | 2つの期待配列へ、正本と同じ順序で `mobile` を追加する |
| `security-audit` | `apps/desktop` が高重大度脆弱性を含む `electron@31.7.7` を使用 | `electron` を `^43.1.0` へ更新し、lockfileをpnpm 9.15.0で再生成する |

Electronは2026年7月10日時点で最新3メジャーがサポート対象で、最新安定版は43.1.0。監査を通すだけの古い39系には留めない。

参照:

- https://releases.electronjs.org/
- https://www.electronjs.org/docs/latest/tutorial/electron-timelines

## 2. 実装修正

### 2.1 Gatewayテストを現行仕様へ同期する

`apps/server/src/index.test.ts` の `exposes gateway pairing approval and inbound routing diagnostics` で、次の両方の期待配列を更新する。

- `pairingPolicies.map((policy) => policy.channel)`
- `routingPolicies.map((policy) => policy.channel)`

どちらも `email` と `webhook` の間へ `mobile` を追加し、次の順序を期待する。

```text
telegram, slack, line, email, mobile, webhook, local_cli, cron
```

実装側の `gatewayChannels` やMobile Gateway処理は変更しない。テストのために `mobile` を除外する処理も追加しない。

### 2.2 Electronをサポート中の安定版へ更新する

`apps/desktop/package.json` のdevDependencyを `electron: ^43.1.0` に更新し、`pnpm-lock.yaml` をpnpm 9.15.0で同期する。

更新後に確認すること。

- lockfile上のDesktop依存がElectron 43.1.0以上へ解決されている。
- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` を維持する。
- 外部windowとnavigationを制限する既存処理を維持する。
- 型または実動作の非互換が出た場合だけ `apps/desktop` 内をElectron 43 APIへ合わせる。安全設定の無効化や監査除外では回避しない。

## 3. 検証手順

次の順序で実施し、途中で失敗した場合はその原因を直してから次へ進む。

1. 対象テスト

   ```sh
   CI=true pnpm exec vitest run apps/server/src/index.test.ts -t "exposes gateway pairing approval and inbound routing diagnostics" --pool=forks --reporter=verbose
   ```

2. Desktopの型・build・静的アーキテクチャ検証

   ```sh
   pnpm --filter @samurai-agent/desktop run typecheck
   pnpm run desktop:build
   pnpm run desktop:verify
   pnpm run desktop:audit
   ```

3. 全体検証

   ```sh
   CI=true pnpm test
   CI=true pnpm run backend:release:verify -- --json
   pnpm audit --audit-level=high
   git diff --check
   ```

4. macOS上のDesktop手動スモーク確認

   - Electron windowで既存Web UIが開く。
   - Tray、Global Shortcut、Quick Askが動く。
   - Session / Artifact / RunのDeep Linkが開く。
   - 通知とClient Event Queueの処理が動く。
   - AppShotがTemporary Contextとして扱われる。
   - ConsoleにElectron更新由来の未処理例外が出ない。

5. 修正を日本語コミットでPR #9へpushし、`release-readiness` と `security-audit` を再実行する。

   コミットメッセージ案: `CIとElectron脆弱性を修正`

## 4. 完了条件

- Mobileを含むpairing/routing policyテストが成功する。
- 全テストが成功し、`release-readiness` の全自動ゲートが `passed` になる。
- `pnpm audit --audit-level=high` がexit code 0になる。
- Electron 43.1.0以上でDesktop buildと100点の静的監査が成功する。
- Desktopの主要導線をmacOSで手動確認できる。
- `manual_opt_in_required` の外部サービス試験は、正常な手動ゲートとして維持される。
- CI設定の緩和、脆弱性のignore、テスト削除、Gateway仕様の後退がない。

## 5. 想定する差分

必須変更は次の3ファイルに限定する。

- `apps/server/src/index.test.ts`
- `apps/desktop/package.json`
- `pnpm-lock.yaml`

Electron 43との実互換エラーが確認された場合のみ、必要最小限の `apps/desktop/src/` 修正を追加する。目的外のリファクタやUI変更は行わない。
