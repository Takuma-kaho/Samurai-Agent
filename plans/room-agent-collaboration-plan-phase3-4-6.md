# Room・Agent共同作業 実装プラン — Phase 3・4・6

- 作成日: 2026-09-05
- 状態: 実装前の計画。製品方針は会話で合意済み。下記の技術選定は今回の具体化であり、コード実装・実Agent検証は未実施
- 調査基準: main `89844b8b9ed2a43c7cc023ed50c1852ed7d708cb`
- 対象: 元のNative AppロードマップのPhase 3（Room UI）、Phase 4（Samurai Native・外部実Agent接続）、Phase 6（Team Agent）
- 読みやすい別資料: [非エンジニア向けプラン](room-agent-collaboration-overview-plan-phase3-4-6.md)

## 1. 目的・背景

Roomを開いて依頼すると、既定Agentが仕事を進め、必要な専門Agentへ委譲する。一人で成立するAgent操作の体験を基本に、複数人がその仕事へコメント・提案できるようにする。人間が仕事全体と個々の担当を止め、指示を変更できることを完成条件に含める。

今回の主画面はAgentへの依頼・追加指示・結果である。人間同士の相談は仕事ごとのコメント欄で扱い、明示的な「Agentに反映」でだけ実行へ渡す。以前の、人間の通常会話を中央に置くUI案は今回の実装基準にしない。

Phase 3・4・6を同じリリース範囲として実装する。工程上の依存関係は分けるが、Phase 6を将来実装へ送らない。

## 2. 禁止事項

- 合意済みの製品方針、要件、Phase、完成条件を独自に変更・省略しない。
- 専門AgentのUIだけを作り、実際には単一Agentの文章で演出する実装にしない。
- コメント、いいね、メンションの文字列だけでAgentを起動・承認しない。
- Sessionの選択・作成を通常操作やClientの送信前提として残さない。
- プロンプトだけで権限、停止、ファイル分離を実現したと扱わない。
- 参照OSSの製品概念・UI・保存方式をそのまま移植しない。
- テスト専用の分岐、静的な成功表示、既存テストの弱体化で完成条件を満たしたことにしない。
- 合意外のVM発行、課金、外部Client製品化、学習系の再設計へ範囲を広げない。
- 既存差分を取り込んだり消したりしない。現在ある`reports/phase3-4-6-room-bot-ui-prototype/`は別のUI試行記録として保つ。
- branch作成、commit、push、PR作成は、この文書の作成依頼だけを根拠に実行しない。
- 未実行・失敗・skipを検証成功と扱わない。重い検証は必要な段階でまとめ、同じ条件で目的なく繰り返さない。

## 3. 正本と確定事項

### 3.1 参照する文書

1. [PRODUCT.md](../PRODUCT.md) / [ARCHITECTURE.md](../ARCHITECTURE.md)
2. [RoomとAgentの共同作業設計](../docs/designs/room-agent-work.md)
3. [Agent Backend設計](../docs/designs/agent-backends.md)
4. [Native App設計](../docs/designs/native-app.md)
5. [Organization設計](../docs/designs/organization.md)

本書のPhase番号は元のNative Appロードマップを指す。[Workspace-first・Organization再設計プラン](workspace-first-organization-realignment-master-plan.md)内のPhase 3・4・6とは別であり、同プランの番号や完了判定は変更しない。

### 3.2 会話で確定した製品仕様

| 項目 | 確定事項 |
| --- | --- |
| 基本体験 | Agentへの仕事の依頼を中心にし、その仕事へ複数人が参加する |
| Room | 継続する文脈・権限の境界。Sessionは内部参照 |
| 既定Agent | Roomごとに一つ。Room作成時に既存から選択、または新規作成 |
| 専門Agent | Workspaceに登録した安定したBot。明示指名と既定Agentからの自動委譲に対応 |
| 人間の会話 | 仕事ごとのコメント欄。明示反映までAgentの指示にしない |
| 制御 | 依頼者とRoom Owner / Adminが既存の仕事を制御。他のメンバーはコメントで提案できる |
| 複数人 | 新しい依頼は別の仕事。同じ仕事への追加指示は返信先を指定する |
| 介入 | 仕事全体・個別担当の停止、追加指示、担当変更、現在の作業と結果の可視化 |
| 必須画面 | Agent一覧・選択・作成・編集、Room作成、AgentとのDM |
| 必須Backend | Samurai Native、Codex、Claude Code。NativeはGemini・OpenAI・Anthropicなど複数providerを選択できる |
| 認証 | NativeはproviderのAPIキー。Codex / Claude Codeは本人の公式ログインによるサブスク利用を基本とし、APIキーにも対応。サブスク資格情報をNativeへ流用しない |
| 実機検証の担当 | 実装担当はNativeと以前共有されたGemini APIキーの無料枠を使用。Codex / Claude Codeの実機連携は利用者が検証し、その結果で確認完了を判断する |
| 将来の考慮 | Computer Useの実行先・画面への接続点を残す。VM・ライブ画面は今回は実装しない |
| UI評価 | 利用者が実際に触り、依頼・コメント・介入の分かりやすさを評価する |

### 3.3 このプランで具体化する技術選定

- 既存の`SamuraiNativeBackend`・provider接続、構造化CLIアダプターと`AgentBackend`を拡張する。ACPは追加アダプターの候補とし、導入自体をPhase 4の完成条件にはしない。
- 仕事は既存の`ObjectiveRecord`を集約の基礎、`WorkItemRecord`を担当作業の基礎として拡張する。利用者にObjectiveや計画の入力フォームを要求しない。
- 人間の仕事に必要な依頼者・Agent・指示・コメント・制御のメタデータを追加し、学習最適化の仕事と種類で分離する。独立した二つ目の実行状態の正本は作らない。
- Agent DMは通常のRoom認可を使う非公開Roomとして保存する。
- 実行中に追加指示を送れないBackendでは、停止確認後に新しいRunで継続する。
- 書込み範囲を保証できない外部CLIは実行ディレクトリ単位で排他する。分離できる作業は並行実行する。

これらはコード調査から選んだ実装方針であり、既に動作確認済みという意味ではない。製品の意味を変える必要が生じた場合は、その差分を示して利用者に確認する。通常のファイル分割・型・内部設定値は実装者が責務に従って決める。

## 4. 現状の実装と不足

以下は上記commitのソースを読んで確認した事実であり、今回テストを実行した結果ではない。

| 責務 | 確認した入口・実装 | 既にあるもの / 不足 |
| --- | --- | --- |
| Room / Agentモデル | `packages/core-schemas/src/index.ts`、`packages/runtime/src/commands/services/room-agent-domain-service.ts` | Agentの名前・役割・指示・Backend、Room参加権限がある。Roomの明示的な既定AgentとDM種別は追加が必要 |
| PostgreSQL | `packages/workspace-server/src/schema.ts`、`workspace-server-commands.ts`、`workspace-server-store.ts`（同ディレクトリ） | Agent正本とRoomごとのview / edit / executeがある。仕事・コメント・割当・制御の一般用途の永続化を追加する |
| Room管理者の継承 | `packages/workspace-server/src/schema.ts`の最新の`samurai_room_role`定義（migration 23） | Workspace Owner / AdminをRoom roleとして返す。DMの通常閲覧ではこの継承を使わない条件が必要。仕事の制御者判定も明示的なRoom roleと区別する |
| 公開Domain API | `packages/domain-api/src/index.ts`、`apps/server/src/workspace-server/domain-api-v1.ts` | `/api/v1`、operation ID、公開結果がある。仕事の開始・返信・コメント・制御とRoom設定の契約が不足 |
| Native App | `apps/web/src/native-app/NativeApp.tsx`、`use-native-app.ts`、`types.ts` | Roomを開く際にSessionを一覧・作成し、送信もSession IDに依存する。Roomと仕事を指定する経路へ変更が必要 |
| HTTPと実行 | `apps/server/src/workspace-server/http-server.ts`、`apps/server/src/adapters/runtime/postgres-chat-domain-operation.ts` | 既存Room向けmessages経路もSessionを作成して実行する。通常のRoom操作ではServer内部で継続参照を解決する必要がある |
| Agent解決 | `apps/server/src/adapters/runtime/postgres-runtime-chat.ts`の`resolveAgent` | 未指名時は実行可能Agentの作成順で選ぶ。正本のrole / instructionsではなく固定role / descriptionから入力を作る。既定Agentと正本フィールド・版の参照へ修正する |
| Backend | `packages/agent-backends/src/contract.ts`、`codex.ts`、`claude-code.ts`、`external-cli.ts` | Registry、run、エンジン固有の継続、stream、cancel、tool bridgeの土台がある。仕事・担当ごとの関連付け、実証と制御の補強が必要 |
| Samurai Native / provider | `packages/runtime/src/backend/native-backend.ts`・`provider.ts`、`packages/runtime/src/provider-profiles.ts`・`agent-runtime.ts` | Nativeと複数providerのAPI接続がRegistryにある。外部Sessionのresumeは非対応で、保存済み文脈による継続、Hostのツール実行、今回の委譲・制御とprovider選択を接続する |
| CLI停止 | `packages/agent-backends/src/process-runner.ts`、`external-cli.ts`、`postgres-runtime-chat.ts` | cancelはabort要求を返す。Runtimeはその場で証拠がなければ結果不明へ確定し得る。要求中・期限付き待機・遅延証拠・子プロセスを扱う必要がある |
| Run Control | `apps/server/src/workspace-server/run-control-service.ts` | 個々のRunの制御・replayがある。依頼者 / Room管理者による仕事全体と子孫の制御は追加が必要 |
| 仕事の部品 | `packages/runtime/src/execution/durable-work-coordinator.ts`、`work-state-machine.ts` | Objective / WorkItem / 依存関係がある。steerは指示文字列の保存であり、実行中の配送証拠ではない。cancelも実行の停止確定より先に状態を変えるため、そのまま全体停止に使えない |
| 既存worker | `apps/server/src/workers/postgres-skill-optimization-worker.ts` | 学習最適化用の取得・実行経路。今回の人間の仕事をこのキューの対象へ混在させない |
| 実行先 | `apps/server/src/adapters/runtime/agent-worktree.ts`、`postgres-runtime-chat.ts` | 実行ディレクトリ分離の土台はあるが、複数担当の書込み排他・Room間OS隔離を証明するものではない |
| 移植 | `packages/workspace-server/src/workspace-completion-bundle-v4.ts`、`workspace-bundle-v3.ts` | export / restoreとID対応付けがある。追加する仕事・既定Agent・コメント・DMの保存対応が必要 |

既存テストの起点は、`packages/agent-backends/src/agent-backends.test.ts`、`packages/runtime/src/native-backend.test.ts`、`packages/runtime/src/backend-event-bridge.test.ts`、`packages/runtime/src/execution/backend-event-journal.test.ts`、`packages/workspace-server/src/workspace-server-store.test.ts`、`workspace-server-commands.test.ts`、各Bundleのtest、`apps/server/src/workspace-server/run-control-service.test.ts`、`apps/web/src/native-app/use-native-app.test.ts`とする。関連するDomain OperationとRoom認可のtestも再利用する。

以前のUI試行は操作感を検討するmockであり、今回の方向性や実Agent連携の完成証拠にしない。

## 5. 対象・対象外

対象は、Roomと仕事を起点にした公開契約・永続化、既定AgentとDM、三つの実Backendとprovider・認証方式の選択、複数担当の制御、Native Appの一連の画面、移行・再接続・復旧・移植への対応である。既存Approval Lifecycleと学習入口は、今回の指示・権限・イベント種別を正しく扱うために必要な範囲だけ修正する。

後続の対象は、Phase 7の本格的なArtifact / Surface編集UI、Phase 8の学習・評価高度化、Phase 9の外部Client / A2A製品化、Phase 10の専用Compute・配布である。既存ファイルの添付・結果表示と、今回の委譲に必要なMCP tool bridgeは現在の対象に含む。

React / Electronの既存基盤を利用する。Phase 5の移行全体を再実施したり、Organization・Server移転の製品仕様を変更したりしない。

## 6. 守る設計境界

1. Workspace targetは`connection_id + workspace_id`。全てのRoom・仕事・購読・操作を対象Serverで再認可する。
2. 人格・役割・指示はAgentの正本、権限はCore、実行はRuntime、推論はBackendが担当する。
3. 仕事はRoomに所属する。依頼者・管理者の制御は保存済みIDと現在のMembershipで判定し、Clientやモデルが指定したactorを信頼しない。
4. Roomの既定Agentは一つ。実行不能時の暗黙の差替えをしない。既定変更と進行中の担当変更は別操作にする。
5. コメントと指示を別の型・永続化・公開操作で扱う。未反映コメントをRunの文脈や自動学習の指示へ流さない。
6. 停止要求と終端証拠を分ける。停止受付と子作業の起動許可が同じ世代・ロックを参照する。
7. DB確定前に外部実行しない。lease切れ・通信断だけで副作用を再実行しない。
8. PostgreSQLに関係・認可・履歴、configured storage rootに本文を保持する。新しいローカルDBを導入しない。
9. Backend SessionをRoom・仕事・Agent間で共用しない。プロセス・ファイル・資格情報の境界をRoom認可と混同しない。
10. Clientは保存済み状態の投影を表示する。表示のためにAgent実行や制御の正本を二重に持たない。

## 7. 要件と工程の対応

| ID | 要件 | 担当Phase | 主な完成証拠 |
| --- | --- | --- | --- |
| R01 | Roomで継続しSessionを管理させない | 3 + 4 | Session IDを渡さない公開APIとNative App、再起動後の同じ履歴 |
| R02 | 既定Agentを選択 / 新規作成してRoomを作る | 3 + 6 | 一意性・原子的作成・既存Roomの設定導線 |
| R03 | Agent一覧・編集・選択・DM | 3 + 6 | 実設定での起動、別Account / 別Roomの非公開性、選択結果だけの共有 |
| R04 | Native / Codex / Claude Codeの選択・認証・実行・継続・承認 | 4 | Native + Geminiは実装担当、Codex / Claude Codeは利用者による能力・認証方式・実ファイル・Activityの記録。Nativeの他provider選択は契約検証と実API未検証を区別する |
| R05 | 明示指名・自動委譲・専門Agentの実作業 | 6 | 実装担当は複数のNative Agent、利用者は異なるBackendを使う複数Agentの担当・依存・結果を確認する |
| R06 | 新しい依頼と同じ仕事への返信 | 3 + 6 | 仕事の紐付け、指示版、過去の結果保存 |
| R07 | コメント・いいね・添付・明示反映 | 3 + 6 | 投稿だけではRunが増えず、反映時の選択内容と操作者が追跡できる |
| R08 | 依頼者とRoom管理者の制御 | 3 + 6 | 他人の操作拒否、権限取消、認証された操作者の監査 |
| R09 | 全体停止・個別停止・指示変更・担当変更 | 4 + 6 | 子孫の停止証拠、開始競合、旧Runの遅延応答、反映状態 |
| R10 | 並行作業と書込み競合 | 4 + 6 | 分離した作業は並行、共通の書込み先は待機・競合表示 |
| R11 | 再送・再接続・Server再起動・結果不明 | 3 + 4 + 6 | 操作の一意性、Event replay、重複実行せず復旧確認へ進める |
| R12 | 保存・migration・export / restore | 3 + 6 | 実PostgreSQLの新規 / 既存DB、関連IDとDM権限の復元 |
| R13 | 操作感と実環境の完成確認 | 3 + 4 + 6 | Native Appの技術E2E、利用者のdogfooding、未検証の区別 |

実装順序は、共通データと契約（Phase 3・6）→ 実Backend（Phase 4）→ 委譲と制御（Phase 6）→ 画面の完成（Phase 3・6）→ 統合確認とする。途中の部品完成をPhase全体の完成と扱わない。

## 8. Phase別の実装内容

### 8.1 着手時の基準確認

対象フォルダのAGENTSを読み、HEADと既存差分を取り直す。本書のソース表と差分がある場合は担当箇所だけを確認して計画を更新する。関係のない全リポジトリ再調査は行わない。

第9節の参照OSSの対象コードを理解し、API / DB / Runtime / UIの担当を整理する。並列実装を行う場合はファイル所有を分け、共有型・migration・公開契約の担当を一つにする。コード実装開始やGit操作の許可は、その時点の利用者の指示に従う。

### 8.2 Phase 3 — Roomと仕事の公開契約・Native App

**目的:** 既定Agentとの仕事をRoomから直接扱い、Sessionを利用者と通常のClient操作から隠す。

**変更対象:** `packages/core-schemas/src/index.ts`、`packages/domain-api/src/index.ts`、`packages/domain-operations/src/operations/room/`・`agent/`・`chat/`、`apps/server/src/workspace-server/domain-api-v1.ts`・`http-server.ts`、`packages/workspace-server/src/schema.ts`・store / commands、`apps/web/src/native-app/`、`apps/web/src/lib/workspace-browser-bridge.ts`。新しい仕事用Query / Domain Operation・UI部品は、これら既存責務の配下へ追加する。新規ファイル名は実装時に確定する。

**実装内容:**

1. Roomの既定Agent参照・設定版・DM種別を追加し、同一Workspace内の参照制約を持たせる。既存Agent選択と新規Agent作成をRoom作成操作へ組み込む。失敗・再送でも半端なRoomやAgentを残さない。
2. 通常UI向けの契約をRoom IDと仕事IDに揃える。必要な操作は、仕事一覧・詳細・作成・返信、コメント投稿・選択反映、既定Agent設定、DMを開く操作、仕事と担当の制御である。新規操作名の案は`room.work.*`、`room.default_agent.set`、`agent.dm.open`とし、既存実装済みの名前と誤認させない。
3. 全て同じ`/api/v1`のQuery / Domain Operation / Run Control責務へ接続する。Roomの専門Agent追加・解除・権限設定に必要な既存操作も公開契約へ接続する。Zodの入力・結果、operation catalog、公開allowlist、認証context、公開Event、生成clientと台帳を一緒に更新する。UI専用の無認可ショートカットを作らない。
4. Roomの履歴を仕事・メッセージ・Activityから取得できるようにする。旧Sessionの履歴はRoomの下で参照できる投影を用意し、元IDと順序を保存する。旧履歴に依頼者・担当を推測で付け足さない。不明な旧実行は制御可能と表示しない。
5. Server内部で仕事と担当に対応する継続参照を解決する。`use-native-app.ts`のSession一覧・作成・`ensureSession`への通常送信依存を取り除く。通常の公開catalog / 生成Clientから`session.create`とSession入力必須の`chat.turn.run`を外し、Room / 仕事の契約では`session_id`を受理しない。旧入口は非推奨の互換契約として明示して維持し、旧IDをServerで認可済みRoom・仕事へ解決して同じ処理を通す。互換経路による仕事制御の迂回を許さず、既存履歴は破壊しない。
6. 中央Chat、仕事の返信対象表示、担当一覧、仕事全体 / 個別停止、コメント欄、明示反映と添付を実APIへつなぐ。Agent一覧・編集・Room作成・DMも同じ契約を利用する。Backend・provider選択と公式ログイン / APIキー設定への導線を接続する。Room設定には専門Agentの追加・解除・閲覧 / 編集 / 実行権限と既定Agent変更を置く。
7. Workspace / Room切替で旧購読と操作の表示先を破棄する。Event cursor・仕事の版・操作IDで再接続と重複を処理し、別Roomへの遅延イベントを表示しない。
8. keyboard操作、入力欄の名前、返信先・DM公開範囲、狭い画面のコメント欄を整える。未送信の入力を競合や一時切断で捨てない。

**migrationと移植:** 既存Roomは既定Agent未設定を許す移行状態として読み取る。履歴は利用でき、実行前に管理者が選択する。作成順先頭のAgentを自動で固定しない。追加migrationを使い、適用済みmigrationを書き換えない。Bundleの契約・検証・ID対応付けへ既定AgentとDMを含め、古いBundleを読める経路も確認する。

**検証:** Room作成の途中失敗 / 再送、既定Agentの無効化、他WorkspaceのAgent拒否、Room履歴の順序、Session不要の公開APIをfocused testと実PGで確認する。通常catalog / SDKにSession入力がないことと、旧互換APIから新しい認可・制御を迂回できないことも確認する。Native Appでは依頼・返信・コメント・DM、切替中の遅延応答をComponent / 統合テストで確認する。

**セルフレビュー:** 見た目からSessionを消しただけになっていないか。コメントが普通のchat送信へ接続されていないか。既定Agentを実行時に先頭検索で選んでいないか。DMを通常Roomの一覧権限だけで公開していないか。

**完了ゲート:** R01・R02・R03・R06・R07のUI / API / DB経路が成立し、Phase 4・6の実処理につながっていること。途中の画面mockは作業用とし、Phase 4・6の完成までPhase 3の統合完了とはしない。

### 8.3 Phase 4 — Samurai Native / Codex / Claude Codeの接続・制御

**目的:** 三つの実エンジンで同じ仕事の依頼・継続・停止・承認と復旧を扱う。元のPhase 4へNativeとprovider選択を追加し、外部連携の実機検証は利用者担当へ変更する。Phase番号とR04・R05の対応は維持する。

**変更対象:** `packages/runtime/src/backend/native-backend.ts`・`provider.ts`、`packages/runtime/src/provider-profiles.ts`・`agent-runtime.ts`、`packages/agent-backends/src/contract.ts`・`codex.ts`・`claude-code.ts`・`external-cli.ts`・`process-runner.ts`、`apps/server/src/adapters/runtime/postgres-runtime-chat.ts`・`agent-worktree.ts`、`apps/server/src/workspace-server/run-control-service.ts`、既存のBackend Event journal / tool bridge / Approval Lifecycleの接続箇所。

**実装内容:**

1. Nativeのprovider / APIキー選択と、外部CLIの公式サブスク認証 / APIキー利用を既存接続へ結び付け、能力表を作る。構造化stream、継続、停止の証拠、実行中の追加入力、承認待ち、ファイル・ツールの制限を、実装有無と実証有無に分ける。CLIのバージョン・実行場所・実機証拠は利用者の確認結果を記録する。
2. Agentの正本role / instructions / enabled / backendと設定版を実行入力へ結び付ける。Roomの既定Agentまたは明示された担当Agentを使用し、無権限・無効・Backend不一致を起動前に拒否する。
3. 継続参照をWorkspace・Room・仕事・担当Agent・Backend・世代で分離する。同じAgentの別仕事やDMへ外部Sessionを共用しない。同一継続参照の同時実行を防ぐ。
4. cancel受付からAPI呼出し・プロセス・ツールの終端までの状態を分ける。期限付きの確認待ちと、遅延した終端証拠の追記・再照合を実装する。DBで結果不明を記録した後も、履歴を消さずに確認結果を反映できるようにする。
5. 子プロセスを含む停止範囲を実行先で確認する。制御できない外部処理を停止成功として報告しない。確認できた終了理由と、未確認の副作用を分ける。
6. 追加指示はBackend能力に従って配送する。実行中入力が非対応なら、対象の受付を閉じ、停止確認後に新しいRunで継続する。外部CLIはエンジン固有の継続、Nativeは保存済み文脈からの再構成を使う。継続不能時は確定した履歴からの再構成を明示し、結果不明の副作用を再試行しない。
7. MCP tool bridgeとNativeのHost / Runtimeツール実行を、仕事・担当・元の依頼者に限定した認証contextへ結び付ける。専門Agentへの委譲操作も同じ認可済みDomain Operationを通し、モデルが別のjob / actorを指定しても権限が広がらないようにする。
8. 既存Approval LifecycleとBackendの入力待ちを結び付け、対象操作・Run・期限・一回限りの応答を照合する。承認の偽装、停止後・旧Runへの応答を拒否する。
9. 実行先のファイル・ツール・資格情報の境界を確認する。制約を実現できない設定は利用不能として示し、全許可やServerのsecret共有へfallbackしない。

**技術上の判定:** 必須能力がCLIで満たせない場合は、既存Backend契約内の別transport・ACP等を限定調査する。その場合も、人間の操作と完成条件を下げない。新しい製品要件や配置先の契約が必要になる差分は利用者へ提示する。

**検証:** Backendの構造化イベント・引数・認証方式の選択・不正入力・遅延終端は既存focused testを拡張する。実装担当はNative + Gemini APIの無料枠で初回実行、継続、停止、承認、失敗、Server再起動を確認する。Codex / Claude Codeのサブスク / API利用と各制御の実機検証は利用者が行う。実装担当は実CLIを起動せず、mock / fixture / fake CLIで接続契約や事故経路を確認する。それらやNativeの成功を実CLIの証拠にしない。

**セルフレビュー:** cancelの受付だけで停止済みにしていないか。新しい指示の保存を反映済みにしていないか。Agent設定の変更やRoom変更で古いprovider Sessionを使っていないか。Backendが任意のCore操作や認可外ファイルへ到達できないか。

**完了ゲート:** R04、およびR09・R10・R11を支えるNative + Geminiの実装担当の実証と、Codex / Claude Codeの利用者の実証があること。外部連携は利用者確認待ちとして引き渡せるが、その結果が揃うまでPhase 4全体の確認完了とはしない。少なくともPhase 6の割当・停止APIと接続してから統合完了とする。

### 8.4 Phase 6 — 複数Agentの割当・人間の介入

**目的:** 既定Agentが必要な専門Agentへ委譲し、人間が仕事全体と担当作業を制御する。

**変更対象:** `packages/core-schemas/src/index.ts`のObjective / WorkItem、`packages/runtime/src/execution/durable-work-coordinator.ts`・`work-state-machine.ts`、`packages/runtime/src/commands/services/room-agent-domain-service.ts`、既存`work_item`操作、`packages/workspace-server/src/schema.ts`・store、Serverのworker責務、Phase 3で定義する公開操作とUI、Bundle V4と互換読取り。

**データの具体化:**

- 人間の仕事はObjectiveの一種類として扱い、仕事IDとObjective IDを一対一にする。依頼者・窓口Agent・指示版・制御の世代をメタデータとして保持する。UI用の仕事状態はこの集約から一貫して投影し、別のschedulerを正本にしない。
- WorkItemには担当Agent・設定版、親担当、適用指示版、試行と現在のRunを結び付ける。依存関係は同じ仕事内に限定し、循環を拒否する。
- 停止要求中・未確認、指示の受付・配送・反映を別の制御記録で扱う。既存のObjective / WorkItemを先にcancelledにして停止完了と見なす経路を、人間の仕事では使わない。
- コメント・反応・反映スナップショットを仕事へ紐付ける。既存の学習最適化用テーブルを人間の仕事用へ流用しない。既存の種類不明データは互換読取りとし、新しいworkerが取得しない。

**通常依頼からの決定的な変換:** 新しい仕事の作成handlerが、認可済みの依頼から以下を組み立て、同じPostgreSQLトランザクションでObjective・メタデータ・最初のWorkItem・指示・起動予約を保存する。既存の`objective.create`と`work_item.create`を別々のHTTP呼出しとして連鎖させない。

| 内部項目 | 通常依頼からの値 |
| --- | --- |
| Objective ID / 仕事ID | Serverが発行し、操作IDで一意に対応付ける。同じ送信の再送で新しいIDを作らない |
| `room_id` | 認証contextから再認可した対象Room |
| `objective` | 依頼本文。本文のない添付のみの依頼は固定文「添付資料を確認して回答する」と認可済み添付参照を用いる |
| `title` | `objective`の空白を正規化した先頭80文字。モデルによる追加生成を必須にしない |
| `completion_criteria` | 通常の会話用に固定した一件「依頼への回答と実行結果を記録する」を保存する。業務上の成功を勝手に定義するものではない |
| 最初のWorkItem | 同じObjective / Room、選定済み担当Agent、最初の指示版、`attempt=0`、内部priorityの既定値、有限のRuntime設定を使用 |
| `instruction` | 上記の依頼本文と構造化した添付参照。後続の返信は同じ仕事の新しい指示版へ保存する |
| 取得対象 | 人間の仕事である種類を明示する。学習最適化の保存先・workerへ渡さない |

本文も添付もない送信は入力エラーにする。内部の固定条件だけで仕事を完了にせず、全担当・指示・承認・停止確認の集約条件を併用する。業務成果の正しさは利用者が確認できる形で残す。

**実装内容:**

1. 一つの依頼から仕事と最初の担当を原子的に作成する。Objectiveの内部条件を作るために、追加の利用者入力や自律的な目標拡張を要求しない。回答の終了と、利用者による成果の評価は分ける。
2. 仕事用のPostgreSQL保存とworker取得を実装する。対象の種類、起動予約、lease、世代を確認し、二つのworkerが同じRunを始めないようにする。学習最適化workerとの取得対象を分離する。
3. 明示指名・複数指名・自動委譲を同じ割当処理へ接続する。対象はRoomで実行可能な登録済みAgentだけとし、依頼者の現在の権限を引き継ぐ。
4. 委譲先には必要な指示・資料と元の仕事参照を渡し、受付IDを非同期に返す。結果待ちの親は継続点を保存し、子を妨げる書込み排他は親の実行が資源を使っていない証拠を得てから解放する。子の結果を永続化し、依存条件・指示版・停止世代を確認して親の継続を一度だけ予約する。既定Agentは必要な結果を取りまとめる。担当の失敗や結果不足を取りまとめの文章で成功へ変換しない。仕事の完了判定は、全担当の確定、起動・待機中の担当がないこと、未反映指示・承認・停止確認がないことを同じ集約で確認する。
5. finiteな同時実行数・深度・総担当数・実行時間の上限をRuntime設定として設ける。予算や権限の拡大、永続Botの新規登録は自動委譲の範囲に含めない。停止した担当の自動置換も行わない。
6. 仕事全体の停止は、同じDBロックで受付を閉じて世代を進め、未開始を取り消し、起動済みの全担当・子孫へ停止を要求する。個別停止もその子孫と依存待機を扱う。全ての終端を確認してから停止済みにする。
7. 指示変更は期待する版と比較し、影響する担当の反映を追跡する。担当変更では旧Runの終端を待ち、新しい割当とRunを作る。人間の停止と競合したら、継続を優先しない。
8. 依頼者とRoom Owner / Adminによる制御をServerで強制する。管理者判定には現在の明示的なRoom Membershipを使い、Workspace管理者から継承したroleだけで仕事の制御を許可しない。新旧のRun Control入口で同じ判定を使う。停止は、現在もRoom参加者である依頼者に新しいexecute grantを要求せず許可できるよう、実行開始の認可と分ける。Membership取消時は内部処理で停止と証拠回収を行う。
9. 書込み先の排他を、実行開始から終端・反映確定まで保持する。lease期限が来ても古い実行が生きている可能性があれば新しいwriterを開始しない。別の仕事同士も同じ実行先に対する競合確認を通す。
10. コメントの選択反映を、権限・本文の版・対象仕事・添付の到達可能性を確認した追加指示として保存する。未反映のコメントやいいねをRunのcontext / 学習指示へ含めない。
11. DMを本人と相手Agentの非公開Roomとして作成し、重複作成を防ぐ。最新のRoom role解決を追加migrationで拡張し、DMだけはWorkspace Owner / Adminの継承を使わず、本人の明示的Membershipを必須にする。純粋な認可判定とSQL RLS、一覧・検索・Event・添付APIにも同じ条件を通す。DMへの人間追加や管理者自身への所有者復旧を拒否し、本人の同一Accountへの復旧条件を確認する。結果共有では選択内容だけを共有先へ渡し、元DMのACLや全文を公開しない。管理用Bundle / Server運用権限の境界は共同作業設計に従い、通常のDM閲覧と混同しない。
12. 仕事の起動予約と公開Eventを永続化し、再起動時は停止要求を先に回収する。未知の実行を自動で二重起動せず、復旧確認と最後の証拠を示す。
13. Bundleへ新しい記録を追加し、仕事・担当・Agent・コメント・資料のIDを対応付ける。復元した実行中の仕事を自動再起動しない。Backend資格情報を含めず、接続未設定でも履歴を開けるようにする。

**検証:** 認可、依存関係、深度・同時実行上限、二重取得、停止と委譲の競合、未確認停止、指示変更と停止の競合、担当変更後の遅延結果、同一書込み先、親子の資源待ちと結果通知の重複、DMとBundle復元をfocused / 実PGで検証する。実装担当は複数のNative Agentで委譲と停止を統合E2E確認し、実Backendの混在は利用者が実機確認する。

**セルフレビュー:** 既存の学習workerへ人間の仕事が混入していないか。親だけ終了して子が残らないか。新しい担当へ古い結果が混ざらないか。コメントを選択した時と反映した時の内容が一致するか。認可取消後もtool bridgeや復旧処理が新しい実行を許可しないか。

**完了ゲート:** R05・R08・R09・R10・R12を満たし、Phase 3の画面とPhase 4の実Backendから操作できること。担当一覧の表示だけでは完了にしない。

## 9. 品質上の注意点・参照OSS

参照日は2026-09-05。以下の参照先は可変のmain / 公式文書であり、実装着手時に対象箇所と使用するrevisionを記録する。市場評価や競合の機能一覧は完成条件に用いない。

| 参照 | 確認した作り方 | Samuraiへの適用 |
| --- | --- | --- |
| [OpenClaw chat handler](https://github.com/openclaw/openclaw/blob/main/src/gateway/server-methods/chat.ts)の`chat.inject` | 入力検証、対象Agent照合、実行受付の排他内でSessionの同一性と使用可否を再確認してから保存・通知する | 仕事の停止・担当変更と開始が同じ世代を参照する。Sessionを製品UIの中心にする設計は採用しない |
| [OpenClaw Sub-agentsのStopping](https://docs.openclaw.ai/tools/subagents#stopping) | 親に紐づく子の停止範囲、未完了の取消を区別する | SamuraiではRoom権限と依頼者を再認可し、仕事単位で全担当の終端証拠を集約する |
| [Buzz ACP harness](https://github.com/block/buzz/blob/main/crates/buzz-acp/README.md) | 外部ハーネス接続、チャネル単位の実行待ちと再接続を分ける | 接続方式と実行制御の責務を分ける参考に限定する。Nostr・メンション起動・同一チャンネルの人間会話を移植しない |

注意する実装上の失敗は、Clientの表示だけによるSession内部化、通常チャットへのコメント混入、停止要求だけの成功表示、全許可の実行設定、二重の仕事状態、学習用workerの安易な流用、試行が変わっても同じwriterを再開することである。

変更は責務ごとに分ける。巨大な`use-native-app.ts`や`postgres-runtime-chat.ts`へ全ての仕事管理を追加せず、仕事・コメント・制御の状態と実行の境界を分離する。新しい汎用フレームワークを作るための抽象化は追加しない。

## 10. レビューと検証

### 10.1 実施する検証

次のcommandは作成時の`package.json`とCIで存在を確認した。新しい専用commandが必要な場合は、script本体と同時に追加し、未作成の名前で実行済みと報告しない。

| 検証 | 理由と範囲 | 時期・方法 | 成功条件 / 実施できない場合 |
| --- | --- | --- | --- |
| 文書・差分 | 正本との用語、設計と工程、リンク、Mermaid | 文書確定時と最終の`git diff --check`。新規ファイルも検査 | 不整合・リンク切れ・図の構文エラーがない。実装の証拠とは分ける |
| Source quality / 型 | 共通schema、公開API、React、Backendの接続 | 型変更時に対象packageのtypecheck。Phase単位で`pnpm verify:source-quality`、対象lint | 対象の失敗がゼロ。既存失敗は別記し影響を確認する |
| Domain契約と生成物 | 新しい操作と公開結果、台帳の漏れ | `pnpm core:domain-contracts:verify`、`pnpm phase01:verify`。必要な生成は既存`phase01:ledger` / `phase01:spec`と定義側から行う | 生成物を手書きせず、入力・結果・操作と公開台帳が一致する |
| Focused test | 状態遷移・認可・replay・UIの意味 | Phaseごとに`pnpm exec vitest run <関連する実在test>` | R01–R12の正常系と事故経路を確認する。実CLI・実PGの代替にしない |
| 実PostgreSQL | RLS、migration、競合、lease、Bundle | 専用DBで`pnpm verify:postgres-migration:static`に加え`pnpm verify:postgres-deep`と今回の新規ケース | 新規DBと既存DB移行、異なるAccount、同時操作、復元で不変条件が成立。DBなしは未検証 |
| 実Native + Gemini | API実行・継続・停止・承認・複数Agent・実行先 | 実装担当が以前共有されたGemini APIキーの無料枠を使い、10.2を実施する。検証設定はGeminiに固定し他providerへのfallbackを無効にする | provider・modelと実ファイル・Activityの証拠が揃う。キー本文は記録しない。他providerの実API利用を確認済みにしない |
| 実Codex / Claude Code | 公式サブスク認証 / API利用、CLI制御、混在委譲 | 利用者が専用実行先で実機確認する。既存の`pnpm backend:external:verify`と10.2を確認手順に利用する | 両CLIのバージョン・認証方式・制御の証拠が揃う。利用者の結果がない項目は確認待ち |
| Native App Build / E2E | 本物の画面からAPI・DB・Agent・ファイルへ通す | `pnpm desktop:build` / `pnpm desktop:verify`後、macOS Electronで10.2の操作を行う | API mockなしで全経路が成立。Browserだけの確認はNative確認と分ける |
| 既存CI | 契約・OS差・全体回帰 | `.github/workflows/ci.yml`の既存3OS契約、Linux全体検証、実PG等 | 実行済み結果を確認。3OS unitを3OS Native E2Eと呼ばない |
| 利用者の操作確認 | 依頼と相談の区別、停止と指示変更の感覚 | 技術E2E後に利用者が操作する | 所感に基づく修正を反映する。本人未確認は明記する |

実装担当は`backend:external:verify`による実CLI検証や`.github/workflows/manual-external-e2e.yml`を起動しない。これらは利用者が既存の明示opt-inに従って実施する外部連携の確認手段であり、通常CIだけで実Agentの完成証拠が揃うとは判断しない。

全体lint・typecheck・test・Web / Desktop buildの重い重複は既存CIを基本とし、手元では変更範囲の検証と実環境確認を行う。新しい依存や認証方式を追加する場合だけ、その差分に対するaudit・失効確認を追加する。関係のない負荷試験や全OSのGUI確認をこの計画へ増やさない。

### 10.2 統合E2Eシナリオ

本番データと分けたWorkspace・Account・DB・ファイル保存先で行う。最低限、依頼者、別メンバー、Room管理者の三つの役割を区別して確認する。

実装担当は以下をNative + Gemini APIの無料枠で実施する。利用者はCodex / Claude Codeの公式サブスク認証とAPIキー利用を確認し、外部連携に関わる同じ操作を実施する。キーの有効性・無料枠の利用可否は実行時に確認し、利用不能な場合は未検証として残す。

1. OrganizationなしでWorkspaceを開き、Agentを既存から選ぶRoomと新規作成するRoomを作る。Agentの役割・指示を編集し、実行入力へ反映されることを確認する。Room設定で専門Agentを追加・解除し、権限と既定Agentの変更が実行可否へ反映されることを確認する。
2. 通常の依頼で既定Agentが実行し、仕事への返信で継続する。別の新規依頼は別の仕事になり、Session選択を要求しない。
3. 複数のNative Agentへ明示指名・自動委譲を行う。利用者はCodex / Claude Codeを使う専門Agentの混在でも確認する。分離した作業は並行し、共通の書込み先は待機する。結果と実ファイルを確認する。
4. 別メンバーのコメント・いいね・添付でRunが増えないことを確認する。依頼者の「Agentに反映」で選択した版だけが追加指示になり、他人の無権限制御は拒否されることを確認する。
5. 実行中に指示を変え、受付・反映待ち・反映済みを確認する。個別停止、担当変更、仕事全体停止を行い、子作業が残らないことと、停止未確認時の表示を確認する。
6. 停止と同時の委譲、二重クリック、二つのworker、指示変更同士の競合、担当変更後の遅延出力を再現し、追加の実行や上書きが発生しないことを確認する。
7. 承認待ち、期限切れ、権限取消、認証失敗、通信断、Server / App再起動を確認する。結果不明の外部操作は自動で再実行されないことを確認する。
8. 同じAgentの別Roomと別AccountのDMを開き、内容・継続参照・ファイルが混ざらないことを確認する。DMに参加しないWorkspace Owner / Adminによる通常の一覧・検索・Event・ファイル取得、管理APIからの自己追加・所有者復旧を拒否する。通常Roomの既存管理権限は保つ。DMの選択した結果だけを共有Roomへ渡す。
9. 既存履歴のあるDBを移行し、未設定の既定Agentを選ぶ。追加した仕事・コメント・Agent設定をexport / restoreし、関係・権限・履歴が残ることを確認する。

macOS Native Appの同じ主要経路を、実際のHosted接続先とSelf-host接続先で確認する。CI内の二つのDBだけで両配置の検証を済ませない。接続先が用意できない場合はその配置を未検証とし、全体完了とは報告しない。Windows / LinuxのNative GUIや署名・配布物の確認は今回の対象外である。

証拠には、実行日時、commit、OS、Server配置、エンジンのバージョン、設定条件、操作、画面、DBの関係、ファイル差分、RunとEventの参照、失敗と未検証を記録する。secretや既存の私的データを記録へ含めない。実施後の再利用可能な結果は`reports/`の対象別フォルダへ保存する。

### 10.3 セルフレビューと別Agentレビュー

実装者は各Phaseの差分を、対応する要件と完成条件に照らして先にセルフレビューする。中規模以上の変更として、利用可能なら別Agentへ読み取り専用レビューを依頼し、正本・本計画・差分・対象testの結果を渡す。

レビューでは、設計逸脱、未実装を隠す表示、停止・権限・移植の事故、既存の学習経路への回帰を確認する。修正後は影響する検証だけを再実行する。レビューの承認だけで実機確認を済ませない。

## 11. 完了条件と未検証事項

Phase 3・4・6の全体完了には、R01–R13が実装され、該当するfocused / 実PG / Native + Gemini / 利用者によるCodex・Claude Code / Native App / 配置先の証拠が揃い、利用者が操作確認できる状態であることが必要である。

納品時は「実装済み」「静的・focused確認済み」「実PG確認済み」「Native + Gemini確認済み」「Codex / Claude Codeは利用者確認待ち・確認済み」「macOS Native確認済み」「Hosted / Self-host確認済み」「利用者のUI確認済み」を分けて報告する。実装担当の技術検証完了と外部連携を含む全体完了を区別し、停止未確認や配置先未検証など、残っている項目を成功扱いしない。

作成時点で確認したのは、会話の合意、正本・設計書、対象ソースと既存test / script / CIの構造である。コード変更、migrationの実行、実Backend、実PostgreSQL、Native App、Hosted / Self-host、利用者による新UIの操作は、この計画に対しては全て未実施である。

技術E2Eを終えたら、変更点、起動方法、本人が確認する操作、未検証を提示する。利用者の所感を反映し、commit / push / PRはその時点の明示指示に従う。
