# Room / Agent collaboration Phase 3, 4, 6 実装・検証記録

対象Plan: `plans/room-agent-collaboration-plan-phase3-4-6.md`

実施日: 2026-09-06

## 実装範囲

- Roomを継続する仕事の表面、Sessionを内部継続参照とするRoom Work境界を実装した。
- 依頼、返信、コメント、明示反映、reaction、停止、委譲、再割当、Agent DM、Room既定Agent、認可、実行予約、Activity/履歴を追加した。
- Native UI、browser bridge、Desktop preload/mainにRoom/Work/Agent状態と停止確認状態を公開した。
- Workspace Bundle v3/v4へRoom設定・Human Work履歴を追加し、legacy continuationを構造的に安全な場合だけ復元するようにした。
- 再割当では、結果不明、実行中またはclaim済みの旧枝、reverse dependencyをfail-closedにし、停止後だけreplacementを作成するようにした。
- 同じPostgreSQL clientへの並列queryを、Room Work詳細、Curator、Runtime admissionで直列化した。

## 静的・自動検証

| 検証 | 結果 |
| --- | --- |
| `pnpm test`（最終統合） | 成功（164 files / 1,060 tests） |
| `pnpm run verify:source-quality` | 成功（issues 0） |
| `pnpm run core:domain-contracts:verify` | 成功（13 tests） |
| `pnpm run phase01:verify` | 成功（426 entries） |
| Workspace Server focused Vitest | 成功（5 files / 88 tests） |
| 最終公開契約・Bundle・UI focused Vitest | 成功（8 files / 175 tests） |
| Room権限・委譲先チェックボックス focused Vitest | 成功（2 files / 23 tests） |
| Runtime admission focused Vitest | 成功（29 tests） |
| Room Work画面回帰Vitest（最終） | 成功（2 files / 60 tests） |
| 委譲公開応答の最終回帰Vitest | 成功（4 files / 76 tests） |
| Workspace Server / Web / Desktop typecheck | 成功 |
| Web build | 成功（既存のchunk size warningのみ） |
| `pnpm desktop:build` | 成功（typecheck・main/preload bundle・artifact検証） |
| `pnpm desktop:verify` | 成功（architecture checks 14項目） |
| `pnpm run verify:postgres-migration:static` | 成功 |
| `pnpm run verify:postgres-runtime-scope` | 成功（issues 0） |
| `pnpm verify:postgres-deep` | 未検証（Hosted/Self-host向け環境変数なし。下記の専用隔離DB E2Eとは区別） |
| `git diff --check` | 成功 |

## 隔離E2E

条件:

- 専用Docker PostgreSQL、`/private/tmp`配下の専用storage/profile、ローカルSelf-host Serverだけを使用した。
- 既存履歴確認用DBではMigration v1〜v118を連番適用し、`latest_version: 118`とcontiguousを確認した。委譲・公開Event用の新規DBではv1〜v120を連番適用し、UI用DBは追加migrationでv120へ更新した。停止予約ガードv121は専用一時クローンで適用・確認した。
- Gemini成功再検証用の新規DBではMigration v1〜v121を連番適用した。2026-09-06 JST、macOS 26.6.2、検証開始時のHEAD `1d757fd`、Node.js v22.23.1、Self-host Server、Geminiのみ・fallback 0で実施した。Artifact初回は`gemini-3.5-flash`、429後の成功再検証は`gemini-3.5-flash-lite`を使用した。
- 既存のDocker stack、Hosted、本番データ、利用者のDesktop profileを操作していない。

確認済み:

- 初期化後にServerを再起動し、Worker Supervisorが`running`になることを確認した。
- 隔離テストAccountで、Room作成、新規/既存Agent選択、Agent DM分離、Native Geminiの初回依頼と返信完了を確認した。
- コメント投稿だけでRun数が増えず、明示反映でinstructionが実行対象になること、無権限停止が403になることを確認した。
- instruction状態が`pending → accepted → applied`、Assignmentが`waiting → ready → completed`となることを実DBで確認した。
- Native Geminiの実行中停止では、外部終端証跡を確認できない場合に`unconfirmed/outcome_unknown`を維持し、追加Runを作らないことを確認した。
- 再割当では、実行中reverse dependencyの停止要求/停止待ち、停止後のreplacement作成、未開始依存枝と予約の取消、結果不明拒否、二重再割当拒否、無効claim入力の副作用なしを実PostgreSQLで確認した。
- 公式認証を使わないローカルCodex JSONL fixtureで、外部Backendの`running → confirmed/cancelled`と追加Runなしを確認した。
- `NODE_OPTIONS=--trace-deprecation`で停止再投影を追跡し、Runtime admission直列化後にPostgreSQL並列query警告が再発しないことを確認した。
- 隔離Desktop profileで本人確認をOS保護領域へ読み込み、実ServerのWorkspace、Room、Work一覧・詳細を表示できることを確認した。テスト用秘密鍵は確認後にクリップボードから消去した。
- Electronの実画面からAgent作成、RoomへのAgent追加、Room既定Agent設定、依頼作成を行い、Agent・Room権限・既定Agent・Human Work・Assignment・Runtime Runが専用PostgreSQLへ保存されることを確認した。
- Electron依頼の同じ画面経路で、Native Geminiの`run_started`から`run_failed(provider_failed, HTTP 429, retryable)`までがDBへ保存され、Work画面が失敗状態を表示することを確認した。利用枠制限のため、このUI経路のProvider成功表示は未達として扱う。
- 隔離Electron画面から依頼したGemini実行が完了し、Work一覧・詳細で`完了確認済み`を表示することを確認した。`gemini-3.5-flash`の初回成功では、`create_artifact`、`tool_call_started`、`tool_call_output`、`artifact_created`、`run_completed`、Artifact record、登録SHA-256、storage上の実Markdownファイルを照合し、本文の検証用markerも一致した。
- 同じ画面で完了済みWorkへ返信し、`gemini-3.5-flash-lite`で初回依頼と返信を成功させた。返信は同一Workの`source_kind=reply`、親子Assignment、Native backendの完了Run、画面の`完了確認済み`で照合した。初回の返信はGemini HTTP 429で失敗したが、fallbackなしの同一provider・別利用可能モデルで一度だけ再実行して成功した。
- Electron画面から、PrimaryとSpecialistの二つのNative Agentを含む統合E2Eを確認した。明示委譲ではPrimary → Specialist → Primary継続の三Assignmentと各完了Run・予約解放を確認した。自動委譲の初回はモデルが登録IDでない文字列を渡して`workspace_agent_not_active`となったため成功扱いにせず、登録済みAgent IDを明示した一度の再試行で、Primaryの`subagent_delegate`成功出力、子Assignment、Specialistの完了Run、Primary継続、画面の3担当・`完了確認済み`を照合した。
- 最新Desktop bundleを起動した新規Roomでも、Electron画面から仕事を作成し、Specialistを選択して明示委譲できることを再確認した。画面の「Serverが受付済み」表示、Room再選択後の親・子2担当と指示v2、隔離PostgreSQLの親子Assignment・`origin_kind=delegated`・pending instructionを照合した。Workerを設定していないため、この再確認ではGeminiを呼んでいない。
- v120 Runtime delegationでは、公開委譲HTTP 201、公開Event取得200、子Assignment/Event作成、権限解除後403、停止後reassign、遅延結果混入なしを確認した。
- v120停止Event投影修正後、停止API HTTP 201、公開Event取得200・schema parse成功、assignment `cancelled`、control `confirmed`、`current_run_id=null`を確認した。
- v121停止予約ガードでは、個別停止の対象外となる「Run未作成・claimed」枝だけを`ready`＋新世代`reserved`へ再キューし、実行中Runを変更せず、親子停止後の予約孤児化がないことを実PostgreSQL一時クローンで確認した。
- Session継続参照のfocused testで、親AssignmentのRoom／Work／Agent／Backend／generation／nested runtime bindingが一致しない場合に外部Sessionを再利用せず新規Sessionへフォールバックすることを確認した。
- Agent DMを別`operation_id`で再オープンする回帰testを追加し、SQL関数が返すcanonical `room_id`をStoreが再利用することを確認した。

## 検証中に発見・修正した事項

- runtime roleに必要な`samurai_human_work_assignment_is_superseded`実行権限がなく、初期E2Eで42501になった。権限付与を追加し、v118の新規DBで再検証した。
- v117独立レビューで、invalid claimの副作用、旧Assignmentの二重再割当、legacy Bundleの非終端sibling許容を検出した。append-only v118で修正し、独立レビューでP0/P1なしを確認した。
- 停止再投影で同一PostgreSQL clientへ並列queryしていたためdeprecation warningが出た。Runtime admissionを直列化し、実停止E2Eで警告が消えたことを確認した。
- 外部停止fixtureは最初に旧DBを参照していたため中断した。v118隔離DBを参照するよう補正後、ローカルfixtureで成功した。公式Codexの結果ではない。
- Bundle Exportで通常継続に親を持つ履歴を拒否していたため、継続種別を`parent_continuation`へ正規化した。既存履歴のExport、Restore、添付参照の実DB確認に成功した。Restore時に実行中Workへ`stop_unconfirmed`を追加するのは自動再開を防ぐ意図的な安全制御である。
- Restore時の履歴Runtime bindingが現行bindingとして扱われていたため、復元側では`historical_runtime_binding`として保持し、実行を自動再開しないよう修正した。
- Runtime delegationでSQL変数と列名が曖昧になり42702となっていたため、bound変数へ分離した。公開Eventの`accepted/completed`制御受付状態をAssignment状態へ誤投影していたため、停止Eventでは状態を省き、委譲・再割当だけAssignment状態schemaで検証するよう修正した。
- Reactの遅延Event参照でAgent editor、Room権限、委譲先・依存対象チェックボックスがnull参照になり得たため、イベント内で値をプリミティブへ退避してからstate更新するよう修正した。focused testとWeb buildで再確認した。
- 最終統合時に、停止予約の再キュー、Session境界、DM再オープンを別Agentレビューで再確認し、P0/P1の残存なしと判定した。
- 完了済みWorkの返信を画面が無効化していたため、停止・結果不明・権限なし以外は返信可能に修正した。隔離Electron画面の同一Work返信とfocused testで再確認した。
- 画面の明示委譲は、Renderer・Electron main・browser bridgeで、`parent_assignee_id`が省略された公開応答を不正扱いしていた。Work/Agent/子Assignmentを必須照合し、親IDが返る場合だけ一致確認するよう統一した。異常な親・子の応答を拒否する回帰testを追加した。初回の再検証で古い`apps/desktop/dist`を起動していたため、Desktop bundleを再生成してから上記の実画面再確認を行った。

## 未検証範囲

- Hostedは利用者の指示により未実施。
- 公式Codex / Claude Codeの本人認証済み実行、停止、native session resume、late terminal evidenceは、現時点でサブスクリプション未契約のため、利用者が後続フェーズで行う実機確認へ延期した。
- 画面の主観的な使い勝手の評価は、必要なユーザーインターフェース整理を後続フェーズで行う前提で、利用者の操作確認へ延期した。

これらを今回の技術検証の成功扱いにはしていない。E2EデータとDesktop profileはリポジトリ外に隔離し、本番環境と既存データを触っていない。
