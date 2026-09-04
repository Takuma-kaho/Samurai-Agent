# Samurai Workspace Server Self-host

この構成1つが、1つのSelf-host Serverです。1つのServerで複数Workspaceを運用できます。`SAMURAI_SELF_HOST_WORKSPACE_ID`と`SAMURAI_SELF_HOST_BOOTSTRAP_MODE`は初回Workspaceの作成方法を指定する任意の設定で、追加Workspaceは通常のWorkspace APIから作成します。

1. `cp .env.example .env`
2. repo外の安全な場所で`pnpm server:02:account -- --output ./owner-identity.json`を実行する
3. 出力の`account_id`と`public_key`だけを`.env`へ入れる。private keyは`.env`、Git、Bundleへ入れない
4. `.env`のPostgreSQL passwordと`SAMURAI_INVITATION_TOKEN_SECRET`を32文字以上のランダム値へ置き換える。外部公開する場合は、TLSのURLを`SAMURAI_PUBLIC_BASE_URL`にも設定する
5. Samurai Nativeを使う場合だけ、利用するproviderのAPIキーと`SAMURAI_LLM_MODEL`（`provider/model`形式）、必要なら`SAMURAI_LLM_FALLBACKS`（カンマ区切り）を`.env`へ設定する。APIキーを設定しない場合は`provider_not_configured`として実行を閉じる
6. `docker compose up -d --build`

通常のbackupは`./scripts/backup.sh`、更新は`./scripts/update.sh`を使う。復旧先は新しい構成で`SAMURAI_SELF_HOST_BOOTSTRAP_MODE=empty`にしてから、`./scripts/restore.sh <bundle-dir> <workspace-id>`を実行する。

Bundleは秘密鍵・password・tokenを含まない。復旧が確認できるまで、移転元はread-onlyのままにする。providerのAPIキーはServerコンテナだけに渡し、migrationコンテナには渡さない。
