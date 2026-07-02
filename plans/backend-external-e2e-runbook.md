# Backend External E2E Runbook

最終更新: 2026-06-28

このメモは、`backend-current-state-oss-comparison.md` と `backend-architecture-completion-ledger.md` で運用検証として残している実外部backend / 実sandbox / 実外部channel E2Eの実行条件を固定する。

## 目的

- 実外部CLI backendの `run -> native session id -> resume` を確認する。
- 実Docker / 実SSH / 実remote daemon の availability と workspace sync 境界を確認する。
- 実Slack / Telegram / LINE / Email service credential を使う送受信境界を確認する。
- 認証、ネットワーク、provider quota、remote target、実メッセージ送受信に触れる検証を、暗黙に実行しない。

## 事前の非破壊チェック

以下は実CLI runを開始しない。

```bash
pnpm doctor
pnpm run backend:gateway:verify -- --json
pnpm run backend:channels:verify -- --json
pnpm run backend:external:verify -- --json
pnpm run sandbox:verify -- --json
```

確認すること。

- `doctor` の `sandbox-env` が Docker CLI/daemon、SSH、rsync、`long_e2e=manual_opt_in` を表示する。
- `backend:gateway:verify -- --json` が temp workspaceで期限切れGateway pairing/lockの dry-run preview と apply repair を確認する。
- `backend:channels:verify -- --json` で Slack / Telegram / LINE / Email / Webhook の inbound verification、send transport、provider webhook verification、IMAP/SMTP設定状態が secret値なしで表示される。
- `backend:external:verify -- --json` で対象backendが `configured=true` / `connection_state=ready` になる。
- `sandbox:verify -- --json` で `none/docker/ssh/remote` の executor availability が確認できる。
- 未設定backendは `unconfigured` として表示され、release gateの失敗扱いにしない。

## 実外部CLI run

実行条件。

- 人間が、認証済み外部CLI、ネットワーク利用、provider quota消費、prompt送信を明示承認している。
- `--confirm-external-effects` を付ける。付けない場合、verifierは実runを `external_effects_confirmation_required` で止める。
- 実行対象backendを1つに絞る。
- 入力promptは検証用の短文にする。
- 結果は `backend_session_id` と resume の terminal event で判定する。

Codex backendの例。

```bash
pnpm run backend:external:verify -- \
  --run \
  --confirm-external-effects \
  --resume \
  --require-configured \
  --backend codex \
  --timeout-ms 180000 \
  --input "Samurai Agent external backend E2E probe. Reply with one short sentence."
```

合格条件。

- `run.status=passed`
- `run.backend_session_id` が空でない
- `resume.status=passed`
- run / resume とも `terminal_event=run_completed`

失敗時の扱い。

- `run_failed` は release gateとして失敗扱いにする。
- 認証、network、quota、CLI unavailable は環境依存として記録し、実装gapとは分ける。
- raw provider outputやsecret-like textをledgerに貼らない。

## 実外部チャネル E2E

実行条件。

- 人間が、本物のSlack / Telegram / LINE / Email provider credential、実メッセージ送受信、provider quota消費を明示承認している。
- 先に `pnpm run backend:channels:verify -- --json` で対象channelの readiness を確認する。
- 実送信は `SAMURAI_EXTERNAL_SEND_DISPATCH=true` と backend approval flow を通す。
- provider webhook / IMAP poll / outbound dispatch の結果は Gateway inbound、External Send diagnostics、Run History で確認する。

判定観点。

- inbound webhook / IMAP / message endpoint が Gateway pairing / routing / boundary / backend run pathへ入る。
- Slack / Telegram / LINE / Email SMTP の outbound dispatch が success/failure を保存し、secret-like valueをresponseやmetadataに出さない。
- Postmark / Mailgun / SendGrid の provider webhook verification が設定時に不正requestを401で拒否する。
- 実サービス側の失敗は error code と redacted diagnostics で記録し、実装gapと環境/credential問題を分ける。

## 実sandbox / remote E2E

実行条件。

- Docker backendを検証する場合は Docker CLI と daemon が使える。
- SSH / remote backendを検証する場合は `ssh`, `rsync`, `ssh_target` / `remote_target`, `remote_workspace_root` が用意されている。
- Docker / SSH / remote backendで `--run` する場合は `--confirm-external-effects` を付ける。付けない場合、verifierは実runを `external_effects_confirmation_required` で止める。
- remote target は検証用workspaceに限定し、既存の重要ディレクトリを使わない。

非外部のhost sandbox probe。

```bash
pnpm run sandbox:verify -- --backend none --run --json
```

Docker backendの例。

```bash
pnpm run sandbox:verify -- \
  --backend docker \
  --run \
  --confirm-external-effects \
  --docker-image samurai-agent-sandbox:latest
```

SSH backendの例。

```bash
pnpm run sandbox:verify -- \
  --backend ssh \
  --run \
  --confirm-external-effects \
  --ssh-target user@example-host \
  --remote-workspace-root /tmp/samurai-agent-sandbox
```

判定観点。

- workspace accessが `none/read/write` の設定通りに分離される。
- Docker bind mount / Docker container copy / SSH rsync / remote local transport の workspace sync result が保存される。
- SecretRef は env/file material と summaryが分離され、stdout/stderrやAPI responseにraw secretが出ない。
- sandbox lifecycle と workspace sync履歴が Gateway diagnostics / API / doctor で追える。

## 記録先

完了または失敗したら以下へ記録する。

- `plans/backend-architecture-completion-ledger.md`
- `plans/backend-current-state-oss-comparison.md`

記録する項目。

- 実行日時
- 実行コマンド
- backend / sandbox 種別
- pass / fail / blocked
- terminal event / error code
- 環境依存理由
- secret redaction確認の有無
