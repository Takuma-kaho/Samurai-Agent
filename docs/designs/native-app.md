# Native App 製品設計

- 状態: 合意済みの現在設計。現在の未コミット実装は必須Organization前提のため、後続の実装修正が必要
- 対象: React移行、Electron、Workspace / Roomナビゲーション、任意Organization管理、Chat、証拠確認、再接続
- 正本: [PRODUCT.md](../../PRODUCT.md)、[ARCHITECTURE.md](../../ARCHITECTURE.md)
- 関連設計: [Organization 製品設計](organization.md)
- 実装計画: [Workspace-first・Organization再設計マスタープラン](../../plans/workspace-first-organization-realignment-master-plan.md)

## 1. 目的

Native Appは、Samuraiの完成体験を実際に操作・確認するためのChat-first clientである。利用者はWorkspaceとRoomを選び、外部Agentへ依頼し、実行証拠と再利用されたKnowledgeを確認・修正する。

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

## 2. 現在との差分

現在の未コミット実装は、Organizationを先に選び、その配下のWorkspaceとRoomを開く構造である。この設計では、次をWorkspace-firstへ変更する。

- Account作成時のOrganization自動生成を前提にしない。
- zero Organizationを利用不能な空状態として扱わない。
- Server selectorやOrganization switcherを必須の最上位ナビゲーションにしない。
- 登録済みの全Serverを横断するWorkspace switcherを主導線にする。
- Workspace APIと画面をOrganization配下に固定しない。
- Organizationを使う場合だけ、グループ表示と管理画面を有効にする。

この文書は目標設計であり、React UIやOrganization APIがこの設計どおり実装済みであることを意味しない。

## 3. 体験の原則

- Workspace-first: WorkspaceはOrganizationなしで作成、招待、Room、Chat、証拠確認、export / restoreまで完結する。
- Chat-first: 見た目の独自性より、迷わず依頼・確認・修正できることを優先する。
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
  R --> CH[Chat surface]
  CH --> E[Evidence inspector]
  S[Server<br/>配置先] -.-> T
  O[Optional Organization management<br/>same Server only] -.-> W
~~~

| 画面・部品 | 利用者がすること | 表示しないもの |
| --- | --- | --- |
| Workspace switcher | 登録済みの全ServerにあるWorkspaceを横断して選択する | Serverを先に選ぶ二段階導線、非許可Workspaceのcontent |
| Workspace navigator | 選択したWorkspaceを開く・作成する | workspace ID単独の接続先、非許可Workspaceのcontent |
| Server connection settings | HostedまたはSelf-hostの接続を追加・復旧する | Server内部の資格情報 |
| Room navigator | 許可済みRoomを選択する | Session、内部run |
| Chat surface | Message送信、stream確認、stop、retry、添付 | Agent runtimeの内部管理UI |
| Evidence inspector | Activity、実行証拠、実ファイル、再利用Knowledgeを確認する | 許可外Workspaceの情報 |
| Organization management | Organization、Member、招待、Workspace追加・解除を管理する | contentの自動閲覧、課金、Compute、SSO |

### 4.1 Sidebar

1. Workspace switcherを基本表示にし、登録済みの全Serverにある認可済みWorkspaceを一つの一覧から開けるようにする。
2. 選択したWorkspaceのServer名は補助的なconnection contextとして表示できるが、Serverを主導線の切替単位にしない。
3. Workspace選択時は対応するServer接続を裏で解決し、Membershipを再認可してからWorkspaceを表示する。
4. Organizationに所属しないWorkspaceも同じ一覧から開ける。Organizationを利用している場合だけ、所属WorkspaceをOrganization名でグループ化して表示できる。
5. 選択したWorkspaceの下に、許可済みRoomだけを表示する。Organization MemberでもWorkspace Membershipがなければ、Room、Message、Activity、Knowledgeを表示しない。
6. archive Workspaceにはread-only表示を出す。
7. SessionはSidebar、deep link、URL、管理画面に出さない。

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

Chat surfaceはRoomの既定Agentと会話する場所である。Agent実行の基盤を確認することを優先し、複雑な複数Agent編成UIは作らない。

- Messageを送信し、streamを表示する。
- 送信中はstopを実行できる。
- 通信・Agent failureは、原因、送信済みか、retryできるかを区別して表示する。
- reconnect / replay後に同じMessageを重複表示・重複送信しない。
- 添付と既存Artifactは必要時に開く / ダウンロードできればよい。

### 4.5 Evidence inspector

各Agent実行の近くから、必要なときだけ開く。最低限表示するものは次である。

- ActivityとPublic Eventの識別子・時刻・状態
- 実行で作成・参照した実ファイル
- 人間が確認・修正するKnowledgeの識別子と状態
- 次の実行で再利用されたKnowledgeの識別子と選択根拠

モデル出力の文章だけで、学習された、再利用されたとは扱わない。Serverが返したActivity / Knowledge referenceとPostgreSQLの記録をE2Eで照合できる形にする。

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
| Organization解除・削除 | Workspace一覧を再取得し、独立Workspaceを選び直せるようにする |
| Server / App restart | local candidateを使うが、Server再認可後にだけ画面を復元する |

## 9. 実機確認

macOS Electron Native App、実PostgreSQL、実Agent、実Workspace file storageを使う。HostedとSelf-hostの両方で、少なくとも二つのAccountにより次を確認する。

1. OrganizationなしでWorkspaceを作成し、Workspace直接招待、Room選択、Chat、Activity、実ファイル、Knowledge確認を行う。
2. 人間がKnowledgeを確認・修正し、次の実行で再利用されたreferenceを確認する。
3. Server、PostgreSQL、Native Appを再起動し、認可とデータが残ることを確認する。
4. Organizationを作成し、二つのWorkspaceを追加・作成する。
5. Organization AdminがWorkspace Membershipを管理できる一方、contentを読めないことを確認する。
6. WorkspaceをOrganizationから解除し、Room、履歴、ファイル、Agent設定を保ったまま独立して利用できることを確認する。
7. Organizationを削除し、所属していた全Workspaceが独立して残ることを確認する。
8. 複数ServerのWorkspaceを一つのWorkspace switcherから選択し、対象Serverの自動接続・再認可、Workspace targetの衝突回避、Server単位のoffline分離を確認する。
9. Workspaceを別Serverへ移転した後、移転先を再認可して開き、移転元がarchiveとして残ることを確認する。

実際に実行した環境、手順、画面、DB、ファイル、未検証範囲はreports配下へ記録する。画面mock、HTTP mock、単体testだけでは実機確認の代わりにならない。

## 10. 将来の完成形と対象外

今後扱うのは、実使用に基づくUI磨き込み、ACP実Agent、複数Agent、Artifact / Surface UI、学習・評価の高度化、MCP / 外部Client、Computeと配布である。

現段階では、決済、課金、SSO、SCIM、SMTP、詳細な利用量、複雑な企業監査、専用Compute、Compute共有、複数Server横断Organization、署名・Installer・自動更新を実装しない。

これらを後から追加しても、OrganizationなしでWorkspaceが成立すること、Organization Membershipがcontent accessを広げないこと、Serverが製品上の必須階層ではないことを維持する。
