# Plan B: Autonomous Background Review / Evaluation

作成日: 2026-07-10

## 0. 目的

この計画は、Hermes型の自律学習とSamurai独自の効果量測定を一つの閉ループとして実装する。

含むもの。

1. 固定キーワードReflectionを廃止する。
2. 別Agentが会話と実行履歴を振り返るBackground Reviewを作る。
3. Memory・Skillを人間の承認なしで自動作成・更新する。
4. どの学習変更が実行品質へ効いたかEvaluationする。

---

## 1. 現在地

すでにあるもの。

- 会話完了後に`runReflectionForCompletedTurn()`が呼ばれる。
- Reflection runとsuggestionを保存できる。
- Memory、Knowledge Wiki、Skill、patch、conflictのsuggestion typeがある。
- suggestionをMemory / Wiki / Skillへ適用するDomain Operationがある。
- deterministicなEvaluation reportと任意のJudge Providerがある。
- Backend run、event、Tool run、Workspace change、Artifactを参照できる。

現在の不足。

- Reflection候補が「覚えて」「手順」「今後」などの固定キーワードに強く依存する。
- ReflectionがRuntime内の大きな関数として存在する。
- 自動学習よりproposal / apply中心の旧フローになっている。
- Background Review専用Agentとtool制限がない。
- Evaluationは異常traceの検出が中心で、学習変更の効果量を測らない。
- Skill候補に出たことと実利用が混ざるため、因果評価が弱い。

Plan A完了後は、実利用記録をEvaluationの根拠に使える。

---

## 2. Hermesから採用する構造

### 2.1 Foreground runと分離する

ユーザーの依頼を処理するAgentと、学習判断をするAgentを分ける。

```text
Foreground Backend run完了
↓
応答はユーザーへ返す
↓
Background Reviewを別runとして起動
↓
会話・Artifact・Tool・変更履歴を読む
↓
Memory / Skillだけを作成・更新
```

Background Reviewが通常Sessionへ自分のpromptや応答を書き込まないようにする。

### 2.2 固定キーワードを使わない

LLMへ次をまとめて渡し、保存・更新・何もしないを判断させる。

- 会話
- ユーザーの訂正
- Backend run
- Tool run
- Artifact
- Workspace change
- 実際に読まれたMemory / Skill
- 既存のMemory / Skill catalog

固定語句はtriggerや正解判定に使わない。

### 2.3 書込可能範囲を狭くする

Background Reviewへ渡す操作を限定する。

- Memory add / replace / remove
- Skill create / patch / support file write
- 既存Memory / Skillのsearch / view

Artifact、Collection、外部送信、一般file write、Gateway操作は許可しない。

### 2.4 自動保存を標準にする

Background Reviewの正当なMemory・Skill変更は、自動的にWorkspaceへ保存する。

- 確認画面を作らない。
- approval queueを必須にしない。
- proposal状態をユーザー承認待ちの中核にしない。
- 変更履歴とprovenanceは必ず残す。

将来の承認モードを追加できる境界は残してよいが、今回実装しない。

---

## 3. Samurai独自のEvaluation

### 3.1 正式Outcomeは作らない

以下のような固定ラベルを正本として保存しない。

```text
user_corrected = failure
artifact_saved = success
retry = failure
```

これらは文脈によって意味が変わるためである。

### 3.2 既存の事実から評価を導出する

Evaluationのevidence候補。

- Backend run status
- Tool run status
- Workspace change
- Artifact生成
- 次のユーザー発話
- 修正依頼や再実行の有無
- Background Reviewが行った変更
- Plan Aの実利用resource/version
- 同種タスクの過去run

### 3.3 評価結果は再計算可能なread model

Evaluationは「真実」ではなく、その時点の根拠から導いた評価として保存する。

候補フィールド。

```text
evaluation_id
learning_resource_ref
learning_resource_version
task_class
compared_run_ids
before_metrics
after_metrics
effect_estimate
confidence
assessment: helpful | neutral | harmful | insufficient_evidence
evidence_refs
evaluator
created_at
```

元の会話やrunを消さず、判定ロジックを変更した時に再評価できるようにする。

---

## 4. Background Review契約

### 4.1 ReviewSnapshot

Background Reviewへ渡す不変snapshotを作る。

```text
source_session_id
source_run_id
messages
artifacts
backend_events
tool_runs
workspace_changes
used_learning_resources
existing_memory_catalog
existing_skill_catalog
```

大きすぎる場合は、同じBackendなら既存contextを再利用し、別の軽量Backendならdigestを使う。

### 4.2 BackgroundReviewRunner

`packages/learning`側にPortを定義する。

```text
BackgroundReviewRunner.run(snapshot, policy)
```

Runtime / agent-backends側にAdapterを置く。

- main Backendと同種を既定にできる。
- 安価なreview Backendへ差し替えられる。
- 最大iterationを制限する。
- 通常Sessionへpersistしない。
- failureはForeground responseを失敗させない。

### 4.3 provenance

自動変更へ次を残す。

```text
origin: background_review
source_run_id
source_session_id
review_run_id
before_version
after_version
reason summary
evidence refs
```

---

## 5. 実装ステップ

### B0. 学習方針の正本を同期する

- `PRINCIPLES.md`の「候補表示を優先する」旧方針を、自動学習標準へ更新する。
- `ARCHITECTURE.md`のReflection flowから、ユーザー承認を必須とする読み方を外す。
- 承認は将来追加可能な任意境界であり、Learning Coreの依存条件ではないと明記する。
- UI文書には確認画面を追加しない。

### B1. `packages/learning`を追加する

最初のmodule。

```text
background-review.ts
evaluation.ts
types.ts
ports.ts
```

依存方向。

- `packages/learning`はCore schemaを利用できる。
- Express、Vue、Electronへ依存しない。
- Workspace Store実装へ直接依存せずPortを使う。
- Agent Backend実装へ直接依存せずRunner Portを使う。

### B2. 旧Reflectionを置き換える

- `createReflectionSuggestions()`の固定キーワード判定を削除する。
- 会話後処理はBackground Review triggerへ置き換える。
- 既存Reflection run tableは実行履歴として再利用する。
- 旧suggestion apply APIは互換性のため残してもよいが、標準経路にしない。

### B3. 制限付きReview run

- Review専用tool catalogを作る。
- Memory / Skill operationだけを許可する。
- 通常file writeや外部操作を拒否する。
- source Sessionへのmessage persistを禁止する。
- 同じsource runに対する重複Reviewを防ぐ。

### B4. 自動Memory / Skill更新

- MemoryとSkillの役割を混ぜないpromptを固定する。
- 既存Skillが合う場合はpatchを優先する。
- 新規Skillはclass-levelの再利用可能な手順に限定する。
- 一時的な環境エラーや一回限りの作業をSkill化しない。
- Memory容量、重複、機密度の既存制約を維持する。
- 保存はDomain OperationとWorkspace Storeを通す。

### B5. Evaluation基盤

- `LearningEvaluationRecord`をCore schemaへ追加する。
- Storeへ保存・再計算・一覧APIを追加する。
- deterministic signal extractorを作る。
- optional LLM judgeを既存Provider境界へ接続する。
- 同種タスクの比較集合を作る。
- evidence不足時は`insufficient_evidence`にする。

### B6. 効果量計算

最初の指標候補。

- run完了率
- Tool failure率
- waiting / retry率
- 実Workspace changeの有無
- 同種タスクでの再修正量
- Artifact再生成回数
- evaluator quality score

一つの指標だけで成功・失敗を決めず、複数のevidenceとconfidenceを出す。

---

## 6. Backend設定方針

標準。

- Background Reviewは自動実行する。
- 人間の承認を要求しない。
- Review Backendはmain Backendを既定にできる。
- 別の軽量Backendを設定できる。
- 学習を完全に止めるbackend configは用意する。

既存capture modeは以下へ整理する。

```text
auto    # 自動学習。新しい標準値
manual  # 明示的な保存だけを許可する任意設定
off
```

既存`manual`は維持し、旧`suggest`はmigrationで`auto`へ変換する。UI機能は追加しないが、既存Settingsのtypecheckを壊さない最小互換対応は行う。

---

## 7. 主な変更候補

| 場所 | 変更内容 |
| --- | --- |
| `packages/learning/` | Background Review、Evaluation、Port、純粋ロジック |
| `packages/core-schemas/src/index.ts` | Review snapshot、provenance、evaluation schema |
| `packages/runtime/src/index.ts` | Foreground完了後の起動とAdapter接続 |
| `packages/agent-backends/src/index.ts` | Review runner、tool restriction、review prompt |
| `packages/workspace-store/src/index.ts` | review/evaluation永続化 |
| `packages/action-catalog/src/index.ts` | Background Review用Memory / Skill operation確認 |
| `apps/server/src/index.ts` | 手動実行・診断APIの薄い接続 |

---

## 8. テスト計画

### Background Review

- 固定キーワードなしでReview runnerが呼ばれる。
- Memory / Skill以外のToolが拒否される。
- Review promptが通常Sessionへ保存されない。
- Foreground responseを待たせない。
- Review失敗がForeground runを失敗させない。
- 同一source runを重複Reviewしない。
- 自動変更にprovenanceが付く。

### Evaluation

- 正式Outcomeを保存しない。
- 同じevidenceから同じdeterministic signalを作れる。
- resource versionごとに比較できる。
- evidence不足を無理にhelpful / harmfulへ分類しない。
- optional Judge失敗時もdeterministic reportが残る。
- Plan Aの実利用recordだけを評価対象にできる。

---

## 9. 完了条件

- `createReflectionSuggestions()`の固定キーワード判定が標準経路から消えている。
- Background Reviewが独立moduleと独立runで動く。
- Review AgentはMemory / Skill以外を変更できない。
- Memory・Skillが人間の承認なしで自動作成・更新される。
- 自動変更にsource runとversionが残る。
- 正式Outcome tableを作っていない。
- 学習変更前後の効果量をevidenceとconfidence付きで保存できる。
- evidence不足を正しく表現できる。
- Runtimeはreview/evaluationの詳細ロジックを持たない。
- `pnpm typecheck`と関連testが成功する。

---

## 10. Plan Cへの受け渡し

Plan Cは以下を利用できる。

- resourceごとの実利用回数
- resource versionごとの効果量
- helpful / neutral / harmful / insufficient evidence
- Background Reviewのprovenance
- 重複、矛盾、patch候補
- ReviewとEvaluationの実行履歴
