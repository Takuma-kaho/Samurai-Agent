# Native UI・Room中心の記憶管理・共有 実装計画

- 作成日：2026-09-17
- 状態：実装開始前の計画案。要件と設計は合意済み。本書が提案する工程順序は実装・検証済みを意味しない。
- 対象：今回のNative App改善スプリント。4本の設計書で定義した今回の追加・変更範囲をすべて実装する。
- 簡略版：[利用者向け実装計画](native-ui-workspace-context-sharing-overview-plan.md)
- 本書作成時の確認：現行コード・テスト・検証入口の読み取り。製品コードの変更、実Server・実DB・実Client検証は行っていない。

## 1. 目的・背景

既存のChat-first UIを活かし、WorkspaceとRoomの選択、情報の検索、仕事の通知、設定・知識管理への入口を揃える。Roomで蓄積した知識とAgentの構成を、元の会話・権限・認証情報を渡さず再利用できるようにする。

今回守る製品価値は、人とAgentが同じRoomで仕事を継続できること、利用者が知識とAgentを所有・編集・移植できること、Roomの閲覧境界を維持したまま共有できることである。

Workspaceは所有・メンバー・保存・export / restoreの単位として維持する。Workspace全体へ適用する専用メモリーを廃止し、Roomの自動学習、Agentへ明示的に持たせる知識、本人の回答設定を分ける。廃止対象は検証用データであり、RoomやAgentへ移管しない。

## 2. 禁止事項

- 合意済み要件、設計の公開範囲、権限、保存単位、画面遷移、失敗時の動作を独自解釈で変更しない。要件・工程・完了条件を黙って削減・統合せず、必須機能を後続スプリントへ送らない。
- ダミー通知・参加者、操作不能な設定・共有ボタン、画面だけの実装を完成扱いしない。
- 通常RoomをAgent数でDMへ変換しない。既定Agentを複数化せず、利用不能時に自動で差し替えない。
- 検索・通知の取得失敗を0件に、202受付を取り込み完了に、停止要求を停止完了に置き換えない。
- UIだけでWorkspaceメモリーを隠さない。旧API、Core、索引、実行文脈、移行入力、復元の再投入経路を残さない。
- 廃止を理由にWorkspace全体・DB全体を初期化しない。Room知識、Skill、policy、学習設定、本人設定、会話、成果物を巻き込まない。引き継ぎ専用画面・救済用Roomを作らない。
- 共有に履歴、学習根拠、参加関係、元のアクセス権、Backend資格情報、内部パスを自動追加しない。自由文を完全に秘密検出できると説明しない。
- 共有の閲覧・取り込みでAgent実行、Room参加、既定Agent変更を始めない。取り込み済みコピーを同期・遠隔回収しない。
- 業務判断をHTTP handler・UIだけに置かない。呼び出し側の検証を信用して共通Coreを迂回しない。
- 既存サービスを再利用する代わりに別の巨大なモデルへ処理を移さない。不要な汎用フレームワーク、追加承認、手作業、利用制限を導入しない。
- 参照OSSの製品概念・命名・機能をコピーしない。テストを通すためのエラー隠蔽、テスト弱体化、テスト専用分岐、表面的な簡易実装を行わない。
- 未検証を完了扱いしない。同じ変更・環境・仮説のまま重い検証やレビューを繰り返さない。
- 本書の作成や実装開始だけを理由にbranch作成、commit、push、PR、merge、branch削除を行わない。Git操作は別の明示指示に従う。

## 3. 正本と確定事項

### 3.1 実装者が必ず読む文書

実装開始前に下表を読む。各工程の着手時には、その工程が指定する節を読み直して差分・テストへ反映する。設計書を読まず、この計画の要約だけで実装しない。

| 識別子 | 文書 | 正本として扱う内容 |
| --- | --- | --- |
| R | [要件定義書](../docs/requirements/native-ui-room-agent-sharing-requirements.md) | スプリント範囲、機能・非機能・データ・連携・運用要件、A-01〜A-11 |
| D1 | [基本設計](../docs/designs/workspace-context.md) | 所有と帰属、Coreの責務、操作別認可、確定点、要件対応表 |
| D2 | [データ詳細設計](../docs/designs/workspace-context-data.md) | 列・制約・RLS、本文台帳、廃止、復旧、bundle |
| D3 | [API・処理詳細設計](../docs/designs/workspace-context-api.md) | 公開型、既存契約の拡張、新規契約、処理順序、状態遷移、再送、外部取得 |
| D4 | [Native App画面設計](../docs/designs/native-app.md)第11〜15章 | UI-01〜UI-11、項目・操作ID、全画面設定、右パネル、保存・復帰・下書き保護 |

[PRODUCT.md](../PRODUCT.md)、[ARCHITECTURE.md](../ARCHITECTURE.md)、作業対象に適用される`AGENTS.md`も必読とする。D4は製品全体の文書であるため、第1〜10章にある他Phaseの目標機能を今回の追加対象へ拡張しない。

既存契約を接続する際は、[RoomとAgentの共同作業](../docs/designs/room-agent-work.md)、[Agent Backend](../docs/designs/agent-backends.md)、[成果物](../docs/designs/artifact-surface.md)、[Organization](../docs/designs/organization.md)の関係する節だけ確認する。[Native UI移行](../docs/designs/native-ui-migration.md)は2026-09-16の実装説明であり、今回新しく対象になった機能を保留する理由にしない。

### 3.2 合意済みの仕様

- Workspace切り替えを左ナビ上部へ移す。検索・通知を固定入口とし、Room一覧部分をスクロールさせる。
- 検索は選択中Workspaceの閲覧可能なRoom名・会話・Room Knowledgeを対象にする。本人のDMも既存認可内で対象となる。Agent知識と全Server横断検索を追加しない。
- 通知は仕事の完了・失敗、承認待ち、入力待ち、招待の5種類。仕事通知一覧は選択Workspace内。他Workspaceは未読概要だけ、未参加Workspaceへの本人宛て招待は別枠とする。
- 本人設定は全画面の左カテゴリ・右詳細。プロフィール、回答設定、3テーマ、接続を扱う。Room設定は会話右側で成果物と切り替えるパネルとする。
- 自動学習の帰属はRoom。Agent知識・Skillは手動管理と共有取り込みから作る。本人設定はAccount別の端末内保存で、回答設定のClient間同期を新設しない。
- Room知識共有は管理者による知識だけの共有で、受け手の管理する既存Roomへ新しい知識として取り込む。Room自体を複製しない。
- Agent共有は管理権限者による名前・人格・指示・選択Skill・Agent知識の共有で、受け手のWorkspaceへ新しいAgentとして取り込む。
- 限定共有は指定Accountの本人照合、公開共有は未ログイン閲覧を許可する。取り込みには本人認証と宛先権限を必須とする。
- 発行内容は確認済みの固定コピー。共有停止と取り込み受付は共有元で直列化し、停止前受付済みの同じ操作は再開できる。取り込み済みコピーは残す。
- Workspace専用メモリーは引き継がず、旧入力・参照・復元も停止する。Workspaceの所有機能とメモリー以外の資源・設定を維持する。

### 3.3 計画上の提案と文書変更の扱い

SI-00〜SI-10の工程分割・順序は本書の提案であり、追加の製品仕様ではない。既存プランのPhase 3・4・5・6・7やE1〜E14等の番号・判定を変更しない。

合意済み4設計書を今回の実装基準とする。実装中の接続方法は現行コードの規約で調整してよいが、範囲・認可・コピーの意味を変更する場合は根拠をまとめて利用者へ確認する。設計書の編集は明示指示の範囲に限る。本計画作成では設計書を変更しない。

## 4. 現状の実装と証拠

### 4.1 本書作成時に確認した事実

2026-09-17、`fb6d796`の作業ツリーで読み取り確認した。開始時branchは`codex/design-workspace-room-agent-sharing`、未コミット差分なし。実装開始時にも状態を再確認する。

| 領域 | 現行ファイル・接続 | 今回必要な差分 |
| --- | --- | --- |
| 共通画面 | [NativeApp](../apps/web/src/native-app/NativeApp.tsx)、[useNativeApp](../apps/web/src/native-app/use-native-app.ts) | 全画面の復帰先、右パネル種別、検索・通知・共有の状態を接続する。仕事・streamの親状態を維持 |
| 本人・Workspace | [NativeProfileMenu](../apps/web/src/native-app/NativeProfileMenu.tsx)、[テーマ保存](../apps/web/src/lib/native-app-theme-preferences.ts) | 本人メニュー内のWorkspace・テーマを上部入口・設定画面へ移す |
| Room階層 | [RoomNavigator](../apps/web/src/components/RoomNavigator.tsx) | 現在は子を描画し、親のaria-expandedはtrue。選択と独立する開閉・保存、非公開親による深さ補完の除去 |
| 知識・Room管理 | [Knowledge tools](../apps/web/src/native-app/use-native-knowledge-tools.ts)、[Room administration](../apps/web/src/native-app/use-native-room-administration.ts) | 既存編集・移動・参加確認を再利用。現行のWorkspace Knowledge一覧合流を除去し、Agent帰属を追加 |
| 公開API | [Domain API](../packages/domain-api/src/index.ts)、[HTTP adapter](../apps/server/src/workspace-server/domain-api-v1.ts)、[HTTP server](../apps/server/src/workspace-server/http-server.ts) | 新規検索・通知・共有契約、Account dispatch、署名付き本人設定、共有専用HTTPを追加 |
| Completion | [型](../packages/workspace-server/src/workspace-completion-types.ts)、[service](../packages/workspace-server/src/workspace-completion-service.ts)、[files](../packages/workspace-server/src/workspace-completion-files.ts) | scopeはWorkspace／Roomで、promoteToWorkspace等が存在。Agent帰属・transaction対応writer・本文確定を追加し、Workspace Knowledgeを拒否 |
| 学習・旧入力 | [Learning](../packages/workspace-server/src/workspace-learning.ts)、[Completion migration](../packages/workspace-server/src/workspace-completion-migration.ts) | enabledだけを継承するflagと共通resolver。旧メモリー・昇格・自動参照の経路を停止 |
| 保存・認可 | [Store](../packages/workspace-server/src/workspace-server-store.ts)、[schema](../packages/workspace-server/src/schema.ts) | 既存認可・冪等台帳・ロック規約を使い、今回の制約・テーブルを追加。非同期取り込みを同期台帳だけで完了扱いしない |
| 実行文脈 | [PostgreSQL Chat adapter](../apps/server/src/adapters/runtime/postgres-runtime-chat.ts)、[HTTP composition](../apps/server/src/workspace-server/http-server.ts)、[Room Work worker](../apps/server/src/workers/postgres-room-work-worker.ts) | Room・担当Agent・依頼者設定を出所と版付きで実行へ固定。既存Knowledge portの接続元も追う |
| Client接続 | [browser bridge](../apps/web/src/lib/workspace-browser-bridge.ts)、[Client型](../apps/web/src/lib/api.ts)、[preload](../apps/desktop/src/preload.cts)、[Desktop main](../apps/desktop/src/main.ts) | BrowserとElectron双方の型・署名・入力検査・応答検査を揃える。preloadの既存scope検査も変更 |
| 復元 | [Completion bundle v4](../packages/workspace-server/src/workspace-completion-bundle-v4.ts)、[Core bundle v3](../packages/workspace-server/src/workspace-bundle-v3.ts)、[commands](../packages/workspace-server/src/workspace-server-commands.ts) | Agent資源・共有監査・本文をschema revisionに追加。旧Memory入力拒否と復元時リンク停止 |

新規契約名・本人設定・学習継承flagは、今回確認した既存公開契約に実装されていない。新サービスはD3第12.4節のContext Query、Notification、Shareの責務として追加する。新規ファイル名は配置先の規約で決め、存在しないファイルを既存接続先として扱わない。

### 4.2 既存テストの利用と限界

- 公開契約：`packages/domain-api/src/index.test.ts`、`apps/server/src/workspace-server/domain-api-v1-http.test.ts`、`domain-api-v1-management.test.ts`、`domain-api-v1-interaction.test.ts`。
- 保存：`packages/workspace-server/src/schema.test.ts`、`schema-migration-compat.test.ts`、`workspace-server-store.test.ts`、`workspace-completion-service.test.ts`、`workspace-completion-files.test.ts`、`workspace-completion-bundle-v4.test.ts`、`workspace-bundle-v3.test.ts`、`workspace-learning-policy.test.ts`。
- Client：`apps/web/src/native-app/NativeApp.test.ts`、`NativeProfileMenu.test.ts`、`use-native-app.test.ts`、`native-knowledge-tools.test.ts`、`native-room-administration.test.ts`、`use-native-draft-navigation.test.ts`、`apps/web/src/lib/workspace-browser-bridge.test.ts`。
- Desktop：`apps/desktop/src/preload.test.ts`、`workspace-request-signing.test.ts`、`workspace-learning-requests.test.ts`、`main-room-work.test.ts`。実行・自動化への影響は関係するPostgreSQL adapter・workerテストを使う。

Vitestの現行環境はNode。既存Native UIテストには静的描画・純粋関数の確認があるが、実クリック、focus、IME、IndexedDB、全画面からの復帰を一括して証明しない。必要な新規ロジックテストを責務の近くへ置き、操作証拠は実Clientでも取得する。

本書作成では上記テストを実行していない。過去のreportsのpassは参考であり、今回差分の完成証拠として再利用しない。

## 5. 対象・対象外

対象はR第3.1節とD1〜D4の今回差分。UI-01〜UI-11、資源のAgent帰属、本人設定、学習enabled継承、検索、5種通知、Room知識・Agent共有、別Server取り込み、本文確定・復旧、Workspaceメモリー廃止、bundle対応、必要な回帰検証を含む。

今回追加しない機能はR第3.2節に従う。複数既定Agent、Room全体複製、共有の継続同期・遠隔回収、公開カタログ・市場、新しいOrganization管理、外部メール・Slack通知、新Backend、新学習アルゴリズム、移行専用画面を作らない。Room内検索の併設は受入条件に含めない。

既存の3テーマ、通常依頼・返信・コメントの意味、DM認可、成果物編集・保存、Workspace切り替え、export / restoreを維持する。旧プランの未完了項目を今回の設計で解決したことにせず、今回に必要な接続・回帰の範囲だけ扱う。

## 6. 守る設計境界

1. **所有と知識の適用を分ける。** Workspace所有の資源でも全Roomに自動適用しない。Knowledgeの帰属はRoomまたはAgent、Workspace Skill・policy等の意味は維持する。
2. **認可は共通Coreで確定する。** 検索の候補・抜粋・件数、通知の一覧・既読、共有の発行・停止、取り込みの宛先を現在の権限で検査する。HTTP認証、Core検査、DB制約／RLSのいずれも省略しない。
3. **Agent管理は現行条件を使う。** D1第9.1節のWorkspace admin条件を使い、独自の所有Agent roleを加えない。Organization所属をRoom contentの権限根拠にしない。
4. **対象を混同しない。** Clientの識別はAccount・Server接続・Workspace・Room／Agent・画面世代。外部取り込みはorigin・Account・claim・宛先・操作ID・ハッシュを束縛する。
5. **通常画面へ未確定データを出さない。** stage・rename後も、最終DB確定までAgent・資源を通常一覧・検索・実行へ公開しない。複数資源を通常create APIへ順次送って部分成功にしない。
6. **再送と停止競合を設計どおり扱う。** 同じ意味入力と操作IDは同じ結果。内容変更は409。受付と停止は同じ共有行のlock、確定前は宛先権限・leaseを再検査する。
7. **通知は投影である。** 仕事・要求・招待の保存と同じtransactionにoutboxを書く。通知を承認・入力・招待受諾の正本にせず、Queryで復元できるようにする。
8. **本人設定は本人の実行に限定する。** 端末Account別保存と公開プロフィール反映を分け、署名検証したスナップショットだけをRunへ固定する。公開会話・共有本文へ複写しない。
9. **Runtimeの総文脈量を維持する。** Room知識と担当Agent知識を既存の確定版選択・順位・総量制限で組み立てる。出所を残し、知識本文を権限変更命令として扱わない。
10. **復元は再公開しない。** active共有はrevokedへ、完了取り込みは独立コピーとして復元する。Account通知をWorkspace bundleへ移さず、未完了処理を持ち越さない。

## 7. 要件と実装工程の対応

範囲表記は両端を含む。詳細な項目対応はD1第10章を正本とし、実装後の証拠台帳へ各IDを展開する。表に束ねても各要件の受入条件を省略しない。

| 要件 | 主工程 | 画面・処理・保存の参照 | 完了証拠 |
| --- | --- | --- | --- |
| F-NAV-01〜04 | SI-08 | D4 UI-01、NAV-01〜04、D1対象guard | A-01、V-UI05。階層開閉、再認可、同ID別Server |
| F-SEARCH-01〜04 | SI-04、SI-09 | D3 P-SEARCH、D4 UI-02／S-01〜05、D2第9章 | A-02、V-P01、V-UI05。認可・cursor・IME・遅延応答 |
| F-NOTIFY-01〜06 | SI-05、SI-08・09 | D2第7章、D3 P-NOTIFY、D4 UI-03／N-01〜05 | A-03、V-P02、V-UI05。5種・既読・再接続・招待・概要 |
| F-HEADER-01〜04 | SI-08 | D4 HDR-01・02、第13.1節、D3 P-ROOM-SETTINGS | A-04、V-UI03。実参加者、既定1体、左右開閉 |
| F-SETTINGS-01〜03 | SI-03、SI-08 | D4第12・13章、D3 P-PREFERENCES／P-ROOM-SETTINGS | A-05、V-UI01〜04、V-P07、V-D05 |
| F-MEMORY-01〜04 | SI-02・03、SI-08 | D1第4章、D2第3・9章、D3 P-CONTEXT、D4 UI-06・07 | A-05・11、V-D01・02、V-P07、V-UI04 |
| F-REMOVE-01〜03 | SI-02、SI-07・08 | D2第10章、D3第6章・V-P08 | A-10、V-D06・07、V-P08。旧入力・索引・実行・復元と対象外保持 |
| F-SHARE-01〜03 | SI-06、SI-09 | D3 P-PUBLISH・Manifest、D2第4・5章、D4 UI-08・10 | A-06〜08、V-P03・06、V-UI06 |
| F-SHARE-04・05 | SI-07、SI-09 | D3 P-IMPORT、第13章、D2第6章、D4 UI-11 | A-06・07・09、V-P05・06、V-UI07。明示取り込み・独立コピー |
| F-SHARE-06・07 | SI-06・07、SI-09 | D3 P-CLAIM／P-REVOKE、復旧表、D4 UI-09 | A-08・09、V-D03・04、V-P04・05。停止・再送・部分成功なし |
| F-ROOM-SHARE-01〜03 | SI-06・07、SI-09 | Room manage、room_knowledge Manifest、既存Room指定 | A-06、V-D02、V-UI06。知識のみ・管理者のみ・非上書き |
| F-AGENT-SHARE-01〜04 | SI-02・06・07、SI-09 | Agent管理条件、agent Manifest、新Agent一括確定 | A-07、V-D01・02、V-P06。選択構成・受け手接続・元権限非継承 |
| N-01・02・03・11 | SI-01〜07、SI-10 | D1第9章、D2制約・RLS、D3認証・排他・監査 | V-D02〜04、V-P03〜06、A-09。実DBの許可／拒否・事故復旧 |
| N-04・05・08・09 | SI-03〜05、SI-08〜10 | guard、Page型、outbox、画面状態・エラー型 | V-P01・02、V-UI02・04・05・07 |
| N-06・07 | SI-08〜10 | D4第11〜15章 | V-UI01〜07。キーボード・3テーマ・幅・入力保持 |
| N-10・12 | SI-01〜10 | 共通契約、通知種別、既存Core、bundle | A-11、未知種別、既存関連Regression |
| データ第6.1〜6.3節 | SI-01〜07 | D2全章、D3型・Context・取り込み | V-D01〜07、復元・独立資源・索引再構築 |
| E-01〜04・07 | SI-01・04〜07、SI-09 | D3共通公開API・共有専用HTTP・Account署名、D2保存 | V-P02・06、実Browser／Native・別Server |
| E-05・06 | SI-03・05・07、SI-10 | 既存Backend／要求・通知outbox、受け手側Backend | V-P02・07、A-07・11。実行接続と通知の分離 |
| O-01〜03 | SI-02・07 | D2第10章、D3廃止scope拒否 | A-10、V-D06・07、V-P08 |
| O-04・05 | SI-08〜10と全Core工程 | D4保存・復帰、共通Core接続 | A-01〜11、V-UI01〜07。既存機能保持・ダミーなし |

B-01〜B-06はR第2.2節の業務フローをSI-10で通して確認する。A-01〜A-11、V-D01〜V-D07、V-P01〜V-P08、V-UI01〜V-UI07を既存番号のまま証拠へ結び付ける。

## 8. 工程別の実装内容

### 8.1 SI-00：参照・接続先・検証環境を固定する

- **目的・前提**：R、D1〜D4、正本、各フォルダのAGENTS.mdを読み、本書の対象を現在の作業ツリーへ対応付ける。
- **調査対象**：第4章の接続先、既存関連テスト、`package.json`、`.github/workflows/ci.yml`、第9章の参照OSS。履歴全体や関係しないOSSを監査しない。
- **作業**：UI操作→Bridge／IPC→公開契約→Core→DB／本文→Event／Runtimeの接続表を作る。Knowledge portのcomposition、旧Memory・promote・move／copy・import・restore経路を追い、廃止対象表と保全対象を固定する。
- **環境**：実Server、専用PostgreSQL、隔離本文保存先、テストAccount、Browser、macOS Electron、別Server接続を用意する。既存の設定済み認証を使い、secretを文書・ログへ出さない。配置先未準備でも独立した実装・focused確認は進める。
- **レビュー・確認**：部品の存在と実動作を分ける。既存データ件数を引き継ぎ判断の質問へ戻さない。新しい製品判断が必要な矛盾だけ、重複を除いて一括確認する。
- **完了・次へ**：今回要件の担当責務、変更先、旧経路、検証手段が対応し、設計を変えずに実装可能。環境不足は未検証として台帳化する。調査だけを終了理由にせずSI-01へ進む。

### 8.2 SI-01：公開契約・保存構造・共通認可を追加する

- **読む節**：D1第3・7・9・10章、D2第1〜8章、D3第1・2・9・12.4章、R第5〜7章。
- **対象**：Domain API、HTTP adapter、Completion型、schema、StoreとWorkspace Serverの公開export。新規CoreはContext Query／Notification／Shareの責務で配置する。
- **実装**：設計のstrict入出力型、Page／Target／Manifest／ImportResult、エラーcode、操作ID・版・ハッシュの条件を登録する。Account契約をOrganization非参加でもdispatchできるようにし、成功応答のresult・replayed検査を保つ。
- **保存**：Agent帰属列、学習継承flag、shares・recipients・claims・imports・import_resources・file_transactions・notifications・outboxをD2のPK／FK／CHECK／UNIQUE／索引とともに追加する。NULLを含む通知重複キーは設計の部分索引を使う。
- **認可**：D1第9.1節とD2第8章のCore・RLS・更新関数を揃える。匿名共有専用取得から通常Room検索へ到達させない。
- **境界**：Workspace Knowledge禁止CHECKはSI-02の対象除去と整合するmigration順で導入し、既存データがあるだけでDDLが失敗する状態にしない。追加型だけで新機能を実装済み・公開済みにしない。
- **検証・レビュー**：公開schemaの未知キー・矛盾scope・許容値・result型、schemaの制約、既存migration互換をfocused確認。関連package typecheckを行う。Core権限条件とDB条件のずれを確認する。
- **完了・次へ**：SI-02以降が使う型と認可・保存構造が定義され、既存Room・Skill・policy契約が維持される。実DBのmigration・拒否証拠はSI-02で対象除去とまとめて確定する。

### 8.3 SI-02：Agent資源・Room学習・旧メモリー廃止を成立させる

- **読む節**：D1第4・9章、D2第3・9・10・11章、D3第2・6・12.2章、R F-MEMORY・F-REMOVE・O-01〜03。
- **対象**：Completion service／files／migration／検索投影、Learning、schema、公開・旧HTTP経路、Bridge／preloadのscope検査、bundle入力検査。
- **Agent資源**：Agent帰属の手動Knowledge／Skillを既存の版・固定・保管・本文確定へ接続する。agent_id／room_id排他、同WorkspaceのAgent、Agent管理権限、ai_managed=falseをCoreで検査する。パス生成、symlink検査、support files、export許可ルートも同じ帰属に対応させる。
- **学習**：enabled_inherits_workspaceと共通resolverを追加する。「既定値」はenabledの継承だけを変更し、model・予算・上限・使用量を保持する。自動学習の資源writerを対象Roomに制限する。
- **廃止**：旧Workspace Knowledge／Memoryの対象IDを固定し、参照→索引・根拠→版ポインタ→版・本体を設計順で除去する。本文は未参照の対象パスだけを再実行可能な削除台帳で回収する。SI-01の禁止制約を確定する。
- **旧経路**：create・update・promote・move／copy・通常取得・検索・Context・旧移行入力・旧bundleからの再投入をCoreで拒否する。新APIのstrict検査で旧入力が400になっても、形式検査を越える直接Core呼び出しでも拒否を確認する。Workspace scopeという理由でSkill・policy・学習既定値を除去しない。
- **検証・レビュー**：V-D01・02・05・06、V-P08。専用実PostgreSQLで旧形式の対象データと保全対象を同居させ、migration・再実行・RLS・直接入力拒否を確認する。ID・版・本文の保全、削除途中の再開、索引からの消失を確認する。
- **完了・次へ**：Agent資源とRoom学習の保存・認可が実DBで成立し、廃止資源が通常取得・検索・新規作成へ戻らない。完成Contextと新bundleの回帰はSI-03・SI-07で残件として追う。

### 8.4 SI-03：本人設定の保存と実行文脈を接続する

- **読む節**：D1第4・9.3章、D2第9章、D3第6・12.1〜12.3章、D4第12章、R F-MEMORY・F-SETTINGS。
- **対象**：Client Account設定ストア、Client型と署名・Bridge／IPC、PublicRequestContext、HTTP検証、Run入力、Chat adapter・Knowledge port composition、自動化の保存・実行接続。Agent帰属refを通す共通型、[Runtimeの資源参照](../packages/runtime/src/context/resource-refs.ts)・[文脈構築](../packages/runtime/src/context/context-assembly.ts)、[外部BackendのContext](../packages/agent-backends/src/external-backend-context.ts)も利用元として照合する。
- **保存**：設計のIndexedDBレコードをAccount別に保存し、readwrite transactionで期待revisionを照合する。未知schema_version・不正レコードを黙って上書きしない。表示名の端末保存とServer登録更新を別状態にする。テーマキーと3値は維持する。
- **本人設定の適用**：実行開始操作だけにpersonal_preferencesを許可し、既存Account署名で本文全体を検証する。認証主体の設定として非公開Run入力へ保存する。新規依頼は新設定、再試行は元スナップショット。既存自動化を設定保存だけで書き換えない。
- **Context**：保存されたRoom仕事・担当Agent・依頼者から対象を解決し、現在の実行権限を検査する。Room確定知識と担当Agent確定知識・Skillを出所・版・ハッシュ付きで共通の総量制限内に組み立てる。Workspace知識合流を呼ばない。言語は明示依頼→本人→既存既定値。
- **検証・レビュー**：V-P07、A-11のContext部分。別Account／別ウィンドウ競合、偽設定・検索要求への混入拒否、設定の公開会話非複写、Agentの別Room参加、自動学習の非転記、総量上限、再試行・自動化の版固定を確認する。外部Backendへも共通Contextを渡す契約を確認する。
- **完了・次へ**：設定保存と署名付き実行への接続が成立し、Room・Agent・本人の出所が分離される。実Agentでの再利用・画面復帰はSI-10で確認し、保存ロジックtestだけで完了宣言しない。

### 8.5 SI-04：Workspace検索をCoreからClient接続まで実装する

- **読む節**：D1第5章、D2第9章、D3第3.1・9・10.1章、D4第11.4・14.2章、R F-SEARCH・N-08。
- **対象**：Context Query、既存Room・仕事会話・Completion検索投影、Domain API／HTTP adapter、Browser Bridge・Electron IPCと型。
- **実装**：現在の認可済みRoom集合を先に作り、NFKC・lowercase・空白分割・重複語除去のAND一致で検索する。整列キー、会話ID正規化、版と投影の一致、200文字snippet、limit+1取得をD3どおり実装する。
- **ページ**：origin・Account・Workspace・条件hash・as_of・最終キーを署名cursorへ束縛する。改ざん・別条件・期限切れは400、各ページと詳細を開くときに再認可する。Agent資源と旧Workspace Knowledgeは除外する。
- **検証・レビュー**：V-P01。公開API→実DBで複数Room・本人DM・他人DM・非公開Roomを検索し、本文だけでなく候補・抜粋の非漏えいを確認する。検索中の権限取消、cursor継続・再検索、投影版不一致を確認する。Clientに全会話を取得して検索させない。
- **完了・次へ**：認可付きページ検索がBrowser／Electronの共通契約から呼べる。実入力・IME・focus・結果ジャンプはSI-09で仕上げる。

### 8.6 SI-05：5種通知・既読・概要・再接続を実装する

- **読む節**：D1第5章、D2第7・8・10章、D3第3.2・9・10.2章、D4第11.4・14.3章、R F-NOTIFY。
- **対象**：仕事全体の終端、Interaction Request、Workspace／Organization招待の保存処理、Notification Core／投影worker、worker supervisor、Account stream、Domain API、Bridge／IPC。
- **実装**：元状態と同じtransactionでcreate／invalidate outboxを書き、依頼者・要求の対応対象者・指定招待相手だけへ投影する。担当作業単独の終了や、受信者未指定の招待リンクから本人を推測しない。
- **復旧**：outboxのlock・通知INSERT・processed_atを同transactionで確定し、commit後に本文なしのnotification.changedを配信する。投影失敗の遅延再試行と再起動回収、Account署名fetch-stream、復帰時Queryを実装する。
- **読み取り**：現在も読める通知と未解決要対応の条件を一覧・件数で共通化する。既読は本人の対象ID全部を認可して更新し、他人ID混入は全件拒否する。対応済みを未読件数から除く。通知既読で業務応答を行わない。
- **横断概要**：Serverごと100 Workspaceずつ概要取得し、一部失敗はunknown。active targetを変えず30秒間隔・切り替え一覧表示時に取得する。本人宛て未参加招待はAccount枠、参加後はWorkspace枠へ一度だけ表示する。
- **検証・レビュー**：V-P02、A-03、V-UI05の接続状態部分。5種の許可／拒否、元状態とoutboxの部分失敗、同遷移再送、解決・取消、既読時刻の再送不変、stream断・再起動・権限失効・Server一部失敗を確認する。
- **完了・次へ**：保存済み状態から本人通知を復元でき、既読・概要・招待Queryが両Client接続に通る。実画面の入口・移動はSI-08・SI-09で確認する。

### 8.7 SI-06：共有用下書き・発行・閲覧・停止・受付を実装する

- **読む節**：D1第6・9章、D2第4・5・8章、D3第4・9・11.1・11.2・13章、D4第11.6・11.7・14.5章。
- **対象**：Share Core、Completion本文確定の共通処理、公開契約と共有専用HTTP、Account署名、共有元Room／Agentの削除処理、監査。
- **下書き**：管理権限・資源帰属・選択版を検査し、allowlist Manifestと元IDから独立するentry_idを作る。既知の内部参照を除去し、再挿入は禁止する。作成者だけが下書きを読める。許可した内容編集は元データを変更しない。
- **発行**：本文台帳→stage→rename→版照合の確定を接続し、保存済みhash・expected_version・現在権限・受信者条件を再検査してactive、locator、操作結果、監査を確定する。発行後の内容・公開範囲・相手を固定する。再共有は新しい限定下書きから始める。
- **閲覧**：公開は匿名、限定は指定Account照合。同じ本人が共有元Serverに未登録でも公開鍵と署名を検証し、Membershipを自動作成しない。元の内部ID・パス・受信者一覧を公開応答へ返さない。
- **停止・claim**：同じshares行のlockで直列化する。停止前の同一claimの再開、停止後新受付拒否、すでに停止済みの再送を扱う。元Room／Agent削除時は有効リンクを同じ操作で停止し、個別資源更新・削除は発行済み内容を変えない。
- **検証・レビュー**：V-D02〜04、V-P03・04・06。発行権限取消、別Room／Agent資源ID、版競合、未確認hash、禁止項目、限定第三者、匿名公開、停止と受付を両順序で競合、stage／rename／DB確定前後の事故を確認する。
- **完了・次へ**：確認済み固定コピーを発行・閲覧・停止・受付でき、本文確定・認可・再送の証拠が揃う。UI確認と受け手の資源作成はまだ未完了としてSI-07・SI-09へ進む。

### 8.8 SI-07：別Server取り込み・一括確定・bundleを実装する

- **読む節**：D1第6・7・9.3章、D2第5・6・8・10・11章、D3第5・9・11.3・11.4・13章、D4 UI-11。
- **対象**：取り込み先Share Core／worker、共通transaction対応Agent・Completion writer、ファイル台帳、署名委任、外部取得、bundle v3／v4／commandsと整合性検査。
- **受付・取得**：先に宛先権限を検査し、本人・origin・claim・操作・hashを束縛した5分以内の委任を照合する。HTTPS、redirect不追従、DNSと接続IP、非公開宛先の運用allowlist、timeout・サイズ制限をD3どおり守る。資格情報を別originへ転送しない。
- **確定**：意味入力hashと予約IDをimportsに固定する。lease・再試行状態を使い、検証済み本文をstage・rename後、現在の宛先権限・leaseを再検査する。Agent・全資源・版・対応表・結果を同transactionで確定する。ネットワーク中はDB lockを保持しない。
- **作成内容**：Room共有は指定既存RoomにKnowledgeだけ。Agent共有は新AgentとAgent帰属資源だけ。受け手側の通常既定Backendを適用し、利用可能な接続があれば再設定を強制しない。creation_source=import、ai_managed=false、確認済み初期版を使い、元の根拠・AI評価・権限を継承しない。
- **復旧**：fetch／files／commit／done／cleanupとretryableを設計の表で処理する。署名更新を別意味入力にしない。応答喪失は同じ操作のstatusで回収し、失敗時は未参照本文だけを回収する。stagingの202・再送200を完了表示しない。
- **bundle**：次schema revisionにAgent資源・共有記録・本文を含め、旧Memory入り入力は開始前に拒否する。既存復元のID対応付けをAgent帰属・共有元FK・取り込み対応表・本文パスへ適用し、外部origin参照と内部FKを混同しない。復元時active→revoked、claimsは監査だけ、committed importsは独立コピー。通知・outboxは移さず、未完了imports／file transactionsはexportの待機・再試行で処理確定まで持ち越さない。索引を再構築する。
- **検証・レビュー**：V-D03・04・07、V-P05・06・08。同一・別Server、同Workspace ID、偽署名／宛先変更／期限更新、並行再送、取得・rename・DBcommit事故、lease切れ、権限取消、同名非上書き、復元後リンク非復活を実DB・実本文保存先で確認する。
- **完了・次へ**：独立コピーが一括で確定し、部分資源を公開せず再開・回収できる。新bundleが独立資源を復元し、旧メモリーとリンクを再有効化しない。UI確認と実Agent利用はSI-09・SI-10に残す。

### 8.9 SI-08：ナビ・ヘッダー・本人設定・Room設定・Agent詳細を接続する

- **読む節**：D4第11〜15章のUI-01・04〜07、D1第9.2章、D3第12章、R F-NAV・F-HEADER・F-SETTINGS・F-MEMORY。
- **対象**：NativeApp、ProfileMenu、RoomNavigator、useNativeAppと対象guard、既存Room管理・Knowledge編集・成果物・下書き管理、Client Account設定ストア、関係するCSS。
- **ナビ・ヘッダー**：Workspace上部popover・未読概要、固定検索／通知入口、独立したRoom開閉、許可済み祖先だけの階層を実装する。実参加者・既定1体・利用不可理由、三点メニュー、左右パネル開閉を表示する。
- **本人設定**：全画面のカテゴリ・詳細、フォーム別保存・取消、テーマ即時反映、接続別名前反映状態、returnContextと復帰時認可を実装する。画面を隠しても仕事・stream・入力・editorの親状態を保持する。
- **Room設定**：右パネルのclosed／artifact／room_settingsを一元管理し、6タブを既存Coreへ接続する。学習の既定／有効／無効を表示し、別設定を消さない。Agent詳細は中央ページでSkill・知識を手動管理する。
- **下書き**：同Roomのタブ・成果物切り替えは保持。閉じる／対象変更は保存・破棄・継続を一度だけ確認する。複数フォームの保存順・成功済み非再送・共通版更新・管理権限失効・閲覧失効時の消去を設計どおり扱う。
- **検証・レビュー**：V-UI01〜05、A-01・04・05。実Clientで全画面復帰、別ウィンドウ設定競合、成果物との切り替え、stream継続、設定保存不明、権限変更、3テーマ・幅変更を確認する。静的描画で操作済みとしない。
- **完了・次へ**：実データの設定・ナビ・ヘッダー操作が通り、既存入力・成果物を維持できる。検索・通知の固定入口と共有入口がSI-09の画面へ接続できる。

### 8.10 SI-09：検索・通知・共有・外部リンクの利用者操作を完成させる

- **読む節**：D4 UI-02・03・08〜11、第14・15章、D3第7・9〜11・13章、D1状態図と確定点。
- **対象**：Native Appの検索dialog／通知中央画面／共有dialog／取り込み画面、Browser共有ページ、Browser・Electronのリンク入口、Desktop mainの既存samurai protocol、Bridge／preload署名接続。
- **検索・通知**：IME非発火・300ms検索・種別・追加読込み・targetジャンプ・focus復帰、成功0件と失敗、選択Workspace通知・招待枠・対応済み・既読再試行を接続する。Workspaceなしでも本人宛て招待を確認できる。
- **共有**：選択→共有用編集→Server保存→最終確認→発行を接続する。限定を初期値とし、指定相手・ファイル一覧・独立コピー・停止で回収できないことを表示する。本人下書き再開／破棄、履歴・内容確認・停止・再共有を接続する。
- **リンク・取り込み**：公開／限定の表示、ログイン・Appで開く、samurai://shareのURL検査、認可付き宛先候補、確認済みhash固定、処理中status、再署名・再試行、作成資源へ移動を実装する。開いただけでclaim・import・実行を始めない。
- **安全な描画**：共有ページのno-store／no-referrer／noindex／CSP、HTML無効、外部script・画像自動読込み禁止、Skill非実行、外部リンク属性を設定する。source情報・受信者一覧・内部パスを画面やアクセスログへ漏らさない。
- **検証・レビュー**：V-UI05〜07、A-02・03・06〜09。発行者・正規受信者・対象外利用者、未ログイン、別Server宛先、停止、下書き保存失敗、発行応答喪失、取り込み途中で閉じる・再表示、未知通知kind、Tab／Esc／Enterを実Clientで確認する。
- **完了・次へ**：UI-01〜UI-11の必須操作が実Coreへ接続し、Browser・Native入口から確認済み共有を独立取り込みできる。SI-10の一連の受入検証を行える。

### 8.11 SI-10：受入・回帰・証拠の突合で完了を判定する

- **読む節**：R第8.3節A-01〜A-11、D1第10章、D2第11章、D3第14章、D4第15章、本書第10・11章。
- **対象**：今回の全差分、関連テスト、実Server／PostgreSQL／本文保存先／Browser／macOS Native、別Server、既存CI、証拠台帳。
- **実行**：第10章の採用検証をまとめて行う。A-01〜11とV-IDを一件ずつ実施結果へ対応付ける。認可は許可と拒否、共有停止競合は両順序、事故復旧は確定前と確定後を含める。
- **回帰**：通常依頼・返信・コメントの意味、DM分離、既定Agent、Room自動学習、Room／Agent知識の実行時利用、成果物保存、Workspace再認可、export / restoreを影響範囲で確認する。
- **進め方**：E2Eを阻まない問題は記録して一連の検証を先に完走する。漏えい・破損・全体を阻む問題は該当経路を止め、独立経路は継続する。確認した修正必須事項をまとめて修正し、影響範囲だけ再検証する。
- **レビュー**：第10.4節の分類で設計逸脱と未確認を整理し、任意改善を完成条件へ追加しない。別Agentレビューを採用する場合も動作証拠の代わりにしない。
- **完了・次へ**：第11章の全体条件が揃った時点で終了する。環境・利用者確認が不足する場合は実装と確認到達点を分けて引き渡し、スプリント全体を完了扱いしない。commit・push等へ自動で進まない。

### 8.12 依存関係と作業継続

SI-00→SI-01→SI-02→SI-03を先に成立させる。SI-04検索、SI-05通知、SI-06共有元は基盤成立後に独立して進められる。SI-07は共有元・transaction writerに依存し、SI-08は本人設定・Room／Agent資源・通知概要に、SI-09は検索・通知・共有・取り込みと画面状態に依存する。SI-10は必須接続が揃ってから行う。

これは作業の依存関係であり、サブエージェント起動の指示ではない。複数Agentで作業する場合は明示された運用に従い、共有するDomain API・schema・Bridge・NativeAppの所有を固定する。

途中の未完成状態を利用者向け完成版として公開しない。SI-01・SI-02のmigration・廃止ガード・新writerは整合する単位で適用する。合意済み範囲の実装依頼後は、各工程の区切りで続行確認を挟まず、実装・必要な修正・検証まで進める。

## 9. 品質上の注意点と参照OSS

設計に挙げたBuzzの次のコードだけを確認した。固定revisionの公開ソースとローカル参照コードを読み、CommunityRailは取得バイト列の一致も確認した。Buzzの実機動作は検証していない。

| 参照コード | 確認した実装方法 | Samuraiで守る違い |
| --- | --- | --- |
| [useCommunityUnread.ts](https://github.com/block/buzz/blob/b36600fc440615e2565f94bffc800e0495180f6b/desktop/src/features/communities/useCommunityUnread.ts) | 未観測・取得中・成功・失敗の区別、非選択対象の観測、effect終了後応答の無視・timer解除 | 通知件数はメンション数ではなく現在認可可能な本人通知。Account＋connection＋Workspace＋画面世代で照合し、active接続を変更しない |
| [CommunityRail.tsx](https://github.com/block/buzz/blob/b36600fc440615e2565f94bffc800e0495180f6b/desktop/src/features/sidebar/ui/CommunityRail.tsx)のcommunityRailIndicators | 件数・点の表示判定を純粋関数へ分け、観測成功だけを信用し、操作名を付ける | Workspace上部popoverで設計の未確認表示を出す。Community rail、DND、メンション概念、MAX_BADGE値を導入しない |

SI-00で実装者も上記該当関数を理解する。OSSの楽観既読やpoll方式をそのまま採用せず、Samuraiの保存成功・未解決状態・Account stream・Query復元を優先する。

特に注意するのは、Workspace scope一括削除、巨大なNativeAppへの全ロジック集中、Agent知識へRoom学習を混入、Server取得時の宛先認可漏れ、別originへの署名転送、ファイル確定前のAgent公開、同期冪等台帳によるstagingの成功扱い、元の公開範囲・source情報の自動複製、設定遷移によるstreamの再起動である。

## 10. レビューと検証

### 10.1 採用する検証

コマンドは現行`package.json`・CIから確認した。以下は実装時に行う計画であり、本書作成時には実行していない。新規テスト・検証入口が必要な場合は、対象責務の既存test／実DB verifierへ接続し、実在する入口を作業記録へ追記する。

| 検証 | 採用理由・対象 | 実行時期と入口 | 合格条件・未実行時の扱い |
| --- | --- | --- | --- |
| 文書・差分 | 参照、用語、証拠と設計の混同を防ぐ | プラン保存時、文書変更時、最終にリンク・Mermaid・`git diff --check` | リンク先と番号が存在し、差分書式違反なし。図を追加した場合は構文確認。文書passを実動作passにしない |
| Lint／source quality | TypeScript・React・公開命名・source規約の回帰 | 工程境界で対象に応じて、最終CIの`pnpm verify:source-quality` | 今回差分の規約違反なし。format:check／lintは同じscriptのため重複実行しない |
| 対象typecheck | 公開型・scope・Bridge／IPC・実行入力の接続 | 境界変更時と該当工程末。`pnpm --filter @samurai-agent/domain-api --filter @samurai-agent/workspace-server --filter @samurai-agent/server --filter @samurai-agent/web --filter @samurai-agent/desktop run typecheck`から変更先を選ぶ | 選んだ対象・利用元に型エラーなし。最終全体typecheckはCIを利用。未実行対象は明記 |
| Focused／関連Regression | 権限、版、再送、変換、対象guard、既存依頼・成果物契約 | 各工程末。`pnpm exec vitest run`へ第4.2節の関連実在testと追加したtestを指定 | 正常・拒否・事故条件がpass。skip・中断・test未整備は未検証。静的描画を操作testの代わりにしない |
| Architecture／契約 | Client・Core・Runtime境界と新契約の登録漏れ | module境界変更時と統合時に`pnpm verify:architecture`、`pnpm core:domain-contracts:verify` | 依存境界と実装した契約の整合が成立。新契約を検査対象から除外しない |
| Migration／RLS／Core Integration | DB制約・現在認可・競合・bundleはmockで証明できない | SI-02・05〜07。関連実DB probeを専用DBへ接続。`pnpm verify:postgres-migration:static`は静的補助、`pnpm verify:postgres-deep`は既存深掘り回帰 | V-D／V-Pに対応する実DBのallow／deny・事故・再実行がpass。既存verifierだけで新共有・通知を確認したことにしない |
| Web／Desktop build・smoke | Browser共有画面とElectron preload・protocolの接続 | SI-09〜10。`pnpm --filter @samurai-agent/web run build`、`pnpm desktop:build`、`pnpm desktop:verify` | production bundle生成、起動・接続・share入口の動作。buildpassだけでOSの操作確認済みにしない |
| 実Client E2E・操作性 | 全画面復帰、IME、focus、IndexedDB、未保存入力、リンク→取り込み | SI-08〜10。BrowserとmacOS ElectronでUI-01〜11、A-01〜11の該当操作 | 実画面→API→実DB／本文→画面結果が一致。3テーマ、通常・狭幅、キーボードを確認。未実施経路は未検証 |
| 実Agent・学習・Context回帰 | Agent知識と本人設定を実行へ渡す変更の実証 | SI-10。設定済みSamurai Native接続で通常依頼・再試行・学習・再利用・共有Agent利用 | 実出力と出所reference、Room境界、非自動実行を確認。外部CLI本人確認の代替にしない |
| 共有のSecurity確認 | 署名、公開境界、SSRF、描画、監査非漏えい | SI-06・07・09。V-P06、直接HTTP、改ざん・第三者・非公開宛先・過大入力・内部参照 | 設計の拒否と安全な出力が成立。依存auditだけで認可を証明しない |
| 一覧・ページ処理の確認 | 全本文Client取得と操作停止を防ぐ | SI-04・05・09で複数ページと取得失敗、実Clientの検索中操作を確認 | Page契約、認可前件数なし、入力・画面操作の継続。未合意の負荷SLA・coverage値を追加しない |
| 既存CI | 全体回帰・3OSの既存静的／test／build・PostgreSQL深掘り | 明示されたpush／PR等の後、`.github/workflows/ci.yml`の既存jobs | 必須jobのpassを記録。未実行・skip・失敗を成功扱いしない。計画だけでGit操作を許可しない |

全体test、全Core verifier、全OS Native GUI、全Backend live、関係しない性能試験を各工程へ機械的に追加しない。既存CI設定の刷新は対象外。新規検証は通常のtest探索・既存verifierで実行可能な配置にし、必要な接続だけ行う。実DB検証用の入口は、変更したschema・認可関数・資源writer・通知／共有Coreを対象にし、SQLiteやmock用経路への置き換えでpassにしない。

### 10.2 実環境の条件と証拠を分ける

- 実DBはruntime roleのRLSを有効にし、admin接続での成功だけを許可証拠にしない。削除・事故注入は専用検証DBと隔離保存先で行う。
- 共有は発行者、正規受信者、対象外利用者、未ログインを使う。Room／Workspace管理者でも他人DMを読めない条件を確認する。
- 別Server取り込みは共有元と宛先を別のServerとして動かし、同じWorkspace IDの衝突、再署名、再接続、一方の不通を確認する。単一Server内の二つのWorkspaceだけで代替しない。
- Hosted／Self-hostでは今回変更した検索・通知・共有・取り込み・復元の経路を確認する。Self-hostは運用allowlistを含む。CIの一つのPostgreSQLサービス内に二DBを作った証拠と、独立した配置先の証拠を分ける。利用できない配置は未検証のまま残す。
- Native GUIは今回の現行確認環境であるmacOS Electronを対象にする。Windows／Linuxは既存CIの確認範囲とし、実GUIを確認したとは記載しない。署名・installer・自動更新を追加しない。
- 実Agentは既存設計の担当境界に従い、実装担当はSamurai Nativeの設定済み検証接続を使う。Codex／Claude Codeの実CLIは起動せず、必要な本人確認と共通契約の技術検証を分ける。providerを製品として限定しない。

### 10.3 作業記録・再開・証拠台帳

実装開始後の記録先を`reports/native-ui-workspace-context-sharing/report.md`、必要な証拠を同フォルダの`evidence/`とする。本書作成だけで未実行の検証reportを作らない。

実装者は、要件ID・確認ID、工程、変更先、実際の手順／コマンド、commitまたは作業差分識別、環境、期待結果、観測結果、証拠参照、状態（未着手／実装中／確認待ち／pass／fail／未検証）を対応付ける。secret、本文全量、限定locator、署名を通常ログへ残さない。

長時間作業の区切りでは実装済み範囲、必要な残作業、確認結果、承認済み範囲、停止条件、次工程を記録する。再開時は記録・現在差分・対象環境を照合し、完了工程を理由なくやり直さない。

### 10.4 レビューと修正の終わり方

工程末に実装者が設計節・要件ID・差分・検証結果を照合する。認可・migration・取り込み一括確定・復元などの高危険度差分と、最終統合では、利用可能な場合に読み取り専用の別Agentレビューを採用する。担当にR・D1〜D4・本計画・差分・証拠・前回判断を渡し、範囲外の設計を依頼しない。

指摘は「今回の修正必須／追加調査／任意改善／対象外」に分類する。修正必須は違反する要件、発生条件、コード根拠、影響、既存対策で防げない理由を示す。未検証は不具合と断定せず、完了に必要な確認は実施する。

修正後は修正箇所・影響経路だけを再レビュー・再検証する。新しい変更・失敗・根拠がなければ解決済み指摘を蒸し返さず、任意改善を全体完了の阻害条件にしない。Reviewerの自己申告や指摘0件だけで実動作passにしない。

## 11. 完了条件・未決定・未検証

### 11.1 スプリント全体の完了条件

1. Rの対象要件がすべて実装され、D1〜D4の今回差分を省略せず満たす。UI-01〜UI-11と公開API・共通Core・DB・本文・実行への必要接続が揃う。
2. A-01〜A-11、V-D01〜07、V-P01〜08、V-UI01〜07を対応する実結果で判定し、必須確認にfail・未検証が残らない。同じ実行証拠が複数IDを支える場合は参照を共有してよいが、判断は各IDへ記録する。
3. WorkspaceメモリーがUI、API、Core、索引、実行、旧入力、復元から利用・再生成できず、対象外データが保持される。
4. Room知識とAgent構成が確認済み内容だけで限定／公開共有でき、別Serverにも独立取り込みできる。停止競合・並行再送・事故・権限取消でも部分公開や無断上書きが起きない。
5. 実PostgreSQL、実Server、実本文保存先、Browser、macOS Native、実Agentの今回必要な受入・回帰証拠が揃う。Hosted／Self-hostの配置確認、既存CI、利用者のUI確認の到達点も個別に記録する。
6. 必須修正と完了に必要な未確認が解消し、利用者が今回の操作を確認できる。別Agentレビューを採用した場合は根拠のある必須指摘が解消している。

### 11.2 未決定事項と現時点の未検証

プランを作るために追加の製品判断が必要な事項は、今回の読み取りでは見つかっていない。公開範囲・権限・画面方式・コピー・廃止方針は設計に従う。工程順序は本計画の提案として扱う。

現在は実装前であり、新規契約、migration・RLS、本文復旧、別Server取り込み、実Client、実Agent、Hosted／Self-host配置、今回差分のCI、利用者UI確認はすべて未検証。環境不足があっても独立した実装・確認は続けるが、必要な証拠が揃う前に全体完了とは報告しない。

引き渡し時は「実装済み」「静的・focused確認済み」「実DB／本文確認済み」「Browser／macOS Native確認済み」「実Agent確認済み」「別Server確認済み」「Hosted／Self-host確認済み」「CI」「利用者確認」を分ける。プラン作成完了、工程の実装完了、技術確認完了、スプリント全体完了を混同しない。
