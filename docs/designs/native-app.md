# Native App 製品設計

- 状態: 合意済みの目標設計。現在の未コミット実装は必須Organization前提のため、後続の実装修正が必要
- 対象: React移行、Electron、Workspace / Roomナビゲーション、任意Organization管理、Chat、証拠確認、再接続
- 正本: [PRODUCT.md](../../PRODUCT.md)、[ARCHITECTURE.md](../../ARCHITECTURE.md)
- 関連設計: [Organization 製品設計](organization.md)
- 実装計画: Workspace-firstへ修正する新しいマスタープランを別途作成する

## 1. 目的

Native Appは、Samuraiの完成体験を実際に操作・確認するためのChat-first clientである。利用者はWorkspaceとRoomを選び、外部Agentへ依頼し、実行証拠と再利用されたKnowledgeを確認・修正する。

Organizationはこの基本体験の前提ではない。複数Workspaceをまとめて管理する必要がある利用者だけが、同一Server内で任意のOrganizationを作成・利用する。

Phase 2の完成体験は次の一本である。

~~~text
Serverへ接続する
  → Workspaceを作成または選ぶ
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
- Organization switcherを必須の最上位ナビゲーションにしない。
- Workspace APIと画面をOrganization配下に固定しない。
- Organizationを使う場合だけ、グループ表示と管理画面を有効にする。

この文書は目標設計であり、React UIやOrganization APIがこの設計どおり実装済みであることを意味しない。

## 3. 体験の原則

- Workspace-first: WorkspaceはOrganizationなしで作成、招待、Room、Chat、証拠確認、export / restoreまで完結する。
- Chat-first: 見た目の独自性より、迷わず依頼・確認・修正できることを優先する。
- Serverは接続先: ServerはWorkspaceを配置する接続先であり、利用者に必須の製品階層として見せない。
- Organizationは任意: Organizationが存在しない場合も通常画面を表示する。Organizationの所属だけでcontentを表示しない。
- Sessionを隠す: Session、run ID、queue、内部recoveryは利用者に管理させない。
- 事実を示す: 学習や再利用は、Serverが返すActivity / Knowledge referenceで確認する。
- 実機優先: 実Agent、実PostgreSQL、実ファイル、再起動を通らなければ完了にしない。

## 4. 情報構造と画面

~~~mermaid
flowchart LR
  C[Server connection] --> W[Workspace navigator]
  W --> R[Room navigator]
  R --> CH[Chat surface]
  CH --> E[Evidence inspector]
  O[Optional Organization management] --> W
~~~

| 画面・部品 | 利用者がすること | 表示しないもの |
| --- | --- | --- |
| Connection selector | HostedまたはSelf-hostのServer接続を選ぶ・追加する | Server内部の資格情報 |
| Workspace navigator | 接続先Server上のWorkspaceを選択・作成する | 非許可Workspaceのcontent |
| Room navigator | 許可済みRoomを選択する | Session、内部run |
| Chat surface | Message送信、stream確認、stop、retry、添付 | Agent runtimeの内部管理UI |
| Evidence inspector | Activity、実行証拠、実ファイル、再利用Knowledgeを確認する | 許可外Workspaceの情報 |
| Organization management | Organization、Member、招待、Workspace追加・解除を管理する | contentの自動閲覧、課金、Compute、SSO |

### 4.1 Sidebar

1. 接続中のServerはconnection contextとして表示する。接続先の切替はできるが、ServerをOrganizationより上位の製品概念として扱わない。
2. Workspace一覧を基本表示にする。Organizationに所属しないWorkspaceも同じ一覧から開ける。
3. Organizationを利用している場合だけ、所属WorkspaceをOrganization名でグループ化して表示できる。
4. 選択したWorkspaceの下に、許可済みRoomだけを表示する。
5. Organization MemberでもWorkspace Membershipがなければ、Room、Message、Activity、Knowledgeを表示しない。
6. archive Workspaceにはread-only表示を出す。
7. SessionはSidebar、deep link、URL、管理画面に出さない。

### 4.2 Workspace作成とOrganization利用

- 新しいWorkspaceは、現在のServer接続先へ独立Workspaceとして作成するのが既定である。
- 利用者は明示的にOrganizationを選び、その中にWorkspaceを作成できる。
- 既存WorkspaceをOrganizationへ追加・解除する操作は、Organization管理画面から行う。
- Organizationを一つも持たない利用者には、Workspace作成画面を表示する。Organization作成を要求しない。

### 4.3 中央Chat

Chat surfaceはRoomの既定Agentと会話する場所である。Phase 2では、Agent実行の基盤を確認することを優先し、複雑な複数Agent編成UIは作らない。

- Messageを送信し、streamを表示する。
- 送信中はstopを実行できる。
- 通信・Agent failureは、原因、送信済みか、retryできるかを区別して表示する。
- reconnect / replay後に同じMessageを重複表示・重複送信しない。
- 添付と既存Artifactは必要時に開く / ダウンロードできればよい。

### 4.4 Evidence inspector

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
  participant S as Workspace Server

  D->>L: 前回のServer / Workspace / Room候補を読む
  D->>S: Accountが開けるWorkspace一覧を要求
  S-->>D: 認可済みWorkspace
  D->>S: 候補Workspace / Roomを再認可
  alt 権限がある
    S-->>D: ナビゲーションとChatを表示
  else 権限がない / 削除済み
    S-->>D: denyまたは空状態
    D->>L: 無効な候補を破棄
    D-->>D: 安全なWorkspace選択画面を表示
  end
~~~

- local preferenceは、Server URLとAccountに紐づく最後に選んだWorkspace / Roomの候補である。認可情報やServer側の正本ではない。
- Desktop credentialはsecure storageを参照する。Workspace / Room選択をcredentialに埋め込まない。
- Network reconnect、Server restart、Workspace Membership revoke、Workspace archive / deleteの後は、必ずServerを再照会する。
- Organizationの追加・解除・削除後も、Workspaceを再照会し、Workspaceが独立して開けることを確認する。

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
- Workspace操作はWorkspace-firstのAPIを使う。Organizationの有無でChat、Room、EvidenceのAPIを分けない。
- Organization APIは任意の管理操作を扱い、Workspaceの通常操作を包む必須経路にしない。
- Event historyとrealtime notificationを組み合わせ、切断後はServerの履歴から状態を復元する。
- 全てのmutationにoperation IDとidempotencyを持たせ、retryが二重実行にならないようにする。

## 8. 状態と失敗表示

| 状態 | UIの振る舞い |
| --- | --- |
| 初回起動 | AccountとServerを確認し、Workspace一覧を読み込む |
| Server未接続 | 接続作成を表示し、Organization作成を要求しない |
| Workspaceなし | 独立Workspace作成を表示する |
| Organizationなし | 通常状態。Workspace利用を妨げない |
| Workspace accessなし | contentを表示せず、安全なWorkspace選択へ戻す |
| archived Workspace | read-only bannerを表示し、Chat composerと書込み操作を無効にする |
| network disconnect | 送信中 / 未送信を区別し、勝手に成功表示しない |
| Agent failure | 実行失敗をMessage成功と混同せず、retry可能性とevidenceを表示する |
| Organization解除・削除 | Workspace一覧を再取得し、独立Workspaceを選び直せるようにする |
| Server / App restart | local candidateを使うが、Server再認可後にだけ画面を復元する |

## 9. Phase 2の実機確認

macOS Electron Native App、実PostgreSQL、実Agent、実Workspace file storageを使う。HostedとSelf-hostの両方で、少なくとも二つのAccountにより次を確認する。

1. OrganizationなしでWorkspaceを作成し、Workspace直接招待、Room選択、Chat、Activity、実ファイル、Knowledge確認を行う。
2. 人間がKnowledgeを確認・修正し、次の実行で再利用されたreferenceを確認する。
3. Server、PostgreSQL、Native Appを再起動し、認可とデータが残ることを確認する。
4. Organizationを作成し、二つのWorkspaceを追加・作成する。
5. Organization AdminがWorkspace Membershipを管理できる一方、contentを読めないことを確認する。
6. WorkspaceをOrganizationから解除し、Room、履歴、ファイル、Agent設定を保ったまま独立して利用できることを確認する。
7. Organizationを削除し、所属していた全Workspaceが独立して残ることを確認する。

実際に実行した環境、手順、画面、DB、ファイル、未検証範囲はreports配下へ記録する。画面mock、HTTP mock、単体testだけでは実機確認の代わりにならない。

## 10. 将来の完成形と対象外

Phase 2後に扱うのは、実使用に基づくUI磨き込み、ACP実Agent、複数Agent、Artifact / Surface UI、学習・評価の高度化、MCP / 外部Client、Computeと配布である。

現段階では、決済、課金、SSO、SCIM、SMTP、詳細な利用量、複雑な企業監査、専用Compute、Compute共有、複数Server横断Organization、署名・Installer・自動更新を実装しない。

これらを後から追加しても、OrganizationなしでWorkspaceが成立すること、Organization Membershipがcontent accessを広げないこと、Serverが製品上の必須階層ではないことを維持する。
