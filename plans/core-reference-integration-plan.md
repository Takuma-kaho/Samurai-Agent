# Samurai Agent Core 追加スコープ台帳

作成日: 2026-07-12

最終見直し日: 2026-07-13

対象: 参照OSS比較で満点3点に達していなかった機能（0〜2点）

状態: **追加スコープ台帳。実装計画ではない**

## 0. この文書の位置づけ

この文書は、参照OSSとの比較で見つかった90項目を、Samurai Agentへ取り込むか判断するための台帳である。

比較表は検討材料であり、Samurai Agentの正本ではない。判断が衝突した場合は、次の順で正本を優先する。

1. [`PRINCIPLES.md`](../PRINCIPLES.md)
2. [`ARCHITECTURE.md`](../ARCHITECTURE.md)
3. [`PUBLIC_NAMING.md`](../PUBLIC_NAMING.md)
4. [`WEB_UI_DESIGN.md`](../WEB_UI_DESIGN.md)
5. [`core-completion-plan.md`](./core-completion-plan.md) と関連する実装・検証結果
6. 本台帳

文書間の関係は次のとおり。

```text
正本ドキュメント
  ↓
既存Core完成計画と実装
  ↓
本台帳で追加候補・接続候補・後続候補を整理
  ↓
core-additional-scope-implementation-plan.mdで実装順と完了条件を決める
```

本台帳だけを根拠に実装へ着手しない。現在の実装を再確認し、追加作業が必要な項目だけを実装計画へ渡す。

### 0.1 台帳のルール

- 3点満点だった機能は記載しない。
- 対象は0点、1点、2点の機能だけとする。
- 判定は **`Core追加候補`**、**`接続契約`**、**`製品後続`**、**`対象外`** の4区分とする。
- `Core追加候補`は、Coreへ必要な契約・永続化・Runtime・最小Surfaceを実装計画で再確認する。
- `接続契約`は、Codex／Claude Code／MCPへ実行を任せ、Samurai側はCapability検出、設定、event正規化、失敗説明、接続テストだけを持つ。
- `製品後続`は、Installer、Onboarding、Auto UpdateなどCore完成後の製品化・配布トラックへ送る。
- `対象外`は、今回のCoreへ専用実装も接続保証も追加しない。
- 同じ機能が複数OSSに登場する場合も元の項目は残すが、実装パッケージは共通化する。

点数は比較表作成時点の実装度を表す。現在の実装状況や完了判定を表すものではない。

| 点 | 意味 |
| ---: | --- |
| 0 | 未実装 |
| 1 | 土台だけ存在する |
| 2 | 主要部分はあるが完成条件に届いていない |

## 1. 台帳としての結論

90項目をCore中心に再分類した結果は次のとおりである。

| 区分 | 項目数 | 扱い |
| --- | ---: | --- |
| Core追加候補 | 39 | 新しい実装計画で現状確認し、未完成部分だけ実装する |
| 接続契約 | 4 | Backendへ任せるが、利用可否と結果をSamuraiから確認できるようにする |
| 製品後続 | 5 | Desktop製品化・配布トラックへ送る |
| 対象外 | 42 | 今回のCoreへ専用実装を追加しない |
| 合計 | 90 | 添付表の全項目と一致 |

大きな判断は次のとおりである。

| 論点 | 最終判断 |
| --- | --- |
| Subagent | 独自schedulerは作らない。Backend側の機能を使い、Capability検出と親runへの結果接続だけを持つ |
| Web検索 | Codex／Claude Codeの検索機能を使う。独自検索エンジンは作らず、同じ非対話起動経路での接続テストを必須にする |
| Browser操作 | BackendまたはMCP adapterへ任せる。単なるHTML取得を本物の画面操作・screenshotとして扱わない |
| AIモデルの自動切替 | 不必要。選択したCodex／Claude Codeを無断で切り替えない |
| Prompt Cache | Samurai独自実装は不必要。外部実行エージェント側の仕組みを使う |
| WYSIWYG Editor | CoreではArtifact edit commandとrevision契約を持つ。完成した製品Editorの見た目は後続とする |
| Image生成・編集 | Coreでは生成・編集結果をprovenance付きArtifact revisionへ戻す共通経路を持つ |
| Mind map | Coreではnode／edge schema、renderer、Domain Command、再読込を持つ汎用Surfaceとする |
| RSS・News Inbox | 専用Core機能は不必要。Collection／Plugin／Custom Surfaceから作れる状態にする |
| 3D・Voice・Mobile node | 不必要。今回の完成形へ含めない |

## 2. 会話を反映して変更した判定

添付表の初回判定から、セッション内の議論によって次を修正した。

| 機能 | 添付表の初回判定 | 再判定 | 修正理由 |
| --- | --- | --- | --- |
| AIモデルの自動切替 | 必要 | 対象外 | Codex／Claude CodeはSessionと実行状態を持つため、無断切替は一貫性を壊す |
| Subagent | 必要 | 接続契約 | Backend内部のdelegationを使い、Samurai独自schedulerは作らない |
| Browser操作 | 必要 | 接続契約 | BackendまたはMCP adapterの利用可否を実行時に検出し、HTML取得fallbackと画面操作を区別する |
| Web検索 | 必要 | 接続契約 | CodexのWeb searchとClaude CodeのWebSearchを使い、独自検索エンジンは作らない |
| OpenClaw Browser automation | 必要 | 接続契約 | Samurai固有Browser engineは作らず、共通Browser capabilityへ統合する |
| WYSIWYG Editor | 不必要 | Core追加候補 | ArtifactのGUI編集とChat編集を同じrevisionへ戻すCore契約が必要 |
| Image生成・編集 | 不必要 | Core追加候補 | Codex、MCP、画像API等の結果をArtifactとして扱う共通経路が必要 |
| Mind map | 不必要 | Core追加候補 | 固定アプリではなく、再利用可能な汎用Rendererとして有効 |

## 3. 機能別スコープ判定

### 3.1 Hermes Agent由来

| ID | 機能 | 点 | 非エンジニア向け説明 | 台帳区分 | Samurai側の扱い | 引き渡し条件 |
| --- | --- | ---: | --- | --- | --- | --- |
| H01 | AIモデルの使い分け | 2 | 仕事に応じてGPT、Claude、Geminiなどを選ぶ機能 | Core追加候補 | 現在のBackend選択を全入口で一貫させる | Web、Gateway、Automationで選択Backendと実runが一致する |
| H02 | AIモデルの自動切替 | 2 | 利用中のAIが失敗したら別のAIで続ける機能 | 対象外 | 選択した外部実行エージェントを無断変更しない | Codex↔Claude Codeの自動切替を追加しない |
| H03 | API keyのPool | 0 | 複数のAPI keyを順番に使い、利用制限を回避する機能 | 対象外 | 個人利用Coreへ複数key運用を持ち込まない | key rotation／quota回避機能を追加しない |
| H04 | Prompt Cache | 0 | 毎回送る共通説明を再利用し、料金と待ち時間を減らす機能 | 対象外 | Codex／Claude Code側のcacheを利用する | Samurai独自prompt cacheと無効化管理を追加しない |
| H05 | 外部Memory Provider | 1 | 他社サービスに利用者の好みや履歴を覚えてもらう機能 | 対象外 | WorkspaceをMemoryの正本にする | 外部Memoryを正本にするadapterを追加しない |
| H06 | Skillの自動改善 | 2 | 一度覚えた作業手順を、利用結果を見ながら改善する機能 | Core追加候補 | Learning結果からSkill改訂を完成させる | 利用→評価→改訂→rollbackが自動証拠付きで通る |
| H07 | Curator | 2 | 増えすぎた記憶や手順を整理し、重複や矛盾を減らす機能 | Core追加候補 | 重複整理、保護、archive、rollbackを完成させる | snapshot、pin、整理、rollbackを一連で実行できる |
| H08 | 定期実行 | 2 | 「毎朝9時」など、指定した時間に自動で仕事を始める機能 | Core追加候補 | Automationの作成・停止・再開・履歴を完成させる | 再起動をまたいで一度だけ実行され、結果が残る |
| H09 | Messaging連携 | 1 | LINE、Slack、TelegramなどからSamuraiへ依頼する機能 | 対象外 | 代表的な既存入口だけを使い、対応数を増やさない | 全Messaging対応を完成条件にしない |
| H10 | 大量の内蔵Tool | 1 | 検索、画像、音楽、家電操作などを最初から大量に持つ機能 | 対象外 | Codex／Claude Code、MCP、Pluginの機能を使う | Coreへ用途別Tool群を追加しない |
| H11 | 複数の実行環境 | 1 | PC、Docker、クラウドなど、異なる場所で作業を実行する機能 | 対象外 | 現在のlocal／sandbox／remote境界で十分とする | 新しい実行環境の追加を完成条件にしない |
| H12 | Subagent | 1 | 大きな仕事を複数の小さなAI担当者へ分ける機能 | 接続契約 | Backend内部のSubagentを利用し、Samurai独自schedulerは作らない | 同じ非対話起動経路で利用可否を検出し、親runへ結果と失敗理由を戻せる |
| H13 | Browser操作 | 1 | AIがWebページを開き、クリックや入力を行う機能 | 接続契約 | BackendまたはMCP browser adapterを利用する | navigate／click／input／実screenshotの可否を検出し、HTML snapshot fallbackと区別できる |
| H14 | Web検索 | 1 | AIがインターネットを検索して情報を集める機能 | 接続契約 | Codex／Claude Code内の検索機能を利用する | CodexとClaude Codeの同じ非対話起動経路から検索eventとsourceを正規化できる |
| H15 | 画像・動画生成 | 0 | 指示から画像や動画を作る機能 | 対象外 | Hermes型の大量内蔵media Toolは採用しない。画像体験はM06へ一本化する | 動画生成とHermes型media Tool群を追加しない |
| H16 | 音声会話・読み上げ | 0 | 声で依頼し、声で回答を聞く機能 | 対象外 | テキストChatを中心にする | 音声入力、通話、TTSをCoreへ追加しない |
| H17 | Memory安全検査 | 2 | 危険な指示や秘密情報を記憶へ保存しないための検査 | Core追加候補 | 既存Memory validationを必要最小限で完成させる | secretと外部instructionをMemory正本へ混入させない |
| H18 | Plugin管理 | 2 | Coreを書き換えずに新しい機能を追加・削除する仕組み | Core追加候補 | install、enable、disable、version、失敗表示を完成させる | Pluginを追加・停止・更新してもCoreが壊れない |
| H19 | TUI | 0 | ターミナル画面だけでSamuraiを操作する機能 | 対象外 | GUI-firstを採用する | 独立TUI製品を追加しない |
| H20 | Desktop Shell | 2 | 常駐、通知、ショートカット、スクリーンショットを扱うデスクトップアプリ | 製品後続 | Core境界は既存実装で維持し、OS統合の磨き込みは製品トラックへ送る | Core追加計画の完了条件に含めない |
| H21 | OpenAI互換API | 0 | 他のChatアプリからSamuraiをAIサーバーとして利用する機能 | 対象外 | Samuraiを汎用AI serverにしない | OpenAI互換endpointを追加しない |
| H22 | IDE連携 | 0 | VS Codeなどの開発画面からSamuraiを使う機能 | 対象外 | コーディング専用製品にしない | IDE専用protocol／extensionを追加しない |
| H23 | Batch実行 | 0 | 大量の質問や仕事をまとめて処理する研究・業務向け機能 | 対象外 | Personal Agentの対話とAutomationへ集中する | 専用Batch API／画面を追加しない |
| H24 | Trajectory保存 | 0 | AIの行動履歴を機械学習用データとして保存する機能 | 対象外 | 監査履歴は残すが学習データ製造機能は持たない | ML用trajectory exportを追加しない |
| H25 | Skills Hub | 1 | 他人が作ったSkillを検索・インストールする市場 | 対象外 | Skill形式とlocal installだけを扱う | Marketplace、評価、販売機能を追加しない |

### 3.2 OpenClaw由来

| ID | 機能 | 点 | 非エンジニア向け説明 | 台帳区分 | Samurai側の扱い | 引き渡し条件 |
| --- | --- | ---: | --- | --- | --- | --- |
| O01 | 多数の外部Channel | 1 | Discord、WhatsApp、Signalなど多くのサービスから利用する機能 | 対象外 | 代表的な既存Channelだけを使う | Channel数を増やさない |
| O02 | Session振り分け | 2 | 届いたメッセージを正しい会話の続きへつなぐ機能 | Core追加候補 | Gatewayから同じSessionへ確実に戻す | 同一threadは同一Session、別threadは別Sessionへ入る |
| O03 | Pairing | 2 | 初めて接続する相手に確認コードを出し、所有者が許可する機能 | Core追加候補 | 初回接続の承認・拒否・取消を完成させる | 未承認入力が実行されず、承認後だけ利用できる |
| O04 | Allowlist | 2 | 許可した人やサービスだけから依頼を受ける機能 | Core追加候補 | 許可対象の管理と適用を完成させる | 未登録相手を拒否し、変更履歴を追跡できる |
| O05 | Group mention制御 | 1 | グループ内で名前を呼ばれた時だけ応答する機能 | 対象外 | グループBotを主用途にしない | mention専用policyを追加しない |
| O06 | 外部Multi-agent | 1 | 複数の独立したAIを利用者や会話ごとに割り当てる機能 | 対象外 | 1 owner、1主Agent、差し替え可能Backendを前提にする | 別人格Agent routingを追加しない |
| O07 | 長文の分割送信 | 2 | 長い回答をMessagingアプリの制限に合わせて分割する機能 | Core追加候補 | 採用済みChannelの上限に合わせて順序付き送信する | 長文が欠落・逆順・重複なしで届く |
| O08 | 35以上のAI Provider | 1 | 非常に多くのAIサービスからモデルを選ぶ機能 | 対象外 | Codex、Claude Code、主要adapterに集中する | Provider数を完成条件にしない |
| O09 | Provider OAuth | 0 | API keyを入力せず、WebログインでAIサービスと接続する機能 | 対象外 | Coreではなく各Backendの認証方式を使う | 汎用OAuth brokerを追加しない |
| O10 | 画像・文書の外部送信 | 1 | 作ったPDFや画像をSlackやLINEなどへ返す機能 | Core追加候補 | Artifactを採用済みChannelへ送れるようにする | PDF／画像を参照付きで送信し、失敗を再試行できる |
| O11 | Voice Call | 0 | 電話を通してAIと会話する機能 | 対象外 | 電話Agentにしない | 通話providerを追加しない |
| O12 | Browser automation | 1 | Webサイトを自動で操作する機能 | 接続契約 | H13と同じBrowser capabilityへ統合し、BackendまたはMCP adapterを使う | CoreへBrowser engineを追加せず、実操作の可否・event・成果物を共通契約で確認できる |
| O13 | 複数の検索サービス | 1 | 検索先が失敗した時に別の検索サービスを使う機能 | 対象外 | 主実行エージェントの検索経路を使う | 検索provider poolを追加しない |
| O14 | Cron | 2 | 決まった日時に仕事を実行する機能 | Core追加候補 | H08と同じAutomation実装へ統合する | 予定作成、実行、停止、履歴が通る |
| O15 | Heartbeat | 2 | Samuraiが定期的に起きて、仕事が残っていないか確認する機能 | Core追加候補 | unfinished workとGateway状態を定期確認する | zombie回収と未完Work再開が決定的に動く |
| O16 | Commitment推測 | 0 | 会話から「後で確認する約束」をAIが推測して登録する機能 | 対象外 | 明示Objective／Automationだけを使う | 推測だけで予定を自動登録しない |
| O17 | Skill | 2 | よく行う仕事の手順を保存して再利用する機能 | Core追加候補 | H06と同じLearning loopへ統合する | 保存、検索、利用、改善、停止を一連で行える |
| O18 | Plugin SDK | 2 | 第三者がSamurai向け機能を追加するための開発基盤 | Core追加候補 | H18とFrontend Plugin Runtimeの共通SDKを完成させる | ToolとSurfaceを1つのmanifestで追加できる |
| O19 | Workflow DSL | 1 | 複数の処理を専用のルール言語でつなぐ機能 | 対象外 | Objective、Work Item、Domain Commandを使う | 新しい専用DSLを追加しない |
| O20 | Docker Sandbox | 2 | AIの作業を隔離された箱の中で実行する機能 | 対象外 | 現行Sandbox境界を保ち、Docker固有完成を求めない | Docker固有実装・実Docker試験を本計画へ追加しない |
| O21 | Channel別Tool制限 | 2 | LINE経由ではファイル削除禁止など、入口ごとに権限を変える機能 | Core追加候補 | 既存Gateway boundary policyを完成させる | Channelごとの許可・拒否がDomain Command前に適用される |
| O22 | Control Dashboard | 2 | Gateway、接続先、実行状況を管理する専用画面 | 対象外 | Chat、Run History、Settingsへ統合する | 独立Dashboardを追加しない |
| O23 | Desktop app | 2 | PCに常駐して通知やショートカットを扱うアプリ | 製品後続 | 既存のCore／Desktop境界を維持し、OS統合の磨き込みは製品トラックへ送る | Core追加計画の完了条件に含めない |
| O24 | Windows専用アプリ | 0 | Windows向けに別の管理アプリを提供する機能 | 対象外 | 現段階ではmacOS中心とする | Windows専用Shellを追加しない |
| O25 | iOS・Android node | 0 | スマートフォン自体をSamuraiの操作端末として登録する機能 | 対象外 | Mobile nodeを本体にしない | device node protocolを追加しない |
| O26 | Camera・位置情報 | 0 | スマートフォンのカメラや現在地をAIが利用する機能 | 対象外 | Mobile nodeを持たない | camera／location commandを追加しない |
| O27 | Remote node管理 | 1 | 別のPCやスマートフォンを遠隔操作する機能 | 対象外 | Gatewayを端末管理基盤にしない | device fleet管理を追加しない |
| O28 | Doctor | 2 | 設定や保存データを検査し、不具合の原因を教える機能 | Core追加候補 | Diagnosticsを非エンジニア向けの診断結果へまとめる | 原因、影響、直し方を画面とCLIで確認できる |
| O29 | Installer | 1 | ダウンロードして簡単にインストールできる仕組み | 製品後続 | macOS向け導入経路は配布トラックで扱う | Core追加計画の完了条件に含めない |
| O30 | Onboarding | 1 | 初回起動時にAIやWorkspaceを案内付きで設定する機能 | 製品後続 | Backend、Workspace、基本設定の案内は製品UIトラックで扱う | Core追加計画の完了条件に含めない |
| O31 | Auto Update | 1 | 新しいバージョンへ自動更新する機能 | 製品後続 | Desktop Shellの更新確認と適用は配布トラックで扱う | Core追加計画の完了条件に含めない |
| O32 | Directory | 1 | Messagingサービス内の人やグループを検索する機能 | 対象外 | 組織向けBot機能を持たない | Directory同期を追加しない |
| O33 | Ambient room | 1 | 名前を呼ばれていない会話も静かに読み続ける機能 | 対象外 | 明示された入力だけを処理する | 常時傍受機能を追加しない |

### 3.3 MulmoClaude由来

| ID | 機能 | 点 | 非エンジニア向け説明 | 台帳区分 | Samurai側の扱い | 引き渡し条件 |
| --- | --- | ---: | --- | --- | --- | --- |
| M01 | Chat + Canvas | 2 | 会話の横に、表・文書・画像などの作業画面を開く機能 | Core追加候補 | Chatから必要時だけSurfaceを出す体験を完成させる | 生成、再表示、reload、Chat復帰が一連で動く |
| M02 | Document表示 | 2 | 作成した文書を読みやすい形で表示する機能 | Core追加候補 | Artifact previewを完成させる | Markdown／文書Artifactを再読込後も表示できる |
| M03 | Document Export | 2 | 作成した成果物をPDFなどで外へ出す機能 | Core追加候補 | Artifact正本からexportする | 最低PDF exportが成功し、元revisionを追跡できる |
| M04 | WYSIWYG Editor | 0 | Wordのように画面上で自由に文章を編集する機能 | Core追加候補 | Artifact editorとして実装する | GUI編集とChat編集が同じrevision履歴へつながる |
| M05 | Chart | 2 | 数字や比較結果をグラフで表示する機能 | Core追加候補 | 汎用Chart Surfaceを完成させる | Collection／Artifactの数値からChartを生成・復元できる |
| M06 | Image生成・編集 | 0 | 指示から画像を作ったり修正したりする機能 | Core追加候補 | 既存のCodex機能、MCP、画像API等を利用し、結果をArtifactへ統一する | 生成→表示→編集→revision保存を最低1経路で通す |
| M07 | Mind map | 1 | 情報の関係を枝分かれ図で表示する機能 | Core追加候補 | 汎用Rendererとして実装する | node／edgeを生成・編集・再読込できる |
| M08 | 3D Scene | 0 | 立体的な画面やモデルを表示する機能 | 対象外 | Coreへ3D Runtimeを持ち込まない | 3D rendererを追加しない |
| M09 | Story/Guide renderer | 1 | 旅行案内や物語を専用レイアウトで表示する機能 | 対象外 | Artifact／Custom Surfaceで表現する | 専用Story／Guide rendererを追加しない |
| M10 | Todo専用アプリ | 2 | タスクを一覧、表、Kanbanで管理する専用画面 | 対象外 | 汎用Collection templateで作る | Todo専用DB／routeを追加しない |
| M11 | Scheduler UI | 2 | 自動実行する仕事を一覧・停止・再開する画面 | Core追加候補 | Automation管理Surfaceを完成させる | 予定、次回実行、停止、再開、履歴を操作できる |
| M12 | Calendar表示 | 2 | 予定や期限をカレンダーで見る機能 | Core追加候補 | Collection／AutomationのCalendar表示を完成させる | 予定作成・変更・再読込が同じ正本へ反映される |
| M13 | Wiki閲覧 | 2 | Samuraiが蓄積した知識をページ単位で読む機能 | Core追加候補 | Knowledge Wikiの検索・閲覧を完成させる | page、source、linkを画面から確認できる |
| M14 | Wiki lint | 2 | 壊れたリンク、重複、孤立したページを調べる機能 | Core追加候補 | Wiki品質検査と修正候補を完成させる | broken link、duplicate、orphanを検出できる |
| M15 | Wiki backlink | 1 | その知識を参照している他ページを表示する機能 | Core追加候補 | 逆参照indexと表示を追加する | pageごとに参照元一覧を再生成できる |
| M16 | RSS・Feed | 0 | 登録したWebサイトの新着記事を自動収集する機能 | 対象外 | 専用Core機能にせず、Plugin／Collectionから作れるようにする | RSS専用service／routeを追加しない |
| M17 | News Inbox | 0 | 集めた記事を未読・既読で管理する機能 | 対象外 | Collection template／Custom Surfaceとして作る | News専用DB／固定アプリを追加しない |
| M18 | File Inspector | 1 | Workspace内のファイルを必要な時だけ確認する画面 | Core追加候補 | Workspace Peekから必要なファイルだけ確認できるようにする | file、metadata、由来、関連resourceを表示できる |
| M19 | Skill管理UI | 2 | 覚えた作業手順を一覧・編集・停止する画面 | Core追加候補 | Skillの一覧、編集、無効化を完成させる | Skill本文、利用履歴、状態を確認・変更できる |
| M20 | Role管理 | 1 | 「先生」「旅行案内役」など、AIの役割を切り替える機能 | 対象外 | SOUL、Profile、Skillを組み合わせる | 別のRole管理体系を追加しない |
| M21 | Attachment処理 | 2 | PDF、画像、Word、ExcelなどをChatへ渡す機能 | Core追加候補 | 添付をArtifact化し、主実行エージェントへ渡す | 代表形式の取込、由来、失敗説明が通る |
| M22 | Frontend Plugin Runtime | 2 | Pluginが独自の画面をChatやWorkspaceへ表示する仕組み | Core追加候補 | ToolとSurfaceを同じPlugin manifestから登録する | Plugin Surfaceを表示し、Domain Commandを実行できる |
| M23 | Plugin Error Boundary | 1 | Pluginが壊れてもアプリ全体を巻き込まず、その画面だけ停止する機能 | Core追加候補 | Plugin単位の失敗表示と復旧を追加する | Plugin例外時もChat／Workspace本体が動き続ける |
| M24 | 自動Docker | 2 | Dockerがあれば自動的に隔離環境を使う機能 | 対象外 | Dockerを自動選択・強制しない | Docker検出による自動切替を追加しない |
| M25 | Remote phone access | 1 | 外出先のスマートフォンから自宅のSamuraiへ接続する機能 | 対象外 | Mobileを本体にしない | phone専用access機能を追加しない |
| M26 | 多数のMessaging Bridge | 1 | 多くのChatサービスを別プログラムで接続する機能 | 対象外 | 代表的な既存Channelだけを使う | Bridge数を増やさない |
| M27 | Logging | 2 | 問題発生時に、内部で何が起きたか記録する機能 | Core追加候補 | run、resource、Plugin、Gatewayを同じ形式で記録する | 代表処理をSessionから原因まで追跡できる |
| M28 | Diagnostics | 2 | 接続、保存、実行状態の異常を利用者へ説明する機能 | Core追加候補 | O28 Doctorと同じ診断基盤へ統合する | 問題、影響、利用者ができる対処を表示できる |
| M29 | Wiki専用画面 | 1 | Knowledge Wikiを検索・閲覧・整理する画面 | Core追加候補 | Workspace内のWiki Surfaceとして追加する | 検索、閲覧、整理、backlinkへ移動できる |
| M30 | Skill専用画面 | 1 | Skillを確認・修正・無効化する画面 | Core追加候補 | M19と同じSkill Surfaceへ統合する | 一覧、詳細、編集、無効化、履歴が使える |
| M31 | Automation専用画面 | 1 | 定期処理を確認・停止・再開する画面 | Core追加候補 | M11と同じAutomation Surfaceへ統合する | 予定、状態、履歴、停止、再開を操作できる |
| M32 | 全機能ごとのScoped Chat | 1 | Wiki画面やSkill画面ごとに別Chatを持つ機能 | 対象外 | 主Chatを1つに保ち、現在のresourceをContextとして渡す | 機能ごとの独立Chatを追加しない |

## 4. 実装計画への引き渡しグループ

この節は実装順ではない。39件のCore追加候補と4件の接続契約を責務別に整理し、[`core-additional-scope-implementation-plan.md`](./core-additional-scope-implementation-plan.md)へ渡すための索引である。

### P0. Backend委譲Capability

対象: H12、H13、H14、O12

- [ ] Codex／Claude Codeの同じ非対話起動経路でCapabilityをprobeする
- [ ] Web検索、Browser読取、Browser操作、Subagentを別Capabilityとして扱う
- [ ] `available`、`unavailable`、`misconfigured`と理由をBackend statusへ出す
- [ ] BackendまたはMCPへ実行を任せ、Samurai独自の検索エンジン、Browser engine、Subagent schedulerは作らない
- [ ] tool event、source、成果物、失敗をSamuraiのBackend eventとWorkspaceへ戻す

引き渡し条件: 「Backendに機能がある」という推測ではなく、Samuraiが実際に使う起動引数・認証・sandboxで利用可否を再現できる。

### P1. Backend選択とLearning loop完成

対象: H01、H06、H07、H08、H17、O14、O15、O17

- [ ] 選択BackendをWeb、Gateway、Automationで統一する
- [ ] Skill利用結果から改訂提案と適用を行う
- [ ] Curatorのsnapshot、pin、整理、rollbackを閉じる
- [ ] AutomationとHeartbeatをDurable Workへ接続する
- [ ] Memory検査はsecretと外部instruction混入防止へ限定する

完了条件: 選択Backendで定期処理を実行し、結果を評価してSkillを改善し、必要なら元へ戻せる。

### P2. Gateway完成

対象: O02、O03、O04、O07、O10、O21

- [ ] Session振り分けを安定化する
- [ ] PairingとAllowlistを一つの接続フローとして完成させる
- [ ] 長文をChannel上限に合わせて順序付き送信する
- [ ] 画像・文書Artifactを外部Channelへ送る
- [ ] Channel別Domain Command制限を適用する

完了条件: 許可済みの外部相手が同じSessionを継続し、長文とArtifactを安全に受け取れる。

### P3. Chat、Canvas、Artifact、Attachment完成

対象: M01、M02、M03、M05、M11、M12、M18、M21

- [ ] Chatから必要時だけCanvas／Surfaceを開く
- [ ] Document previewとPDF exportを完成させる
- [ ] ChartとCalendarを同じWorkspace正本から表示する
- [ ] Scheduler UIでAutomationを操作する
- [ ] File InspectorをWorkspace Peekへ統合する
- [ ] 代表的な添付形式をArtifactとして取り込む

完了条件: 添付資料から文書とChartを作り、Canvasで確認し、PDF出力し、再読込後も同じ状態へ戻れる。

### P4. 編集可能なGenerative UI

対象: M04、M06、M07

- [ ] WYSIWYG Artifact Editorを追加する
- [ ] GUI編集とChat編集を同じArtifact revisionへ接続する
- [ ] Image生成・編集結果をArtifact revisionへ保存する
- [ ] Mind mapを汎用Rendererとして追加する
- [ ] 生成Surfaceの色、順番、内容を会話で改訂できるようにする

完了条件: 文書、画像、Mind mapを生成し、画面とChatの両方から編集し、revisionを戻せる。

### P5. Wiki、Skill、Automation管理Surface

対象: M13、M14、M15、M19、M29、M30、M31

- [ ] Wiki検索・閲覧・整理画面を追加する
- [ ] Wiki lintとbacklinkを追加する
- [ ] Skillの一覧・編集・無効化・履歴画面を追加する
- [ ] Automationの一覧・停止・再開・履歴画面を追加する
- [ ] 個別Chatは増やさず、主Chatへ選択resourceを渡す

完了条件: 利用者がLearningと自動実行の内容を確認し、修正・停止・復旧できる。

### P6. Plugin、Logging、Diagnostics完成

対象: H18、O18、O28、M22、M23、M27、M28

- [ ] ToolとFrontend Surfaceを同じPlugin SDKで登録する
- [ ] Pluginのinstall、enable、disable、versionを管理する
- [ ] Plugin例外を当該Surface内で止める
- [ ] Gateway、Backend、Plugin、Workspace操作を同じ形式で記録する
- [ ] Doctorが非エンジニア向けに原因と対処を説明する

完了条件: 壊れたPluginを入れてもSamurai本体が止まらず、利用者が原因を特定して無効化できる。

### P7. Desktop製品化・配布（Core追加計画の対象外）

対象: H20、O23、O29、O30、O31

- [ ] Desktop Shellの常駐、通知、起動、Core再接続を製品トラックで確認する
- [ ] macOS向けInstallerを製品トラックで作る
- [ ] 初回Onboardingを製品UIトラックで作る
- [ ] Auto Updateと失敗時復旧を配布トラックで作る
- [ ] どの後続トラックでもDesktop側へCoreの正本を複製しない

扱い: 本台帳には残すが、Core追加実装の完了条件・採点・必須gateには含めない。

## 5. 実装上の注意

### 5.1 参照OSSのコードを先に読む

各パッケージの着手時に、READMEだけでなく実装コードを確認する。

| 参照元 | 主に参照する部分 |
| --- | --- |
| Hermes Agent | Skill改善、Curator、定期実行、Memory検査 |
| OpenClaw | Session routing、Pairing、Allowlist、Channel送信、Doctor |
| MulmoClaude | Chat＋Canvas、Artifact、WYSIWYG、Plugin Runtime、管理Surface |

実装記録には、参照commit、参照file、採用した仕組み、変更理由を残す。

### 5.2 安全設計を目的にしない

- 既存のapproval、sandbox、pairing、署名、path制約を使う。
- 新しい安全frameworkを作ること自体を成果にしない。
- Memory検査とChannel制限は、必要な境界だけを完成させる。
- UI操作とLLM操作は同じDomain Commandへ流す。
- 参照OSSより複雑な独自抽象化は、具体的な必要性がなければ追加しない。

### 5.3 Coreをガラクタ化しない

- Subagent scheduler、Browser engine、検索エンジンを二重実装しない。ただしCapability検出、接続、event正規化、失敗説明はCoreの責務として残す。
- RSS Reader、News Inbox、Todoを固定アプリにしない。
- Pluginで追加できる用途固有機能をCoreへ入れない。
- 3D、Voice、Mobile node、全Channel対応を追加しない。
- WYSIWYG、Image、Mind mapは固定アプリではなく、Artifact／Renderer／Surfaceとして実装する。

## 6. 実装計画へ渡す検証候補

### 6.1 この節の扱い

- 以下は比較表から作った検証候補であり、本台帳だけでCore完成を採点しない。
- 文書件数の確認と、利用者が使える機能の確認を同じ点数へ混ぜない。
- 3点項目は台帳から除外しているが、既存Coreの回帰テストからは除外しない。
- 正式なコマンド、固定fixture、失敗系、永続化、既存機能の回帰gateは実装計画側で定義する。
- `Core追加候補`は未実装と決めつけず、現在の実装と既存evidenceを再確認してから作業化する。
- 完成判定は点数ではなく、実装計画にある必須gateの全通過で行う。

### A. 台帳整合性（製品機能の点数には含めない）

| ID | 確認条件 |
| --- | --- |
| A01 | 添付表の0〜2点、全90項目が存在する |
| A02 | 3点満点の機能が混入していない |
| A03 | 全行がCore追加候補、接続契約、製品後続、対象外のいずれかである |
| A04 | 39件、4件、5件、42件の集計が表と一致する |
| A05 | 再判定したBackend委譲機能とGenerative UI機能が最新判断どおりである |

### A2. Backend委譲Capability

| ID | 確認条件 |
| --- | --- |
| X01 | Codexの同じ非対話起動経路でWeb検索の利用可否、mode、source eventを確認できる |
| X02 | Claude Codeの同じ非対話起動経路でWebSearch／WebFetchの利用可否とtool eventを確認できる |
| X03 | Backend内部Subagentを利用できる時は親runへ結果を戻し、利用できない時は理由を表示できる |
| X04 | BrowserのHTML取得、実画面操作、実screenshotを別Capabilityとして判定できる |
| X05 | Backend／認証／CLI version／設定不整合を`unavailable`ではなく具体的な診断として表示できる |

### B. BackendとLearning

| ID | 確認候補 |
| --- | --- |
| B01 | Web、Gateway、Automationで選択Backendが一致する |
| B02 | Skill利用結果から改訂を作成・適用できる |
| B03 | Curatorのsnapshot、pin、整理、rollbackが通る |
| B04 | Automationが再起動をまたいで一度だけ実行される |
| B05 | Heartbeatが未完Workとzombieを処理する |
| B06 | secretと外部instructionがMemory正本へ混入しない |
| B07 | 独自Runtimeを追加せず、X01〜X05の接続契約と失敗説明が通る |

### C. Gateway

| ID | 確認候補 |
| --- | --- |
| C01 | 同一threadが同一Sessionへ戻る |
| C02 | 未承認PairingからCore操作を実行できない |
| C03 | Allowlist変更が次の入力から反映される |
| C04 | 長文が欠落・逆順・重複なく分割送信される |
| C05 | PDF Artifactを採用済みChannelへ送信できる |
| C06 | Image Artifactを採用済みChannelへ送信できる |
| C07 | Channel別Domain Command制限が適用される |
| C08 | Gateway経由の操作がWebと同じWorkspace履歴へ残る |

### D. Canvas、Artifact、Generative UI

| ID | 確認候補 |
| --- | --- |
| D01 | Chatから必要時だけCanvas／Surfaceを開ける |
| D02 | Document Artifactを表示し、reload後も復元できる |
| D03 | Artifact正本からPDFをexportできる |
| D04 | ChartをWorkspaceデータから生成・復元できる |
| D05 | Calendar変更が同じCollection／Automationへ反映される |
| D06 | WYSIWYG編集とChat編集が同じrevision履歴へつながる |
| D07 | Imageを生成しArtifactとして保存できる |
| D08 | Imageを編集し新revisionとして保存できる |
| D09 | Mind mapを生成・編集・再読込できる |
| D10 | 代表的な添付形式をArtifact化して主実行エージェントへ渡せる |

### E. Workspace、Plugin、管理Surface

| ID | 確認候補 |
| --- | --- |
| E01 | File Inspectorでfile、metadata、由来を確認できる |
| E02 | Wikiを検索・閲覧できる |
| E03 | Wiki lintがbroken link、duplicate、orphanを検出する |
| E04 | Wiki backlinkを表示できる |
| E05 | Skillを一覧・編集・無効化できる |
| E06 | Automationを一覧・停止・再開できる |
| E07 | ToolとFrontend Surfaceを同じPlugin manifestで追加できる |
| E08 | Plugin例外時もChat／Workspaceが動き続ける |
| E09 | Pluginのversion、enable、disableを管理できる |
| E10 | Wiki／Skill／Automationから主Chatへ選択resourceを渡せる |

### F. 製品後続の検証候補（Core追加gateには含めない）

| ID | 将来の確認条件 |
| --- | --- |
| F01 | Desktop Shellの常駐、通知、Core再接続が通る |
| F02 | Installerから初回起動できる |
| F03 | OnboardingからBackend設定、Workspace作成、初回Chatまで到達できる |
| F04 | Auto Update後も同じWorkspaceを利用でき、失敗時は戻せる |
| F05 | LoggingとDoctorから問題、影響、対処を確認できる |

### G. 全体統合と非目標

| ID | 確認候補 |
| --- | --- |
| G01 | UI操作とLLM操作が同じDomain Commandへ到達する |
| G02 | Core追加候補39件と接続契約4件が実装計画のいずれかへ対応する |
| G03 | 対象外42件と製品後続5件がCoreへ混入していない |
| G04 | 型検査、unit test、integration testがすべて通る |
| G05 | 現行HEADから既存Core回帰と追加Core gateの証拠を再生成できる |

### 6.2 必須gate

1. Existing Core baseline gate
2. Current HEAD gate
3. Typecheck gate
4. Unit／integration test gate
5. Backend Capability probe gate
6. Real Codex／Claude Code接続gate
7. Learning loop gate
8. Gateway session／pairing gate
9. Canvas／Artifact reload gate
10. WYSIWYG revision contract gate
11. Image generate／edit Artifact gate
12. Mind map schema／renderer gate
13. Plugin error boundary gate
14. i18n／public naming回帰gate
15. 台帳分類一致gate

正式なコマンドとfixtureは実装計画側で固定する。Desktop install、Onboarding、Auto UpdateはこのCore gateに含めない。

## 7. 実装計画へ渡す代表シナリオ

1. 既存Core回帰gateが通った状態から開始する。
2. CodexまたはClaude Codeを選び、実行前に利用可能Capabilityを確認する。
3. Web検索を依頼し、Backend側の検索eventとsourceをSamuraiのrun履歴へ残す。
4. Browser操作が必要な依頼では、利用可能なBackend／MCP adapterを使う。利用できない場合はHTML取得fallbackと明示する。
5. ChatへPDFを添付し、内容の要約とChart作成を依頼する。
6. 文書をSurfaceとChatの両方から直し、同じArtifact revisionへ残す。
7. Imageを生成・編集し、入力、provider、source runを含む新revisionへ残す。
8. 内容をMind mapへ変換し、node／edgeを編集して再読込する。
9. Wiki、Skill、Automationを主Chatの文脈として開き、同じDomain Commandで変更する。
10. Skill改善、Curator、Gateway、Plugin、Diagnosticsの既存Core回帰が壊れていないことを確認する。

このシナリオは実装候補を縦につなぐための入力であり、正式な完了条件は実装計画側で定義する。

## 8. 台帳の完了条件

- [ ] 90項目すべてが表に存在する
- [ ] 3点満点の項目が存在しない
- [ ] 39件のCore追加候補、4件の接続契約、5件の製品後続、42件の対象外へ分類されている
- [ ] Backend委譲項目にCapability検出、接続、失敗説明の引き渡し条件がある
- [ ] 製品UI・配布準備がCore追加計画の完了条件から外れている
- [ ] Coreと製品UIの境界がWYSIWYG、Image、Mind mapごとに説明されている
- [ ] [`core-additional-scope-implementation-plan.md`](./core-additional-scope-implementation-plan.md)へ実装順、正式gate、変更候補が引き渡されている
- [ ] 参照OSSの実装を確認しつつ、公開面ではSamuraiとして一貫している
