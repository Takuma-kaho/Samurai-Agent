# Core 実装進捗台帳

最終更新: 2026-07-22

現在の判定は、**Core-01は「残課題あり」**、**Core-02は「実装中」**、**Core-03〜Core-08は「基盤あり・個別完了作業は未着手」**である。

## 0. この文書の目的

- Core-01〜Core-08の進捗、残課題、検証結果を1か所で管理する。
- 今後はCoreを1つずつ進め、着手・実装・検証・完了判定のたびにこの文書を更新する。
- この文書は進捗台帳であり、設計の正本は [PRINCIPLES.md](../PRINCIPLES.md)、[ARCHITECTURE.md](../ARCHITECTURE.md)、[PUBLIC_NAMING.md](../PUBLIC_NAMING.md)、[WEB_UI_DESIGN.md](../WEB_UI_DESIGN.md) とする。
- Core全体の完了条件は [core-completion-plan.md](./core-completion-plan.md)、Core-01固有の条件は [core-01-domain-command-oss-quality-completion-plan.md](./core-01-domain-command-oss-quality-completion-plan.md) を使う。

## 1. 状態のルール

| 状態 | 意味 |
|---|---|
| 基盤あり・個別完了作業は未着手 | 関連機能は存在するが、この台帳に沿った監査・残実装・Hard Gateをまだ始めていない |
| 実装中 | 対象範囲と完了条件を固定し、実装または検証を進めている |
| 残課題あり | 主要実装はあるが、未解決の監査事項または未完走のHard Gateがある |
| 完了 | 対象範囲の実装、Hard Gate、最新Evidence、独立完了判定がすべて合格した |

チェックや部分テストが通っただけでは「完了」にしない。失敗・中断・未計測は、そのまま残課題として記録する。

## 2. Coreの8分類と現状

| # | Core分類 | 現状 |
|---|---|---|
| 1 | 契約・Domain Command基盤 | 実装済み。Schema、操作カタログ、共通UI契約がある |
| 2 | Host・Runtime | 機能は実装済み。ただし約17,700行で肥大化している |
| 3 | Backend実行・Event正規化 | 概ね実装済み。Codex、Claude Code、Nativeを差し替え可能 |
| 4 | Workspace・永続化 | 概ね実装済み。filesystemとSQLiteを扱うが約9,700行で肥大化 |
| 5 | Memory・Wiki・Skill・学習ループ | 基盤実装済み。Background Review、Evaluation、Curatorが存在 |
| 6 | Artifact・Collection | 概ね実装済み。成果物、履歴、構造化データ操作を保持 |
| 7 | Presentation・Generated Surface | 概ね実装済み。表示形式の選択、Surface契約、生成Surfaceがある |
| 8 | Gateway・Automation・外部境界 | 概ね実装済み。routing、pairing、sandbox、定期実行がある |

上表は2026-07-19時点の開始スナップショットである。行数と実装状態は、各Coreの着手時に再計測する。

## 3. 進捗サマリー

| Core | 状態 | 現在できていること | 詳細チェックリスト |
|---|---|---|---|
| Core-01 | **残課題あり** | 119操作の契約、個別Module、共通Dispatcher、入口統一、検証基盤 | 作成済み |
| Core-02 | **実装中** | Phase 0〜2と終了結果保存経路を実装中。Phase 3〜7、本番切替、旧Runtime削除は対象外 | [core-02-phase-0-2-scope-ledger.json](./core-02-phase-0-2-scope-ledger.json) |
| Core-03 | 基盤あり・個別完了作業は未着手 | Backend差し替えとEvent正規化 | 未作成。着手時に作成する |
| Core-04 | 基盤あり・個別完了作業は未着手 | filesystemとSQLiteの永続化 | 未作成。着手時に作成する |
| Core-05 | 基盤あり・個別完了作業は未着手 | Memory、Wiki、Skill、Review、Evaluation、Curator | 未作成。着手時に作成する |
| Core-06 | 基盤あり・個別完了作業は未着手 | Artifact、履歴、Collection操作 | 未作成。着手時に作成する |
| Core-07 | 基盤あり・個別完了作業は未着手 | Presentation選択、Surface契約、Generated Surface | 未作成。着手時に作成する |
| Core-08 | 基盤あり・個別完了作業は未着手 | routing、pairing、sandbox、Automation | 未作成。着手時に作成する |

## 4. Core別チェックリスト

### Core-01 契約・Domain Command基盤

状態: **残課題あり**

#### 完了していること

- [x] `@samurai-agent/domain-operations`を契約と実行定義の中心にした。
- [x] 契約台帳は102 Command、17 Query、5 Deprecatedを保持している。
- [x] 119 Active Operationに対応する119個のOperation Moduleがある。
- [x] 入力・出力Schema、操作カタログ、固有Handler、共通Registry / Dispatcherの基盤がある。
- [x] Web、Surface、Backend tool、Gateway、Automation、Generated Surfaceを同じDomain Operationへ寄せる入口がある。
- [x] Trusted Context、入力・出力検証、冪等性、並列実行、Crash、Query純粋性の検証基盤がある。
- [x] Verifierへ意図的な違反を入れる自己検査が36ケースまで用意されている。
- [x] 直近の部分検証では、追加した対象テスト14件と、coverage対象のテスト88件が成功した。

#### 参照OSS水準としての再評価

- Core-01の基本設計は、参照OSSのコードを同じ形で再現するのではなく、MulmoClaudeの入力検証と限定Runtime、Hermes Agentの中央Registry / Dispatch、OpenClawの分野別Schema・server-owned Context・冪等性をSamurai Agent向けに組み合わせたものである。
- Schema、共通Registry / Dispatcher、Trusted Context、入口からの直接更新禁止、Queryのread-only境界、冪等性とCrash境界は維持する。
- 119 Operation Moduleを含む現行コードについて、基本設計を撤回する全面的な手戻りは不要と判断する。
- ただし「コード変更が一切不要」とは未確認である。独自の厳格条件に合わせた転送だけのHandler、重複実装、不自然な分割がないかを限定監査し、実害が確認できた箇所だけ整理する。
- 「1操作＝必ず1ファイル＝必ず別関数」、対象全体のcoverage 100%、Verifierの全破壊試験、全OSのCI実績、clean CommitとEvidence SHAの完全一致は、参照OSSと同等であるための必須条件ではない。これらは推奨またはRelease hardeningとして別管理し、Core-01の完了を無期限に止める条件にはしない。

#### 完了していないこと

- [ ] 119 Operationを対象に、転送だけのHandler、同一処理の大量複製、独自ルールを満たすためだけの不自然な分割がないか、保守性の限定監査を行う。
- [ ] 上の監査で実害が確認された場合だけ、該当箇所を整理する。確認なしの統合・再分割・全面書き直しは行わない。
- [ ] Core Schemas、Domain Operations、Action Catalog、Runtime、Serverのtypecheckを確認する。
- [ ] 契約、Registry / Dispatcher、入口統一、Trusted Context、冪等性、Query純粋性、Crash境界の主要テストを確認する。
- [ ] 全Repo testと`git diff --check`を確認する。
- [ ] 現在のEvidenceを102 Command / 17 Query / 5 Deprecated / 119 Moduleへ更新し、古いInventoryを現状証明に使わない。
- [ ] 独立完了判定で、基本設計と主要な動作・境界に未解決の重大問題がないことを確認する。

#### Core-01を完了へ変更する条件

- [ ] 上の未完了項目がすべて完了している。
- [ ] 入力・出力Schema、共通Registry / Dispatcher、Trusted Context、入口統一、直接更新禁止、Query純粋性、冪等性・Crash境界が、実装と主要テストで確認できる。
- [ ] 保守性監査で、全面的なコード手戻りを必要とする構造問題がない。小さな問題が見つかった場合は、対象箇所だけ修正済みである。
- [ ] 実行日、Commit SHA、検証Command、結果をこの台帳の更新履歴へ残している。

## 5. Core-02〜Core-08の扱い

- Core-02は、専用台帳でPhase 0〜2と`C02-FINAL-01`だけを管理する。
- Core-02のPhase 3〜7、本番切替、旧Runtime削除、全体Hard Gateは`unverified`のまま残す。
- Core-03〜Core-08の詳細チェックリストと完了条件は、引き続き作成しない。

## 6. 更新ルール

各Coreの着手・中断・完了時に、次を必ず更新する。

1. 状態。
2. 完了したチェック項目。
3. 残課題と、その理由。
4. 実行した検証Commandと結果。
5. Evidenceの場所、実行日、Commit SHA。
6. 次に着手する1項目。

## 7. 更新履歴

| 日付 | Core | 変更 | 検証・根拠 | 次の作業 |
|---|---|---|---|---|
| 2026-07-19 | Core-01 | 完全完了ではなく「残課題あり」で区切った | 現行台帳は102 Command / 17 Query / 5 Deprecated、119 Operation Module。部分テストは成功したが、最新coverage・一括Hard Gate・Evidence整合は未完了 | Core-02着手前に本台帳を開始点として使う |
| 2026-07-22 | Core-02 | Phase 0〜2＋終了結果保存経路の実装へ着手。未追跡の現行実装も対象に含めた | `plans/core-02-phase-0-2-scope-ledger.json`。VitestはNode-only設定でも起動停止を再現しており、検証基盤の修正を継続中 | Lifecycle / Journal / settlementの型接続と、期限付き検証を完了する |
| 2026-07-22 | Core-02 | Lifecycle判定、Journal、終了結果の一括保存、Admission、Session lane、Control、Recoveryを実装。Phase 3〜7と旧Runtime切替は未着手のまま保持 | `core:host-runtime:check`成功、focused Vitest 10ファイル / 67テスト成功（108.18秒）。最新VerifierはCore Schema / Agent Backendのみ成功し、Workspace Store / Runtime typecheckは180秒超過、Git差分検査は`mmap failed: Operation canceled`で失敗 | TypeScript・Git検査の停止原因を解消し、同じ範囲でVerifierを再実行する |
| 2026-07-22 | Core-02 | Phase 0〜2＋`C02-FINAL-01`の実装を継続。診断用の一時設定・bundleを整理し、実装対象のSourceと台帳は保持 | 最新Sourceで`core:host-runtime:check`成功（required 18 / parsed 41 / untracked Core-02 34）。独立focused VitestはRuntime 55件、Workspace/SQLite 14件の計69件が成功。直近完走VerifierではAgent Backendとbundleは成功したが、Core Schema / Workspace Store / Runtime typecheckの180秒制限超過、Verifier内Runtime focused実行の120秒超過、Git差分検査の停止が残る | typecheck・Git差分検査・Verifier内focused実行の停止原因を解消し、Phase 0〜2の全終了条件を再判定する。Phase 3〜7は`unverified`のまま |
| 2026-07-22 | Core-02 | `LifecycleTransitionDecision`をCore Schemaの共有ブランド型へ接続し、Storeの終了保存Portが匿名decisionを受けない契約へ修正。Workspaceのsettlement fixtureも`RunLifecycle`生成decisionを使用する形へ変更 | 変更後の`core:host-runtime:check`成功（required 18 / parsed 41 / untracked Core-02 34）、focused bundle生成成功。変更後focused再実行はWorkspaceが120秒無出力で未完走、型検査も180秒到達前後の無出力停止が継続 | focused test・型検査・Git差分検査を成功終了できる実行環境または根本原因を確認し、全終了条件を再判定する |
| 2026-07-22 | Core-02 | Vitestの依存cacheを生成bundle外へ分離し、bundle再生成でcacheを消さない検証基盤へ調整 | bundle生成は成功。cache分離後のWorkspace focused初回も120秒無出力で未完走のため、成功扱い・timeout延長・`forceExit`追加は行っていない | Vitest worker起動停止の根本原因を引き続き切り分け、Phase 0の検証終了条件を満たすまで`実装中`を維持する |
| 2026-07-22 | Core-02 | 終了結果の同一再実行比較に診断内容と「回答なし／あり」の差分を追加し、異なる結果を`settlement_conflict`へ分けた | `core:host-runtime:check`成功（required 18 / parsed 41 / untracked Core-02 34）、focused bundle生成成功。focused Vitest・TypeScript・Git差分検査の停止は未解消 | Phase 0〜2＋`C02-FINAL-01`の全終了条件を、成功終了するfocused test・typecheck・Git検査で再判定する |
| 2026-07-22 | Core-02 | fixtureの実行前状態を修正し、SQLite settlement競合テストを実Run状態から開始するよう整理 | 現在Sourceの独立focused VitestはWorkspace 3ファイル / 14件、Runtime 7ファイル / 55件の計69件が成功（Vitest内部計測 98.50秒 / 52.08秒）。ただし外側の起動遅延がVerifierの120秒制限を超えるため、Verifier全体は未完走。TypeScriptとGit差分検査も未達 | 起動遅延・typecheck・Git差分検査を解消し、Phase 0〜2の終了条件を再判定する |
| 2026-07-22 | Core-02 | focused Runnerのgroup・bundle rootを明示し、cache再利用後の実行を再確認した | `core:host-runtime:check`成功（required 18 / parsed 41 / untracked Core-02 34）。Workspace 14件は2.79秒、Runtime 55件は2.76秒で各exit code 0。Core Schema / Workspace Store / Runtime typecheckとGit差分検査は未達のため、Phase 0〜2は完了扱いにしない | 型検査・Git差分検査を成功終了させ、最新SourceでVerifier全体を再判定する |

追記用テンプレート:

```md
| YYYY-MM-DD | Core-0X | 実装・判断内容 | command、test件数、Evidence、Commit SHA | 次の1項目 |
```
