# Core07: Activity・利用履歴・Workspace Job基盤

状態: **完了**
開始日: 2026-08-09

## 目的

Core07は、作業の構造化証拠と、その証拠を後から安全に処理する実行台だけを追加する。

```text
Activity / Resource usage → Workspace Job → ActivityProcessorPort → 保存済み結果
```

このCoreで自動学習、Memory・Knowledge・Skillの生成、外部アプリ接続、UIは作らない。

## 停止地点

- ActivityはRoom、Principal、source、任意SessionRef、Backend Run、Domain Operationを追跡する。
- Resourceの参照・読込・適用・変更・差し戻しを別レコードで保存する。
- `activity_processing` Jobは永続化、lease、heartbeat、retry、cancel、再起動回復、attempt履歴を持つ。
- Processorは読み取り専用で、結果をJob attemptへ保存する。
- Activity保存・Job実行のどちらもMemory、Knowledge、Skillを書き換えない。

## 実装結果

- Schema、状態遷移、error code、`ActivityIngestPort`、`ActivityProcessorPort`を追加した。
- Migration 012/013、SQLite Repository、Room別Query、Workspace Backup/Restoreを追加した。
- Sessionあり・なしのHost実行へActivity lifecycleを接続した。
- 明示enqueueだけを処理するFake Processor Job Workerを追加した。
- `pnpm core:07:verify`で境界検査、Core05〜07回帰、typecheck、diff checkを確認した。

## 完了判定

- Sessionの有無にかかわらずActivityを保存・検索できる。
- Room越境の読取・記録が拒否される。
- Jobの結果はattemptごとに残り、過去の結果を上書きしない。
- Activityの保存だけでJobや学習は始まらない。
- Backup・Restoreと`pnpm core:07:verify`を最新差分で確認済み。

## 明示的な未実装

自動学習、Memory生成、経験則化、Skill化、本番Processor、MCP/API/Plugin adapter、HTTP API、UI、Relay・購読・Event BusはCore07の対象外である。
