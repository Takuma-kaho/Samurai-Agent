# Workspace Server 04: Knowledge・学習ループ 実装台帳

## 目的

Workspace Server 03のRoom境界を前提に、再利用できるKnowledgeをActivityの確定証拠から育てる。これはChat全文を保存する機能でも、外部Agentを置き換えるUIでもない。

- Workspaceは所有・Backup・共通ルールの単位であり、Roomとして保存しない。
- RoomはKnowledge・権限・AI Contextの境界である。親子・兄弟RoomのKnowledgeは自動で混ぜない。
- Sessionは任意の出所情報だけであり、ActivityやKnowledgeの必須親にしない。
- Knowledge Hostは狭いreview snapshotとmutation planだけを使う。Backend cassetteへDB・ファイル・任意HTTP権限を渡さない。

## 確定した動作

### 学習対象

- 確認済みの完了、復旧済み失敗、人の訂正、明示Remember、正式な成果物完了、既存Knowledge利用後の結果だけをreview候補にする。
- 中間出力、未解決失敗、キャンセル、単発会話、閲覧・移動、推測だけの内容は候補にしない。
- 同じ作業群は一つのqueued reviewへまとめる。人の訂正はhigh priorityにする。
- `cancelled`または`unresolved`は、訂正・Remember・利用結果のフラグを後から付けても候補に戻さない。訂正したい事実は、解決済みの別Activityとして残す。

### Knowledgeの扱い

- `knowledge`、`memory`、`skill`、Workspaceの`workspace_rule`を独立tableで保存する。汎用Recordへ混ぜない。
- Resourceは版、Evidence、Link、利用結果を追記履歴として残す。削除ではなくアーカイブにする。
- 人の通常編集は強いEvidenceだが、AI固定ではない。固定にするとAIのupdate/evidence appendは拒否する。
- 競合は既存内容を消さず、別の`conflict` Resourceを作成してLinkで結ぶ。固定済みの既存内容も変更しない。
- Copyはsourceを残す独立Resource、Moveはsourceをarchiveして別Roomに独立Resourceを作る。PromoteはWorkspaceに新規Resourceを作る。Room間操作は自動reviewからは実行できない。

### Context・検索・費用

- 検索順はWorkspace絶対ルール → 現在Room → Workspace共通Knowledge。別Roomは検索対象外。
- Workspace設定はEngine/model/SecretRef/上限の標準値、Room設定は上書きである。使用量と上限はWorkspaceとRoomの両方を確認する。
- 実際の秘密値は保存しない。SecretRefはHTTP応答へ返さない。
- Engineが未設定、無効、上限到達ならJobは`blocked`として履歴を残す。この停止はモデル実行回数を消費せず、人が有効な設定へ変えると同じJobをqueueへ戻す。lease切れはAttemptも失敗証跡として閉じてretryする。固定・権限不足など再試行しても解決しない失敗はterminalにする。
- 実行前に、Workspaceと現在Roomの両方の上限を予約する。実行中の設定と異なる結果、上限超過、入力の変化は結果をそのまま保存せず、予約を精算してJob状態へ記録する。
- Jobを実行するRoom memberには、設定全体を書き換える権限を渡さない。予約・精算と設定行のロックだけは、Room実行権限を再確認する限定SQL関数を通す。

### 暫定Knowledgeの確定と履歴

- 自動reviewが作るResourceは`provisional`であり、確度、作成元Job、作成元Attempt、Evidenceを必ず残す。通常検索とContextには出せるが、人が確認済みの内容と同一扱いにはしない。
- 人が通常編集、固定、Copy、Move、Promote、または自動作成分をRestoreしたときは、その人の操作を`human_edit` Evidenceとして追記し、暫定・競合状態を`active`へ進める。これはAI更新の永久禁止ではない。AI更新を止めるのは明示的なfixedだけである。
- 利用結果は上書きしない。`unknown`の結果が後から確定した場合は、新しいUseを追記し、旧Useへの`supersedes_use_id`で訂正関係を表す。

## 実装対応

| 層 | 実装 | 主なファイル |
| --- | --- | --- |
| PostgreSQL | Activity、Resource、Version、Evidence、Link、Settings、Job、Attempt、Use tableとRLS | `packages/workspace-server/src/schema.ts` |
| Domain service | 候補分類、版管理、固定、競合、Copy/Move/Promote、検索、上限、lease、retry | `packages/workspace-server/src/workspace-learning.ts`、`workspace-learning-policy.ts` |
| Backend境界 | Room限定snapshotと狭いmutation resultを交換するReview Port、注入可能なWorker | `packages/workspace-server/src/workspace-learning-policy.ts`、`workspace-learning.ts`、`apps/server/src/workspace-server/core.ts` |
| HTTP | Activity、Resource、検索、設定、Job/Evidenceを操作ID付きで公開 | `apps/server/src/workspace-server/http-server.ts` |
| Backup/Restore | learning履歴をBundle v3に含め、SecretRefを除外し、実行中leaseをRestore時にqueueへ戻す | `packages/workspace-server/src/workspace-bundle-v3.ts` |
| Native App | 選択RoomのKnowledge一覧、三層検索、手動編集、固定、archive、Version/Evidence履歴、Workspace標準値とRoom上書きのEngine上限設定。用途別署名IPCのみ | `apps/desktop/src/workspace-learning-requests.ts`、`apps/web/src/components/WorkspaceLearningPanel.vue` |

## 更新経路

```text
Activity（確定した作業証拠）
→ 候補判定・Room scoped Job
→ Knowledge Hostの限定Review Port
→ 検証済みmutation plan
→ Resource / Version / Evidence / Link
→ Room scoped notification とNative App再取得
```

- 外部BackendはResourceを直接更新できない。
- 普通の人による保存はResource serviceを通る。固定・archive・Copy・Move・Promoteも版とAuditを残す。
- Artifact/CollectionはEvidenceの出所として扱うだけで自動変更しない。
- 既存のRoom権限を変更せず、学習処理開始・適用時にRLSで現在のRoom権限を再評価する。
- review timeout、Server終了、Backend一時失敗はretry可能なAttemptとして閉じる。Server終了時はDBを閉じる前に、その失敗記録まで待つ。次回実行時刻はRunnerが保持し、通知処理の失敗だけでretry待機を失わない。
- EvidenceとUseは、Resourceが見えるだけでは読めない。関連ActivityのRoomも読める場合だけ返す。Version、Evidence、Link、Use、Attemptは追記履歴であり、通常Runtimeからの更新・削除を許可しない。

## 検証入口

`pnpm server:04:verify`

- architecture boundary、型検査、Native App build、focused test、追跡済み・未追跡の差分空白検査
- Hosted / Self-host両方の実PostgreSQL migration・RLS・候補Job・固定拒否・利用結果feedback・Room実行者による限定費用精算・Bundle往復
- 検証用DBが未設定なら使い捨てDocker PostgreSQLを使う。Dockerも使えない場合は失敗終了し、静的検証だけを実DB確認済みとは扱わない。

必要な外部DB変数はServer 03と同じ。

```text
SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_URL
SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_ADMIN_URL
SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_RUNTIME_ROLE
SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_URL
SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_ADMIN_URL
SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_RUNTIME_ROLE
SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE=yes
```

## 実行結果

2026-08-16に`pnpm server:04:verify`を最終実行した。

- 通過: architecture boundary、Workspace Server / HTTP Server / Desktop / Native Appの型検査、実DB probeの型検査、Native App build、focused test **7 files / 29 tests**、追跡済み・未追跡の差分空白検査。
- 実PostgreSQL probe: 未実行。検証用DBは未設定で、使い捨てPostgreSQLを起動しようとしたが、この環境にDockerが無い（`spawnSync docker ENOENT`）ため`server:04:verify`は非0で終了した。
- したがって、Migration、RLS、Resource削除と追記履歴更新の拒否、Job lease、固定拒否、Bundle Restoreの実DB確認は**未検証**であり、この静的検証を実DB確認済みとは扱わない。
