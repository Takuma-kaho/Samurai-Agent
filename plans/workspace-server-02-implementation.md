# Workspace Server 02 実装台帳

## 目的

Self-hostとHostedで同じWorkspace仕様を使い、HostedではPostgreSQL RLSを最後の分離境界にする。

- Self-host：1 Workspace＝1 Server＝専用PostgreSQL
- Hosted：複数Workspace＝共有PostgreSQL
- SQLite：旧Workspaceをread-onlyで移す時だけ使う

既存のSQLite Core APIとChat／Session APIをこのServerへ暗黙に混ぜない。`Workspace Server 02`はPostgreSQL専用の新しいServer entryである。

## 実装したもの

### フェーズ1：PostgreSQL・分離・Bundle

- `packages/workspace-server/`にPostgreSQL schema、migration、runtime role確認を追加した
- Workspace所有行は`workspace_id`を持つ。records、files、history、jobs、operations、invitations、transfers、bundlesへRLSを設定した
- runtime roleはsuperuser、BYPASSRLS、RLS table owner、またはそれらのroleへ切替可能なmemberなら起動を拒否する。権限は必要なtable・functionだけに明示付与し、将来のtableへ自動付与しない
- request transactionは`account_id`と`workspace_id`をPostgreSQLのlocal settingに入れる。意図的にWorkspace条件を外したRLS probeも用意した
- Knowledgeなどの本体は`workspaces/<workspace_id>/files/`へ残し、DB metadataとrenameを復旧可能なtransactionで結ぶ。起動時と同じ操作の再送時に中断したrenameを回復し、回復不能ならそのWorkspaceをread-onlyへ隔離する
- Bundle v3はJSON/JSONL、ファイル、record count、SHA-256を持つ。通常backup中に更新が入った場合はDBとfileの再照合を行い、混ざった版を出力せず、安定しなければ失敗として再実行を求める。Accountのdisabled状態をactiveへ変えず、移転先に既にあるAccountの本人情報も変更しない。DB image、private key、password、token、credential形式の値・ファイルは含めない
- 旧`workspace.sqlite`はprivate copyを`PRAGMA query_only=ON`で読む。DB本体とWAL／journal sidecarの移行前後hashが変われば失敗にし、元データを変更しない
- SQLite旧形式には公開鍵付きAccountがないため、移行先で有効にするのは確認済みの移行実行者だけにする。旧メンバーは勝手に復元せず、件数を移行reportへ残して改めて招待する。通常のBundle v3は権限・履歴をそのまま保持する

### フェーズ2：共有・認証・Realtime

- Account IDはEd25519公開鍵から決める。同じ本人がHostedとSelf-hostで同じAccountを登録できる
- Self-hostは初期AccountをローカルDBへ登録する。外部運営サービスへの依存なしで署名を確認できる
- Owner、Admin、Member、Guestと招待期限・取消を実装した。Ownerの追加・降格・招待はOwnerだけが行え、招待tokenはServer固有secret付きhashとして保存する。公開Serverでは固定した`SAMURAI_PUBLIC_BASE_URL`からNative App招待リンクを発行し、リンクを開いた本人が確認して参加する
- Room権限は一覧、取得、検索、history、Job、file metadata、Socket.IOの再同期にDB RLSで適用する
- Socket.IOはWorkspace接続後もRoom channelへ明示購読が必要で、更新通知はRoom channelだけへ送る。権限失効時はWorkspace接続を切断またはRoom channelから外す
- version付きrecord/file/job更新は古い状態を409で拒否する。書込みは`x-samurai-operation-id`を署名対象に含め、同じ操作IDは同じ結果だけを返す

### フェーズ3：提供・移転・Native App

- `docker/self-host/`にServer、PostgreSQL、file volume、runtime role、backup、restore、updateを置いた
- 新規Self-hostは`SAMURAI_SELF_HOST_BOOTSTRAP_MODE=create`で初期Workspaceを作る。復旧先は`empty`で起動してBundleを仮取り込みする
- 移転は、sourceをread-only、Bundle export、target import＋count/hash確認、active化、source completeまたはrollbackの順にする。同じ移転要求の再送は、完成済みBundleを再利用し、別のBundleで上書きしない
- Desktopは`サーバーURL＋Workspace ID＋Account`の接続先一覧をローカルへ0600で保存する。設定画面から接続先を追加・選択できる。private keyは保存せず、OS keychain等への参照だけを保存できる。選択中のWorkspace Server接続は既存Chat/Core APIのURLを勝手に置き換えない

## 実行入口

| 用途 | コマンド |
| --- | --- |
| 新Serverを起動 | `pnpm server:02:dev` |
| Account鍵を作る | `pnpm server:02:account -- --output ./owner-identity.json` |
| Bundle export/import | `pnpm --filter @samurai-agent/server run workspace-server:cli -- <command>` |
| 最終確認 | `pnpm server:02:verify` |

`owner-identity.json`のprivate keyは安全な保存先へ移し、`.env`、Workspace、Bundle、Gitへ入れない。

Bundle CLIの引数は次のとおり。

```text
bundle-export <bundle-dir>
bundle-verify <bundle-dir>
bundle-import <bundle-dir> <target-workspace-id>
sqlite-bundle <legacy-workspace-root> <bundle-dir> <workspace-id>
sqlite-import <legacy-workspace-root> <bundle-dir> <target-workspace-id>
files-recover [<workspace-id>]
```

`files-recover`は、停止中のファイル名変更だけを完了させる復旧操作である。Self-hostではWorkspace IDを指定しない。Hostedでは対象Workspaceを1つだけ指定し、通常のOwner/Admin Accountとして実行する。

## 検証

`server:02:verify`は次を確認する。

- Workspace Server、HTTP Server、Desktop接続先のtypecheck、Native App接続先UIのWeb build
- Account署名、Self-host/Hosted設定、schemaのRLS定義、Room realtime分離、SQLite read-only migration、credential除外のfocused test
- `git diff --check`

次の接続情報6つと明示確認値をすべて設定すると、HostedとSelf-hostの実PostgreSQLに対し、record・file・event・Job・Room履歴で、Workspace条件なしのSELECT、他Workspaceの明示SELECT、他WorkspaceへのINSERTがRLSで拒否されることも確認する。

このprobeは一時的な検証Workspaceを作成・削除するため、本番DBではなく検証専用PostgreSQLへだけ設定する。

```text
SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_URL
SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_ADMIN_URL
SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_RUNTIME_ROLE
SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_URL
SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_ADMIN_URL
SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_RUNTIME_ROLE
SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE=yes
```

ローカルにPostgreSQLまたはDockerがない場合、実PostgreSQL probeだけは未実行として明示される。単体テストの成功を実運用DBの確認と混同しない。

## 今回含めないもの

- 決済・月額課金
- SQLiteを通常保存に使う新Server経路
- 1つのSelf-host Serverで複数Workspaceを扱う機能
- Google Docs型の自動同時編集
- Redisや複数Serverによる大規模分散
- Knowledge販売・世界配布
