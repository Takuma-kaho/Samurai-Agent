# Workspace Server 04 セルフレビュー

確認日: 2026-08-16

このレビューは、実装者自身が「通ったテスト」ではなく、境界を破る経路が残っていないかを確認した記録である。実DBでしか確かめられない項目は、静的検証と区別する。

## 設計不変条件の確認

| 確認項目 | 確認結果 |
| --- | --- |
| Workspaceをroot Roomとして扱わない | `scope_kind`を`workspace`/`room`で明示し、Workspace scopeには`room_id`を禁止している。 |
| Room間の自動共有をしない | review snapshot、検索、Evidence、Resource Useは現在Roomだけを対象にし、RLSもRoom単位で確認する。 |
| 外部Backendへ保存権限を渡さない | Review PortはRoom限定snapshotとmutation resultだけを交換する。DB、file、任意HTTPのCapabilityは渡さない。 |
| 中間経過を自動学習しない | Activity候補判定を決定的な関数に限定し、未検証完了・cancelled・未解決失敗はJob化しない。 |
| フラグで取消・未解決を救済しない | `explicitRemember`、訂正、利用結果があっても、`cancelled`または`unresolved`は候補に戻さない。訂正は別の解決済みActivityとして残す。 |
| 人の編集を上書きしない | Resourceは版番号で更新し、fixed時はAI update/evidence appendを拒否する。競合は別Resourceとして残す。 |
| AI生成を人の確定内容と混同しない | AIが作るResourceには`provisional`、confidence、Job/Attempt、Evidenceを残す。人の通常編集・固定・明示的な移送は`human_edit` Evidenceを残して`active`へ進める。 |
| Resourceを削除しない | ResourceのRLSはSELECT/INSERT/UPDATEだけにし、削除は許可しない。archive/restoreは新しい版として残る。 |
| 根拠履歴を後から改ざんしない | Version、Evidence、Link、利用結果はRLS上もSELECT/INSERTだけにし、更新・削除を許可しない。利用結果の重複記録は409で拒否する。 |
| Room間操作は人だけが行う | Review mutationにCopy/Move/Promoteは存在せず、専用Service/HTTP操作のみが実行できる。 |
| 実値の秘密情報を保存しない | payload、本文、model結果、SecretRefを検査し、Bundleには`secret_ref`を出力しない。HTTP応答でも除外する。 |

## 失敗・並行実行の確認

- queued reviewは同じRoom・groupごとに一つへまとめる。高優先度の人の訂正は既存Jobもhighへ上げる。
- Engine未設定、無効、上限到達はJobを`blocked`にし、モデル実行回数を消費しない。人が有効な設定へ変えると同じJobをqueueへ戻す。
- Review中は20秒ごとにleaseをheartbeatする。leaseを失った場合は結果を保存せず、RLSと版番号を再確認する。
- retry上限に達したlease切れは、Jobだけでなくrunning Attemptも`failed`として閉じる。
- Copy/Move/Promote、固定、archive、通常編集はすべて期待版番号を使う。古い画面の操作は409で止める。
- 上限はWorkspaceとRoomの両方で実行前に予約する。実行者は設定そのものを更新できず、予約・精算・設定行ロックだけを限定SQL関数で行う。
- timeout、Runner終了、Backend一時失敗はretryableとして閉じる。Server終了時はDBを閉じる前にその失敗記録を待ち、Runnerは次回実行時刻を保持する。通知失敗だけでretryを失わない。
- Useの`unknown`は上書きせず、後続の確定Useが`supersedes_use_id`で訂正する。EvidenceとUseは関連ActivityのRoom権限も再確認してから読む。

## Backup/Restoreの確認

- Bundle v3へActivity、Resource、Version、Evidence、Link、Settings、Job、Attempt、Useを含める。
- SecretRefと操作ledgerは移植しない。running Jobはqueueへ、running Attemptは失敗履歴へ変換する。
- Restore前にRoom境界、Resourceの現行版と連続版、Evidence/Useの参照先、Settings IDとscopeの対応を検証する。

## 実装上の意図的な境界

- `engine_id`はBackend cassetteの識別子であり、特定の外部AIサービスをこの変更で勝手に接続していない。Hostが対応するReview Portを注入してWorkerを動かす。
- Artifact/CollectionはActivityの出所にできるが、自動学習がそれ自体を変更する経路はない。
- Native Appは専用IPCだけを使い、rendererがServer URL、署名鍵、任意payloadを渡す経路はない。

## 検証状態

- 2026-08-16に`pnpm server:04:verify`を実行し、architecture boundary、4つの型検査、probe型検査、Native App build、focused test **7 files / 29 tests**、追跡済み・未追跡の差分空白検査は通過した。
- 同じ実行はDocker不在（`spawnSync docker ENOENT`）により実PostgreSQL probeの開始前で非0終了した。このため下記の実DB項目は未検証のままである。
- 実PostgreSQLのMigration/RLS/追記履歴の更新拒否/lease/Restore probeは、検証用DBまたはDocker PostgreSQLが必要である。この環境でDockerが使えない場合は未検証として残す。
