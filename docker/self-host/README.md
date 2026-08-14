# Samurai Workspace Server Self-host

このフォルダ1つが、1つのWorkspace専用Serverです。複数WorkspaceをSelf-hostする時は、Workspaceごとにこの構成を別ディレクトリ・別`.env`で起動します。

1. `cp .env.example .env`
2. repo外の安全な場所で`pnpm server:02:account -- --output ./owner-identity.json`を実行する
3. 出力の`account_id`と`public_key`だけを`.env`へ入れる。private keyは`.env`、Git、Bundleへ入れない
4. `.env`のPostgreSQL passwordと`SAMURAI_INVITATION_TOKEN_SECRET`を32文字以上のランダム値へ置き換える。外部公開する場合は、TLSのURLを`SAMURAI_PUBLIC_BASE_URL`にも設定する
5. `docker compose up -d --build`

通常のbackupは`./scripts/backup.sh`、更新は`./scripts/update.sh`を使う。復旧先は新しい構成で`SAMURAI_SELF_HOST_BOOTSTRAP_MODE=empty`にしてから、`./scripts/restore.sh <bundle-dir> <workspace-id>`を実行する。

Bundleは秘密鍵・password・tokenを含まない。復旧が確認できるまで、移転元はread-onlyのままにする。
