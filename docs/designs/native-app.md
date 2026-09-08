# Native App 製品設計

- 状態: 合意済みの目標設計。2026-09-08にPhase 5の機能評価とPhase 7の接続要件を反映。詳細な画面構成は実装前の設計案。実装・実機確認の到達点はreportsで管理する
- 対象: React、Electron、Workspace / Roomナビゲーション、既定Agentとの仕事、専門Agent、仕事のコメント、Agent DM、任意Organization管理、Knowledge/Skill管理、検索・設定、Room管理、承認/入力待ち、自動化管理、成果物・Surface、証拠確認、再接続
- 正本: [PRODUCT.md](../../PRODUCT.md)、[ARCHITECTURE.md](../../ARCHITECTURE.md)
- 関連設計: [Organization](organization.md)、[RoomとAgentの共同作業](room-agent-work.md)、[Agent Backend](agent-backends.md)、[Artifact・Surface](artifact-surface.md)
- 実装計画: [Phase 3・4・6統合プラン](../../plans/room-agent-collaboration-plan-phase3-4-6.md)、[Phase 5残作業・7プラン](../../plans/native-artifact-surface-plan-phase5-7.md)、[Workspace-first・Organization再設計マスタープラン](../../plans/workspace-first-organization-realignment-master-plan.md)

## 1. 目的

Native Appは、Samuraiの完成体験を実際に操作・確認するためのChat-first clientである。利用者はWorkspaceとRoomを選び、既定Agentへ依頼し、必要に応じて専門Agentや他の人と同じ仕事を進める。実行証拠と再利用されたKnowledgeを確認・修正できる。

最初に一人でAgentへ仕事を依頼でき、その仕事へ他の人が参加できる体験を基本とする。中央の会話はAgentへの指示と結果、人間同士の相談は仕事ごとのコメント欄で扱う。

Organizationはこの基本体験の前提ではない。複数Workspaceをまとめて管理する必要がある利用者だけが、同一Server内で任意のOrganizationを作成・利用する。

完成体験は次の一本である。

~~~text
Workspace switcherを開く
  → 登録済みのServerを横断してWorkspaceを作成または選ぶ
  → 選択したWorkspaceに対応するServer接続を裏で解決・再認可する
  → Roomを選ぶ
  → 実Agentに依頼する
  → Activity・実ファイル・実行証拠を確認する
  → 学習を確認・修正する
  → 次の依頼で再利用を確認する
  → 再起動後に同じWorkspaceを開く
~~~

Organizationを使う場合は、この体験を壊さず、Workspaceのグループ表示と管理操作だけを追加する。

## 2. 設計の範囲

この文書は画面構成、利用者の操作、表示状態を定義する。仕事のデータ・制御権限・委譲・停止は[RoomとAgentの共同作業設計](room-agent-work.md)、エンジン接続は[Agent Backend設計](agent-backends.md)、成果物の版・保存・操作画面の境界は[Artifact・Surface設計](artifact-surface.md)を参照する。

Workspace-firstと任意Organizationの境界を維持しながら、既定Agentとの仕事、専門Agent、コメント、DMを同じNative Appへ組み込む。現在のコードとの差分・実装順序・検証の到達点は実装計画とreportsで管理する。

Phase 5の目標は、今の製品設計に必要な操作がReact Appで完結することである。旧Vueの全機能一致やSession中心の画面構成は求めない。基本の仕事に加え、知識・手順の管理、Roomと人間の権限管理、検索、必要な設定、実行確認、自動化の基本管理を必要時に開く。Phase 7は、このAppへ成果物の表示・直接編集・操作画面を組み込む。

ReactとElectronを製品のClient構成とする。Vueは製品の予備画面として保持せず、利用可能な共通処理を抽出して整理する。削除の順番・依存一覧・完了証拠は実装計画で管理し、画面の整理を保存データの削除や保存形式統合と結び付けない。

## 3. 体験の原則

- Workspace-first: WorkspaceはOrganizationなしで作成、招待、Room、Chat、証拠確認、export / restoreまで完結する。
- Chat-first: 見た目の独自性より、迷わず依頼・確認・修正できることを優先する。
- 依頼の窓口: Roomには既定Agentを一つ置き、通常の送信をそのAgentへの依頼にする。
- 人間の介入: 仕事全体と個々の担当を確認し、権限に応じて停止・追加指示・担当変更できる。
- 相談と指示: コメントだけではAgentを動かさず、人間の明示操作で仕事へ反映する。
- Serverは配置先: ServerはWorkspaceを配置する接続先であり、利用者向けの主な切替単位にしない。
- Workspace switcher: 登録済みの全Serverにある認可済みWorkspaceを一つの一覧にまとめ、Workspaceを利用者向けの切替単位にする。
- Workspace target: 少なくともServer connectionとworkspace IDの組で識別し、workspace ID単独で接続先を決めない。
- Organizationは任意: Organizationが存在しない場合も通常画面を表示する。Organizationの所属だけでcontentを表示しない。
- Sessionを隠す: Session、run ID、queue、内部recoveryは利用者に管理させない。
- 事実を示す: 学習や再利用は、Serverが返すActivity / Knowledge referenceで確認する。
- 実機優先: 実Agent、実PostgreSQL、実ファイル、再起動を通らなければ完了にしない。

## 4. 情報構造と画面

~~~mermaid
flowchart LR
  SW[Workspace switcher<br/>registered Servers] --> T[Workspace target<br/>connection + workspace]
  T --> A[対象Serverで再認可]
  A --> W[Workspace navigator]
  W --> R[Room navigator]
  R --> CH[既定Agentとの仕事]
  CH --> E[Evidence inspector]
  CH --> C[仕事のコメント]
  CH --> P[専門Agentの担当と制御]
  CH --> AS[成果物と必要な操作画面]
  W --> B[Agent一覧]
  B --> DM[Agent DM]
  S[Server<br/>配置先] -.-> T
  O[Optional Organization management<br/>same Server only] -.-> W
~~~

| 画面・部品 | 利用者がすること | 表示しないもの |
| --- | --- | --- |
| Workspace switcher | 登録済みの全ServerにあるWorkspaceを横断して選択する | Serverを先に選ぶ二段階導線、非許可Workspaceのcontent |
| Workspace navigator | 選択したWorkspaceを開く・作成する | workspace ID単独の接続先、非許可Workspaceのcontent |
| Server connection settings | HostedまたはSelf-hostの接続を追加・復旧する | Server内部の資格情報 |
| Room navigator / 作成 | 許可済みRoomを選択し、既存または新規Agentを既定にしてRoomを作る | Session、内部run |
| Agent一覧・選択 | 専門性、Backend、利用可否を見て作成・編集・選択する | 資格情報の本文 |
| Chat surface | 依頼、仕事への追加指示、stream確認、添付、結果確認 | Session管理、無関係なAgent間連絡 |
| 仕事の担当・制御 | 担当作業、全体停止、個別停止、指示変更、担当変更を確認・操作する | 停止要求を停止完了に見せる表示 |
| 仕事のコメント | 人間同士で相談し、選んだ内容をAgentへ反映する | 投稿による自動実行 |
| Agent DM | 選んだAgentとの個人的な依頼と継続 | 他人のDM、共有Roomへの自動公開 |
| Evidence inspector | Activity、実行証拠、実ファイル、再利用Knowledgeを確認する | 許可外Workspaceの情報 |
| Knowledge / Skill | 内容、保存先、根拠、履歴を確認し、許可された編集・保管・状態変更を行う | 自動で統合された別資源、未許可Roomの内容 |
| Room管理 | 子Room作成、移動、参加・解除・role変更と影響確認 | Account IDだけで与えられる権限、DMの公開化 |
| Room検索 | 現在のRoomの仕事・履歴・成果物・知識を探して開く | Session管理、全Server横断検索、許可外の抜粋 |
| 確認待ち | 仕事の操作内容・対象・期限を確認し、許可された応答を行う | 旧Runへの承認転用、全許可設定 |
| 自動化 / 基本設定 | 既存jobの予定・履歴・停止/再開、言語・学習基本状態・接続設定 | 新規scheduler、学習最適化の詳細editor |
| 成果物・Surfaceパネル | 文書・表・画像・PDF・HTMLの確認、文章・表データの編集、入力保存、Agentへの修正依頼 | Office互換編集、画像・PDFの手動編集、生成画面へのApp権限の受渡し |
| Organization management | Organization、Member、招待、Workspace追加・解除を管理する | contentの自動閲覧、課金、Compute、SSO |

### 4.1 Sidebar

1. Workspace switcherを基本表示にし、登録済みの全Serverにある認可済みWorkspaceを一つの一覧から開けるようにする。
2. 選択したWorkspaceのServer名は補助的なconnection contextとして表示できるが、Serverを主導線の切替単位にしない。
3. Workspace選択時は対応するServer接続を裏で解決し、Membershipを再認可してからWorkspaceを表示する。
4. Organizationに所属しないWorkspaceも同じ一覧から開ける。Organizationを利用している場合だけ、所属WorkspaceをOrganization名でグループ化して表示できる。
5. 選択したWorkspaceの下に、許可済みRoomだけを表示する。Organization MemberでもWorkspace Membershipがなければ、Room、Message、Activity、Knowledgeを表示しない。
6. archive Workspaceにはread-only表示を出す。
7. SessionはSidebar、deep link、URL、管理画面に出さない。
8. Agent一覧と、自分が開けるAgent DMへの導線を設ける。RoomとDMの公開範囲を判別できるようにする。

### 4.2 Workspace作成とOrganization利用

- 新しいWorkspaceは、作成時に選んだServerへ独立Workspaceとして作成する。作成後の主操作はServer名ではなくWorkspace名による切替とする。
- 利用者は明示的にOrganizationを選び、その中にWorkspaceを作成できる。
- 既存WorkspaceをOrganizationへ追加・解除する操作は、Organization管理画面から行う。
- Organizationを一つも持たない利用者には、Workspace作成画面を表示する。Organization作成を要求しない。

### 4.3 Workspace switcherと再認可

- Workspace switcherは、登録済みの各Serverから取得した認可済みWorkspaceを一つに統合して表示する。
- 内部のWorkspace targetは少なくとも`connection_id + workspace_id`で識別する。同じworkspace IDが別Serverに存在しても、別のWorkspaceとして扱う。
- 一覧のlocal情報は表示候補にすぎない。選択時には対象Serverへ接続し、Workspace Membershipと必要なRoom権限を再認可してから表示する。
- Workspace切替では、Server接続、realtime購読、選択状態、最後に開いたRoom候補を一つの切替処理として更新する。再認可に失敗した候補は破棄し、安全なWorkspace選択へ戻す。
- 一つのServerがofflineでも、ほかのServer上のWorkspaceまで利用不能扱いにしない。

### 4.4 中央Chat

Roomのヘッダーに既定Agentを示す。通常の入力から送信すると新しい仕事を作り、Agentの応答と結果を中央に表示する。`@`は専門Agentを明示指名するときに使う。

- 仕事ごとに依頼者、担当、状態を示し、結果の近くに「いいね」「この仕事に返信」「コメント」を置く。
- 「この仕事に返信」を押すと、入力欄に対象の仕事を表示する。返信先を解除すれば新しい仕事を依頼できる。
- 専門Agentの作業は仕事の下で折り畳んで示す。担当名、何をしているか、待っている理由、結果を確認できる。
- 仕事全体の停止と、特定の担当作業の停止を区別する。操作後はServerが返した停止確認の状態を表示する。
- 指示変更は受付と反映を分けて表示し、反映待ち・失敗の担当を確認できる。
- 依頼者とRoom Owner / Adminに制御操作を出す。他のメンバーはコメントで提案し、自分の新しい仕事を依頼できる。
- 通信・Agent failureは、原因、送信済みか、retryできるかを区別して表示する。reconnect / replayで同じ依頼や結果を重複させない。
- 添付は依頼・追加指示・コメントの入力位置から追加できる。アップロード中・失敗・Agentが参照できない形式を区別する。

主画面に汎用のフローチャート編集やAgent同士の全会話を要求しない。必要な委譲と介入を、仕事の担当一覧と操作で行えるようにする。

### 4.5 Evidence inspector

各Agent実行の近くから、必要なときだけ開く。最低限表示するものは次である。

- ActivityとPublic Eventの識別子・時刻・状態
- 実行で作成・参照した実ファイル
- 人間が確認・修正するKnowledgeの識別子と状態
- 次の実行で再利用されたKnowledgeの識別子と選択根拠

モデル出力の文章だけで、学習された、再利用されたとは扱わない。Serverが返したActivity / Knowledge referenceとPostgreSQLの記録をE2Eで照合できる形にする。

### 4.6 人間のコメント

仕事の「コメント」から専用欄を開く。コメント入力は中央の依頼入力と分け、「投稿してもAgentには指示されない」と判別できる表示にする。狭い画面では同じ機能をdrawerまたは専用表示へ移す。

コメントを選択して「Agentに反映」を押すと、反映先の仕事、選択した本文・添付を表示する。制御権限のある人が送信すると、その内容を追加指示として保存する。元コメントに反映済みの参照を付けるが、その後の編集は自動で再反映しない。

コメント、専門Agentの詳細、Evidenceは必要時に開く。同時に全てを常設して、中央の依頼と結果を狭くしない。

### 4.7 Agent一覧・Room作成・Agent DM

- Agent一覧では、名前、専門性、使用するBackend、利用可否を表示し、作成・編集・「会話する」へ進める。Roomで指名する選択肢は、そのRoomで実行できるAgentに絞る。
- BackendはSamurai Native / Codex / Claude Codeから選べる。NativeではGemini・OpenAI・AnthropicなどのproviderとAPIキー設定、Codex / Claude Codeでは本人の公式ログインによるサブスク利用を基本にAPIキー利用も選べる導線を設ける。資格情報の本文をAgentプロフィールや会話へ保存しない。
- Room作成では名前と既定Agentを選ぶ。「新しく作る」ではAgent設定を同じ流れで入力し、Room作成と合わせて確定する。
- Room設定から専門Agentを追加・解除し、閲覧・編集・実行の権限を管理する。既定Agentの変更もここで行い、管理権限のない人には選択結果と利用可否を表示する。
- 既定Agentがない既存Roomでは履歴を開き、実行前に設定する導線を出す。Agent一覧の先頭を暗黙に既定にしない。
- Agent DMは同じ仕事の操作を使い、本人とAgentの非公開の会話として表示する。「Roomへ共有」は選んだ結果と資料だけを共有する操作にする。
- Roomのメンバー追加は既存の認可と招待を通す。仕事へのリンクだけでアクセスを与えない。

### 4.8 成果物と必要な操作画面

Phase 5残作業・7では、仕事の結果から成果物カードを開き、Chat横のパネルに内容を表示する。狭い画面では同じ内容を広い専用表示へ切り替える。Roomの成果物一覧と元の仕事から、保存済みの結果を再び開けるようにする。

- 文書・表・画像・PDF・HTMLを表示し、実ファイルをダウンロードできる。
- 文章・表データは人が直接編集・保存でき、履歴確認と以前の版からの復元ができる。
- 「Agentに修正を依頼」で対象の成果物・版・必要な選択箇所を既存の仕事の入力へ渡す。既存仕事の制御権限がない場合は、許可された別の依頼として扱う。
- 画像・PDFの手動編集、Word・Excel互換編集は今回含めない。
- Surfaceは必要なときに開き、表示・絞り込み・フォーム入力・データ保存を扱う。保存先はWorkspace Coreで管理する。
- 保存中・未保存・競合・失敗を区別し、編集中の内容や表示をAgentの更新で奪わない。

成果物の履歴、入力先データ、iframeの隔離、権限と再送の詳細は[Artifact・Surface設計](artifact-surface.md)に従う。

### 4.9 将来の実行画面

仕事または担当作業から、実行先の画面を開ける配置上の余地を残す。Computer Useのライブ表示、操作引継ぎ、VMの作成は今回の画面へダミー機能として入れない。対応する実行先が実装された時点で、その能力に応じて表示する。

### 4.10 Knowledge・Skillの確認と基本管理

- Roomの補助メニューと仕事の根拠から開き、同じChatへ戻れる。Room知識とWorkspace共通知識は保存先が分かるように示す。
- 一覧、本文、資源種別、根拠、変更履歴を確認する。Knowledgeの作成・編集・保管/復元・AI更新固定、Skillの本文編集・有効状態変更を既存の権限と資源の版で行う。
- 旧Memory、Knowledge Wiki、Completion resourceを一つの保存形式へ変換しない。種別とIDを維持し、旧Memoryは閲覧・保管を基本にする。対応する編集操作のない資源は読取表示と理由を示す。
- 読み取った版で保存し、競合時は先行変更と利用者の下書きを保持する。AI更新固定と人の編集権限を混同しない。
- 「仕事で使う」は認可された資源refを入力へ添える。別Roomへの複製・昇格・共有は暗黙に行わない。
- 学習の生成・評価・Skill最適化を管理画面の追加と同時に再設計しない。詳細な学習体験はPhase 8で扱う。

### 4.11 Room構造と人間メンバー

子Room作成、Room移動、人間メンバーの参加・解除・role変更はRoom設定から行う。Agentの閲覧・編集・実行権限とは別の操作として示す。

移動先やメンバー変更の影響を確認してから実行し、確定時にもServerで現在の権限と版を検査する。親Roomへの参加条件、最後のOwner保護、非許可Roomの名前の非表示を守る。移動や権限変更後はナビゲーションと開いている内容を再認可する。Agent DMは本人とAgentの非公開の範囲を維持し、人間メンバー追加で通常Roomへ変えない。

### 4.12 検索と基本設定

検索は現在のRoomを範囲として、仕事・履歴・成果物・知識へ到達する補助機能とする。検索結果の本文・抜粋にも認可を適用する。内部Session参照はServer側で現在のRoom/仕事へ解決し、利用者へSessionの選択を要求しない。対応する仕事がない旧履歴は、認可されたRoom内の読取表示へ案内する。

設定は表示/出力言語、接続・Agentの設定と認証状態、学習の有効状態とWorkspace標準/Room上書きを扱う。保存先のscopeを明示し、別Account・Serverへ設定を混ぜない。学習Engine/model/予算の詳細編集はPhase 8で扱い、旧設定群の一括再現はしない。接続不能・認証切れは既存の復旧/公式認証導線へ案内し、利用者向け画面へ資格情報の本文を再表示しない。

### 4.13 仕事の確認待ちと証拠

仕事や担当の近くに確認待ちを示し、必要時に操作の対象・影響・期限・許可された応答を開く。Activity、実行状態、参照したKnowledge、変更した資源は同じ仕事から確認できる。

Coreの承認要求とBackendの入力要求を区別し、要求ID・Run・担当・対象版に対応する応答だけを送る。受付と実行完了を別に表示し、再接続後はServerから未解決要求を読み直す。取消・停止・期限切れ・処理済み・権限失効後の応答を新しい実行へ転用しない。Surfaceもこの確認UIを共有し、iframeのメッセージや`confirmed`値だけで承認を完了させない。

復元はArtifactのrevision等、対象資源に定義されたDomain操作を通す。利用できる保存先も復旧契約もない汎用の「元に戻す」ボタンは置かない。構造化した承認/入力の橋渡しができないBackendは利用不能を示し、全許可や自動応答で代替しない。

### 4.14 自動化と補助画面の共通動作

Roomの既存自動化の予定、有効状態、最近の実行結果を必要時に開き、管理権限に従って停止/再開できる。予約を止める操作と実行中の仕事を止める操作は区別し、実行中の停止は仕事の制御へつなぐ。新しいschedulerや汎用job editorはこの画面の前提にしない。

補助画面を閉じると元のRoom/仕事へ戻る。未保存入力を保護し、Agentの更新で編集中の画面を奪わない。長い一覧、keyboard、IME、狭い画面でも主要操作に到達でき、失敗・読取専用・再試行の理由を示す。設定・確認・成果物を一つの巨大な画面や状態管理に集中させない。

## 5. 起動、選択、再認可

~~~mermaid
sequenceDiagram
  participant D as Native App
  participant L as Local secure preference
  participant C as Server connection registry
  participant S as Selected Workspace Server

  D->>L: 前回のWorkspace target / Room候補を読む
  D->>C: 登録済みServerを横断してWorkspace一覧を要求
  C-->>D: Workspace target（connection + workspace）一覧
  D->>S: 対象Serverへ接続しWorkspace Membership / Room権限を再認可
  alt 権限がある
    S-->>D: ナビゲーションとChatを表示
  else 権限がない / 削除済み
    S-->>D: denyまたは空状態
    D->>L: 無効な候補を破棄
    D-->>D: 安全なWorkspace選択画面を表示
  end
~~~

- local preferenceは、Accountに紐づく最後に選んだWorkspace target（connection + workspace）とRoomの候補である。認可情報やServer側の正本ではない。
- Desktop credentialはsecure storageを参照する。Workspace / Room選択をcredentialに埋め込まない。
- Network reconnect、Server restart、Workspace Membership revoke、Workspace archive / deleteの後は、対象Serverを再照会し、Workspace switcherも更新する。
- Organizationの追加・解除・削除後も、Workspaceを再照会し、Workspaceが独立して開けることを確認する。
- Server間移転後は、移転先Workspaceを再認可してswitcherへ反映する。移転元は切替完了後にarchiveとして扱い、別の明示削除まで自動で消さない。

## 6. Organization管理

Organization管理は、Organizationを明示的に作成または利用している場合だけ開ける専用画面とdialogで行う。通常のWorkspace利用画面やSidebarへ細かな管理操作を詰め込まない。

| 操作 | UIの要件 |
| --- | --- |
| Organization作成・編集 | nameは必須、icon / descriptionは任意。自動生成しない。 |
| Member管理 | Owner / Adminの可否に応じて一覧、role、removeを表示する。 |
| Organization招待 | Organization roleを選べる。Workspace grantなしではcontentを与えない。 |
| Workspace追加 | 対象Workspace、既存Memberの最小Organization Member追加、影響を確認して実行する。 |
| Workspace解除 | データが残ること、独立Workspaceになることを明示する。 |
| OrganizationからWorkspace作成 | 通常のWorkspaceとして作られ、後から解除できることを示す。 |
| Organization削除 | 所属Workspaceを独立状態へ戻す一覧と影響を確認する。 |

Organization Owner / AdminがWorkspace contentを開ける導線は出さない。Workspace Membershipの変更操作は、対象Workspaceと変更内容を明示する。

Organizationの管理画面は同一Server内の関連付けを扱う。全Server横断のWorkspace switcher、Workspace targetの再認可、別ServerへのWorkspace移転はNative AppとWorkspaceの接続・移植機能であり、Organizationを横断管理する機能ではない。

## 7. ClientとServerの境界

~~~mermaid
flowchart LR
  R[React UI] --> BR[Browser bridge / Electron preload]
  BR --> API[Workspace Server HTTP / Domain API]
  API --> OP[Query / Domain Operation]
  OP --> DB[(PostgreSQL RLS)]
  OP --> RT[Agent runtime]
  RT --> EV[Activity / Event / Knowledge]
~~~

- React UIは表示、入力、local preferenceだけを担当する。
- Browser bridge / Electron preloadはcredentialと環境差を安全に吸収し、DBまたはunrestricted server secretをrendererに渡さない。
- Workspace操作はWorkspace-firstのAPIを使う。Organizationの有無でChat、Room、EvidenceのAPIを分けない。Workspace targetはServer connectionを伴って解決し、workspace ID単独で参照しない。
- Organization APIは任意の管理操作を扱い、Workspaceの通常操作を包む必須経路にしない。
- Event historyとrealtime notificationを組み合わせ、切断後はServerの履歴から状態を復元する。
- 全てのmutationにoperation IDとidempotencyを持たせ、retryが二重実行にならないようにする。
- Roomと仕事の参照で通常操作を完結させる。Sessionの選択・新規作成・外部Session IDの受渡しをReactの送信前提にしない。
- 通常の公開catalogと生成ClientもRoom / 仕事の契約を使う。旧Session入力の互換入口は非推奨として分け、通常UIや新規Clientの契約へ含めない。互換入口も同じ認可・仕事の制御を通す。
- コメント、指示、制御は別の型・操作として扱い、本文中の`@`や画面表示だけで実行可否を決めない。
- Knowledge/Skill、検索、Room管理、設定、自動化も共通公開Query/Domain Operationへ接続する。不足する公開契約は既存サービスへ接続し、旧Vue用APIを新UIの恒久経路にしない。
- 旧Clientの削除はCoreや外部Clientが利用するAPIの削除を意味しない。現在の利用元・公開契約を確認した単位で共有処理を保持する。

## 8. 状態と失敗表示

| 状態 | UIの振る舞い |
| --- | --- |
| 初回起動 | Accountと登録済みServerを確認し、全Server横断のWorkspace一覧を読み込む |
| Server未接続 | 接続作成を表示し、Organization作成を要求しない |
| Workspaceなし | 独立Workspace作成を表示する |
| Organizationなし | 通常状態。Workspace利用を妨げない |
| Workspace accessなし | contentを表示せず、安全なWorkspace選択へ戻す |
| archived Workspace | read-only bannerを表示し、Chat composerと書込み操作を無効にする |
| 一部Server offline | そのServerのWorkspaceだけ状態を示し、ほかのServerのWorkspaceは利用可能にする |
| network disconnect | 送信中 / 未送信を区別し、勝手に成功表示しない |
| Agent failure | 実行失敗をMessage成功と混同せず、retry可能性とevidenceを表示する |
| 既定Agentなし・実行不能 | 履歴を残し、既定Agentの設定または接続復旧へ案内する |
| 停止要求中 | 対象の仕事と担当を示し、確認を待つ |
| 停止未確認 | 未確認の担当と理由を表示し、仕事全体を停止済みにしない |
| 指示の反映待ち | 受け付けた指示と未反映の担当を示す |
| 別の人が指示を変更した | 最新の版を取得し、入力を保存したまま再確認できるようにする |
| 書込み競合 | 待機理由と先行する作業を示し、同じ成果物を上書きしない |
| DMから共有 | 共有先と対象の結果・資料を示し、元DM全体を公開しない |
| Organization解除・削除 | Workspace一覧を再取得し、独立Workspaceを選び直せるようにする |
| Server / App restart | local candidateを使うが、Server再認可後にだけ画面を復元する |
| 管理画面の保存競合 | 現在版と下書きを保持し、再読込・再確認へ案内する |
| Room移動・権限変更 | 古い影響確認を無条件に使わず、確定時の再検査と表示更新を行う |
| 承認・入力の期限切れ/停止 | 応答を無効にし、新しい要求へ転用しない |
| 検索中のRoom切替 | 遅延した結果・抜粋を新しいRoomへ表示しない |
| 自動化の停止 | 予約停止の結果を表示し、実行中の仕事の状態を別に示す |

## 9. 実機確認

macOS Electron Native App、実PostgreSQL、実Agent、実Workspace file storageを使う。HostedとSelf-hostの両方で、少なくとも二つのAccountにより次を確認する。

Phase 3・4・6では、実装担当はSamurai Nativeと利用者が以前共有したGemini APIキーの無料枠で実機検証する。Codex / Claude Codeは利用者が実機検証し、実装担当は実CLIを起動しない。製品のprovider選択をGeminiへ限定せず、確認結果はBackend・provider・認証方式ごとに区別する。

1. OrganizationなしでWorkspaceを作成し、Workspace直接招待、Room選択、Chat、Activity、実ファイル、Knowledge確認を行う。
2. 人間がKnowledgeを確認・修正し、次の実行で再利用されたreferenceを確認する。
3. Server、PostgreSQL、Native Appを再起動し、認可とデータが残ることを確認する。
4. Organizationを作成し、二つのWorkspaceを追加・作成する。
5. Organization AdminがWorkspace Membershipを管理できる一方、contentを読めないことを確認する。
6. WorkspaceをOrganizationから解除し、Room、履歴、ファイル、Agent設定を保ったまま独立して利用できることを確認する。
7. Organizationを削除し、所属していた全Workspaceが独立して残ることを確認する。
8. 複数ServerのWorkspaceを一つのWorkspace switcherから選択し、対象Serverの自動接続・再認可、Workspace targetの衝突回避、Server単位のoffline分離を確認する。
9. Workspaceを別Serverへ移転した後、移転先を再認可して開き、移転元がarchiveとして残ることを確認する。
10. 既存 / 新規Agentを選んだRoom作成、通常の依頼、仕事への返信、専門Agentの明示指名と自動委譲を行う。
11. 別Accountが仕事へコメントしてもAgentが動かず、権限のある人の「Agentに反映」でだけ指示が変わることを確認する。
12. 仕事全体・個別担当の停止、指示変更、担当変更を実Agentで行い、残った子作業・未確認の停止・書込み競合を正しく表示する。
13. 同じAgentを別Room・別AccountのDMで使い、履歴が混ざらず、選択した結果だけを共有できることを確認する。
14. Knowledge/Skillの基本管理、Room移動・人間の権限管理、検索、設定、自動化の停止/再開、確認待ちへの応答をReactから実Serverへ通す。旧データの参照・版競合・期限切れ・再接続も照合する。
15. Vueを整理した最終bundleで通常利用・再起動・補助画面への到達を確認し、利用者による操作確認の結果を技術検証と分けて記録する。

実際に実行した環境、手順、画面、DB、ファイル、未検証範囲はreports配下へ記録する。画面mock、HTTP mock、単体testだけでは実機確認の代わりにならない。

これは製品全体の検証条件である。各変更で実行する確認は実装計画の影響範囲に従い、既存の重い確認を変更のたびに全て繰り返さない。

## 10. 将来の完成形と対象外

実Agent接続と複数Agentの共同作業はPhase 3・4・6の現在の対象である。接続方式はAgent Backend設計に従う。

Phase 5は基本の仕事と管理・確認・設定のReact完結と旧Vue整理、Phase 7はArtifact / Surfaceの表示・編集・入力保存を対象とする。後続で扱うのは、学習・評価の高度化、外部Client向け接続の拡充、Computer Use、Computeと配布である。実使用に基づくUI調整は継続する。

現段階では、決済、課金、SSO、SCIM、SMTP、詳細な利用量、複雑な企業監査、専用Compute、Compute共有、複数Server横断Organization、署名・Installer・自動更新を実装しない。

これらを後から追加しても、OrganizationなしでWorkspaceが成立すること、Organization Membershipがcontent accessを広げないこと、Serverが製品上の必須階層ではないことを維持する。
