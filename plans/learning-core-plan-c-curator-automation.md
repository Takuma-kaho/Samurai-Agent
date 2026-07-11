# Plan C: Evaluation-aware Curator / Automation

作成日: 2026-07-10

## 0. 目的

この計画は、増え続けるMemory・Skillを長期的に健全な状態へ保ち、Learning Coreを自動運転できるようにする。

含むもの。

1. Evaluation結果を判断材料にするCurator
2. 利用頻度、古さ、重複、矛盾、効果量による整理
3. snapshot、archive、restore、report
4. Background Review、Evaluation、Curatorの別周期実行
5. 多重実行防止、再試行、診断

---

## 1. 現在地

すでにあるもの。

- `runCuratorJob()`がある。
- Curator stateにpaused、idle gate、stale / archive日数がある。
- Skill usage countとlast usedを保存できる。
- stale、archive、reactivate、review候補を作れる。
- pinned Skillを保護できる。
- Curator runとsuggestionを保存できる。
- Evaluation jobとdiagnosticsがある。
- Automation job、run、Scheduler tickがある。

現在の不足。

- CuratorがRuntime内部へ集中している。
- 利用回数と経過日数が中心で、学習効果を使わない。
- Background Reviewの自動変更とCurator判断のversion連携が弱い。
- MemoryとSkillの整理方針が十分に分離されていない。
- 標準Learning jobの作成と周期が製品契約として固定されていない。
- 自動変更前snapshotとrun単位rollbackが学習Coreの標準になっていない。
- Scheduler tickはあるが、Learning jobの多重実行や重複対象処理をより明確に防ぐ必要がある。

---

## 2. Curatorの判断材料

Curatorは一つの指標だけで変更しない。

| 判断材料 | 役割 |
| --- | --- |
| 利用回数 | 実際に使われているか |
| 最終利用日時 | 長期間使われていないか |
| patch回数 | 修正が繰り返されていないか |
| Evaluation効果量 | 品質改善へ寄与したか |
| confidence | 判断に十分な根拠があるか |
| 重複 | 同じ内容が複数存在しないか |
| 矛盾 | 互いに反するMemory / Skillがないか |
| provenance | ユーザー作成か自動学習か |
| pinned | 自動整理から保護されているか |

Evaluation連携はSamurai独自の強化である。

Hermes型の利用頻度・日数による整理を土台にしつつ、「使われたが悪影響」「古いが明確に有効」を区別できるようにする。

---

## 3. MemoryとSkillを分ける

### 3.1 Skill Curator

扱うこと。

- stale化
- archive
- reactivate
- patch候補
- 似たSkillの統合
- class-level umbrellaへの整理
- support fileの再配置

### 3.2 Memory Curator

扱うこと。

- 重複統合
- 矛盾検出
- 古い事実のstale化
- Profileへ移すべき内容の候補化
- Wikiへ移すべき濃い知識の候補化
- 容量上限に合わせた圧縮

MemoryとSkillで同じarchiveルールを機械的に共有しない。

---

## 4. Lifecycle方針

### Skill

```text
active
  ↓ 長期間未使用・効果根拠なし
stale
  ↓ さらに長期間未使用・positive evidenceなし
archived

stale / archived
  ↓ 再利用またはpositive evidence
active
```

### Memory

```text
active / topic / sensitive
  ↓ 重複・矛盾・古さを検出
curation candidate
  ↓ 自動統合またはstale
archived
```

原則。

- 物理削除を標準にしない。
- pinned / owner-fixed resourceを自動archiveしない。
- harmful評価だけで即archiveしない。まずpatchまたは適用範囲修正を検討する。
- insufficient evidenceでは積極的な変更をしない。
- positive effectがあるresourceは、低頻度だけを理由にarchiveしない。

---

## 5. Curator module契約

`packages/learning`へ以下を追加する。

```text
curator/
  skill-curator.ts
  memory-curator.ts
  lifecycle-policy.ts
  consolidation.ts
  reports.ts
```

入力。

```text
resources
usage records
evaluation records
provenance
curator state
policy thresholds
current time
```

出力。

```text
proposed mutations
applied mutations
skipped mutations
decision reasons
evidence refs
run report
```

Runtimeは入力を集め、Curatorを呼び、Domain Operationで変更を適用するだけにする。

---

## 6. Snapshot / Restore

自動変更前に必ずsnapshotを作る。

対象。

- Memory Markdown
- Skill package全体
- support files
- index metadata
- lifecycle state
- usage / evaluation参照

必要な操作。

```text
curator.snapshot.create
curator.snapshot.list
curator.restore
curator.run
curator.pause
curator.resume
```

snapshotはWorkspace内の復元可能な記録とし、Curator run IDへ結び付ける。

---

## 7. 自動実行の分離

### Background Review

Trigger候補。

- 一定のuser turn数
- 一定のTool iteration数
- 複雑なrun完了

特徴。

- 軽量
- Foreground response後
- Memory / Skillだけを更新

### Evaluation

Trigger候補。

- 一定数の評価可能runが蓄積
- 1日1回
- Background Reviewによる学習変更後に比較対象が集まった時

特徴。

- 複数runを比較
- effect estimateを更新
- evidence不足なら保留

### Curator

Trigger候補。

- 7日程度の長い間隔
- 一定時間のidle後
- 手動実行

特徴。

- snapshotを取る
- lifecycleと統合を扱う
- 実行reportを残す

3つを一つのcron jobへまとめない。

---

## 8. Scheduler要件

- 同じjobの同時実行を防ぐlockを持つ。
- 同じsource runを重複処理しない。
- jobごとにlast cursorを持つ。
- failure時は指数backoffまたは上限付きretryを行う。
- Background Review failureはForegroundへ影響させない。
- Evaluation failureはCuratorの該当判断を保留にする。
- Curator failureはsnapshotから復元可能にする。
- process再起動後もdue jobを再開できる。
- timezoneとclock driftを考慮する。
- pause / resumeを永続化する。

---

## 9. 実装ステップ

### C1. CuratorをRuntimeから分離

- 現在のdeterministic lifecycleロジックを`packages/learning`へ移す。
- Store、Runtime、Serverへの直接依存をPortへ置き換える。
- Skill CuratorとMemory Curatorを分ける。

### C2. Evaluation連携

- 最新Evaluationをresource/versionごとに集約する。
- helpful / harmful / insufficient evidenceをpolicyへ渡す。
- positive evidence保護とharmful時のpatch優先を実装する。
- 判断理由へeffect estimateとevidence refsを残す。

### C3. Consolidation

- 重複候補をdeterministicに絞る。
- LLM consolidationは絞られた候補だけを読む。
- Skill package全体を統合対象にする。
- Memory / Wiki / Skillの役割を跨ぐ移動を明示する。

### C4. Snapshot / Restore

- run前snapshotを作る。
- archiveを可逆操作にする。
- restoreで本文、support、index、stateを戻す。
- snapshot保有数と削除方針を設定できるようにする。

### C5. Scheduler policy

- Background Review cadenceを設定する。
- Evaluation cadenceを設定する。
- Curator intervalとidle gateを設定する。
- 標準jobを初期化する。
- lock、cursor、retry、diagnosticsを追加する。

### C6. Report / Diagnostics

runごとに以下を残す。

- 対象resource数
- 変更数
- archive / restore / patch / merge数
- skip理由
- Evaluation利用数
- snapshot ID
- 実行時間
- failure
- 次回予定

UIは作らず、APIとWorkspace reportで確認できるようにする。

---

## 10. 主な変更候補

| 場所 | 変更内容 |
| --- | --- |
| `packages/learning/` | Curator、lifecycle、consolidation、scheduler policy |
| `packages/core-schemas/src/index.ts` | snapshot、curator decision、report schema |
| `packages/workspace-store/src/index.ts` | snapshot、cursor、lock、report永続化 |
| `packages/runtime/src/index.ts` | 薄いorchestrationへ縮小 |
| `apps/server/src/index.ts` | run / pause / resume / restore / diagnostics API |
| `packages/skills/` | Skill package操作の再利用可能helper |
| `packages/memory/` | Memory統合・容量管理helper |

---

## 11. テスト計画

### Curator

- pinned resourceを変更しない。
- positive effectがある低頻度Skillをarchiveしない。
- harmful評価では即削除せずpatchを優先する。
- insufficient evidenceでは積極変更しない。
- stale / archive / reactivateがpolicy通り動く。
- Skill packageのsupport fileを失わない。
- MemoryとSkillのlifecycleを混同しない。

### Snapshot / Restore

- run前にsnapshotが作られる。
- archive後にrestoreできる。
- 本文、support、index、stateが一致する。
- failed runから復元できる。

### Scheduler

- 同じjobを多重実行しない。
- cursorより古いrunを重複処理しない。
- retry上限を守る。
- process再起動後にdue jobを再開する。
- Evaluation失敗時にCuratorが該当判断を保留する。
- pause / resumeが永続化される。

---

## 12. 完了条件

- CuratorがRuntimeから独立moduleへ分離されている。
- SkillとMemoryの整理policyが分かれている。
- Curatorが利用頻度、古さ、重複、矛盾、効果量を判断材料にする。
- positive effectとinsufficient evidenceを正しく保護できる。
- 自動変更前にsnapshotが作られる。
- archiveからrestoreできる。
- Background Review、Evaluation、Curatorが別周期で動く。
- 標準Learning jobが初期化される。
- 多重実行、重複処理、failure retryを制御できる。
- run reportとdiagnosticsが残る。
- UI実装へ依存しない。
- `pnpm typecheck`と関連testが成功する。

---

## 13. Learning Coreの終了条件

Plan C完了時点で、Learning Coreは以下の状態になる。

```text
必要なMemory / Skillだけを利用
↓
利用事実をrunへ記録
↓
Background Reviewが自動学習
↓
次のrunで学習を再利用
↓
Evaluationが効果量を測定
↓
Curatorが有効性と鮮度を維持
↓
各処理が独立周期で継続
```

これをもって、Agent Coreの学習基盤を一度完成とみなす。

