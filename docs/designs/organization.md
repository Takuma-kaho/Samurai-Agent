# Organization 製品設計

- 状態: 合意済みの現在設計。現在の未コミット実装は必須Organization前提のため、後続の実装修正が必要
- 対象: 任意のOrganization、Membership、招待、Workspace追加・解除、権限、移行、export / restore
- 正本: [PRODUCT.md](../../PRODUCT.md)、[ARCHITECTURE.md](../../ARCHITECTURE.md)
- 関連設計: [Native App 製品設計](native-app.md)
- 実装計画: [Workspace-first・Organization再設計マスタープラン](../../plans/workspace-first-organization-realignment-master-plan.md)

## 1. 目的

Organizationは、複数Workspaceをまとめて管理したい場合だけ利用する追加機能である。個人利用と小規模チームは、Organizationを作らずにWorkspaceとRoomだけで完結する。

Organizationの目的は、同一Server上にある複数Workspaceについて、管理者が明示的にmetadata/list、Membership、招待、所属、共通の管理操作を扱うことである。Workspaceのデータ、Room、Activity、Knowledge、実ファイル、Agent実行を所有する単位ではない。

この設計は、次を同時に満たす。

- WorkspaceはOrganizationなしで、メンバー、招待、Room、データ、Agent実行、export / restoreまで完結する。
- Organizationを追加・解除しても、Workspace ID、Room、履歴、ファイル、Workspace Membershipは変わらない。
- Organization Owner / Adminは複数Workspaceを管理できるが、Workspace / Room contentを自動では読めない。
- HostedとSelf-hostで同じWorkspace-firstの仕組みを使う。
- 現段階のOrganizationは同一Server内に限定する。Native Appの全Server横断Workspace switcherやServer間Workspace移転とは別の機能である。

決済、課金、専用Compute、Compute共有はこの設計と実装範囲に含めない。

## 2. 基本原則

1. Workspaceは製品上の基本単位であり、Organizationは必須の親階層ではない。
2. ServerはWorkspaceを配置・運用する場所であり、製品上の必須階層ではない。
3. Workspaceは一つのホームServerに配置する。別Serverへの移転はexport / restoreで行う。
4. WorkspaceはOrganizationに所属しなくてもよく、所属する場合もactiveなOrganizationは最大一つとする。
5. Workspace MembershipがWorkspace contentへの基本権限であり、Room Membershipはさらに制限する。
6. Organization MembershipはOrganization自身の管理・所属を記録するものであり、Workspace一覧・metadata・contentのread / write権限ではない。
7. Organizationの追加・解除・削除は、Workspaceのデータや実行履歴を移動・複製・削除しない。
8. Workspaceへの直接招待は、Organizationの有無にかかわらず常に利用できる。

## 3. 用語と関係

| 用語 | 意味 |
| --- | --- |
| Account | 人または認証された利用主体。複数Workspaceと複数Organizationに参加できる。 |
| Server | Workspace Core、PostgreSQL、ファイルサービスを配置する接続先。 |
| Workspace | メンバー、Room、Agent、Activity、Knowledge、実ファイルを所有する独立した基本単位。 |
| Workspace Membership | AccountがWorkspace contentを扱うための参加記録とrole。 |
| Room | Workspace内の会話・作業の単位。必要な場合だけRoom Membershipでさらに制限する。 |
| Organization | 同一Server上の複数Workspaceを任意でまとめて管理する追加単位。 |
| Organization Membership | AccountがOrganizationに所属し、その管理権限を持つことを記録する参加記録とrole。Workspace一覧・metadata・contentの権限は含まない。 |
| Workspace Association | Workspaceが任意のOrganizationへ追加されている関係。 |
| Invitation | WorkspaceまたはOrganizationへの参加を許可する直接招待またはone-time token。 |

~~~mermaid
flowchart TD
  A[Account] --> WM[Workspace Membership]
  WM --> W[Workspace]
  W --> R[Room]
  R --> S[Session: 内部実行単位]
  S --> AC[Activity / 実行証拠]
  W --> K[Knowledge / Skill / 実ファイル]
  A --> OM[Organization Membership]
  OM --> O[Organization: 任意]
  O -.管理上の所属.- W
  SV[Server: 配置・運用] -.接続先.- W
  NS[Native App: 全Server横断Workspace switcher] -.選択・再認可.- W
~~~

SessionはRoomの継続実行・復旧を支える内部単位であり、Organizationの権限対象にもNative Appのナビゲーション対象にもならない。

## 4. 製品ルール

### 4.1 Workspace

- AccountはOrganizationを作らずに、Server上へ独立したWorkspaceを作成できる。
- Workspaceは、メンバー、直接招待、Room、Agent、Activity、Knowledge、実ファイル、archive / restore、export / restoreを自身の責務として持つ。
- Workspaceには一つのホームServerがある。Agent実行先は外部AgentやBackendであり、WorkspaceのホームServerと同一である必要はない。
- Workspaceの作成、削除、archive、restore、exportはOrganizationへの所属を前提にしない。
- Workspaceを別Serverへ移転する場合は、Workspace単位でexport / restoreし、移転先の整合性を確認してから切り替える。これはOrganizationの追加・解除ではない。

### 4.2 Organization

- OrganizationはAccountが明示的に作成した場合だけ存在する。Account作成時の自動生成は行わない。
- Organizationは同一Server上の複数Workspaceを管理する。Organizationだけを作成し、後からWorkspaceを追加してもよい。
- Organizationから新しいWorkspaceを作成できる。このWorkspaceは通常のWorkspaceであり、後からOrganizationから解除できる。
- OrganizationはWorkspaceのcontentやKnowledgeを所有しない。Organizationを削除してもWorkspaceは独立して残る。

### 4.3 Workspaceの追加・解除

既存Workspaceの追加は、次の条件で行う。

1. WorkspaceとOrganizationは同じServer上にある。
2. Workspaceは別のactive Organizationに所属していない。
3. Workspace OwnerとOrganization Owner / Adminが追加を承認する。
4. 追加時、既存Workspace MemberのうちOrganizationに未参加のAccountは、最小のOrganization Memberとして自動追加する。
5. Workspace / Room role、content access、Roomの可視性は変更しない。

Organizationに所属するWorkspaceへ直接招待したAccountは、必要であれば最小のOrganization Memberも同時に作成する。ただしOrganization Membershipは、Workspace contentの追加権限を与えない。

Workspaceの解除は、Workspace OwnerまたはOrganization Owner / Adminが実行できる。解除後もWorkspaceは同じID、Member、Room、Activity、Knowledge、ファイルを保持し、独立Workspaceとして使い続けられる。

Organizationを削除する場合は、所属Workspaceを一つずつ移動・削除させるのではなく、全てを独立Workspaceへ解除してからOrganization自体を削除する。削除前に影響するWorkspace一覧を表示し、同一transactionで所属解除とOrganization削除を確定する。

Organization Memberを削除しても、Workspace Membershipは自動では削除しない。Workspace contentへのアクセスも止めたい場合は、対象WorkspaceのMembershipを別途削除する。

### 4.4 権限

| Organization role | 許可する操作 | 許可しない操作 |
| --- | --- | --- |
| Owner | Organization削除、Owner管理、Member管理、招待、管理対象Workspaceのmetadata/list確認、Workspace作成・追加・解除、Workspace Membership管理 | Workspace / Room contentの自動閲覧・自動書込み |
| Admin | Member管理、招待、管理対象Workspaceのmetadata/list確認、Workspace作成・追加・解除、Workspace Membership管理 | Owner変更、Organization削除、Workspace / Room contentの自動閲覧・自動書込み |
| Member | 自分のOrganization MembershipとOrganization metadataの確認 | Workspace一覧・metadata、Organization管理、Workspace / Room contentの自動閲覧・自動書込み |
| Guest | 明示された最小のOrganization Membershipの確認 | Workspace一覧・metadata、Organization管理、Workspace / Room contentの自動閲覧・自動書込み |

- Workspace MembershipがMessage、Activity、Knowledge、添付、Artifact、Agent実行の可否を決める。
- Room MembershipはWorkspace Membershipより狭いcontent accessを定義できる。
- Organization Owner / AdminがWorkspace Membershipを変更する操作は、対象Workspace、actor、前後のroleをEventとauditに残す。
- Organization roleを追加しても、既存Workspace / Room roleを上書きしたり、content accessを広げたりしない。
- Workspaceの永久削除はWorkspaceの権限規則に従う。Organization roleだけを根拠にcontentを削除してはならない。

## 5. 招待と可視性

### 5.1 招待

| 種類 | 目的 | content access |
| --- | --- | --- |
| Workspace直接招待 | 独立または所属済みWorkspaceへ参加させる | 指定されたWorkspace roleに従う |
| Organization招待 | Organizationの管理・所属へ参加させる | Workspace一覧・metadata・contentのgrantは与えない |

直接招待とtoken招待は、WorkspaceとOrganizationのどちらにも利用できる。raw tokenは表示時だけ利用し、DB、Event payload、通常ログには保存しない。tokenのhash、有効期限、issuer、revoke / accept状態、対象roleは保存し、受諾はidempotentに扱う。

### 5.2 Workspaceの可視性

Organization Membershipだけでは、Workspace一覧・metadata・contentを返さない。Owner / Adminが明示的なWorkspace管理操作を行う場合に限り、管理対象Workspaceのmetadataを確認し、Workspace Membershipを管理できる。この管理権限はRoom名、Message、Activity、Knowledge、添付、Artifactなどのcontent閲覧権へ変換しない。

Workspace visibilityは将来の招待・参加フローを拡張する状態モデルとして保持するが、Organization MembershipだけでWorkspace一覧を公開する根拠にはしない。初期実装はInvite Onlyを標準とし、次の値を予約する。

| 可視性 | Organization Membershipだけの場合 | Workspace Membershipまたは明示招待後 |
| --- | --- | --- |
| Open | Workspace一覧・metadata・contentを返さない | 指定されたWorkspace roleに従う |
| By Request | Workspace一覧・metadata・contentを返さない | 指定されたWorkspace roleに従う |
| Invite Only | Workspace一覧・metadata・contentを返さない | 指定されたWorkspace roleに従う |
| Hidden | Workspace一覧・metadata・contentを返さない | 明示招待と指定されたWorkspace roleに従う |

## 6. 論理データモデル

物理カラム名は実装時のmigrationで固定するが、次の責務は必須とする。

| 記録 | 必須の責務 |
| --- | --- |
| organizations | opaque ID、name、optional icon / description、作成者、作成・更新・削除時刻。Personal種別や課金状態は持たない。 |
| organization_members | Organization、Account、role、active / removed状態、加入・削除時刻、変更actor。 |
| organization_invitations | Organization、token hash、target Account、role、有効期限、issuer、revoke / accept状態。 |
| workspaces.organization_id | 任意外部キー。所属しないWorkspaceではnullであり、activeな所属は最大一つ。 |
| workspace_members | Workspace contentを扱う権限の正本。Organization Membershipとは別に保持する。 |
| workspace_invitations | Workspace直接招待の正本。Organizationの有無を必要としない。 |
| workspace_events.organization_id | Event時点の任意のOrganization reference。Workspace認可の根拠にはせず、独立WorkspaceのEventではnullを許可する。 |

すべてのIDはopaque IDとし、UIや認可でメールアドレス、表示名、slugを主キーに使わない。

## 7. 認可とAPI境界

~~~mermaid
sequenceDiagram
  participant C as Native App / 外部Client
  participant API as Domain API
  participant OP as Domain Operation
  participant P as Policy + PostgreSQL RLS
  participant DB as PostgreSQL

  C->>API: WorkspaceまたはOrganization操作
  API->>OP: validated command
  OP->>P: Workspace / Room / Organization policy
  P->>DB: transaction under account context
  DB-->>P: allowed result or deny
  P-->>OP: record + Public Event
  OP-->>API: typed response
~~~

- Workspace queryとmutationはWorkspace-firstのAPIを使う。Organizationがなくても同じAPIで操作できる。
- Organization APIは作成、Member、招待、管理者によるWorkspace metadata/list、Workspace追加・解除などの任意管理操作だけを扱う。
- URLやClient状態でOrganizationを先に要求し、Workspace APIをOrganization配下に固定しない。
- Serviceのpolicy checkとPostgreSQL RLSの両方で拒否する。
- Organization MembershipをWorkspace / Room content tableのread / write条件に混ぜない。
- 全てのmutationはcaller、operation ID、idempotency key、対象WorkspaceまたはOrganization、Public Eventを追跡できるようにする。

## 8. Server、Hosted、Self-host

HostedとSelf-hostは、同じWorkspace、Membership、Room、Organizationのモデルを利用する。差分はServerの配置、DB運用、接続先だけである。

現段階のOrganizationは一つのServer内だけを管理する。複数Server上のWorkspaceを一つのOrganizationから横断管理する機能は実装しない。Native AppのWorkspace switcherは、各Serverの認可済みWorkspaceを一つに表示し、Workspace選択時に対象Server接続を裏で解決して再認可する別の接続機能である。内部のWorkspace targetは少なくともServer connectionとworkspace IDの組で識別し、workspace ID単独で別ServerのWorkspaceを参照しない。

Server間のWorkspace移転は、portable bundleのexport、移転先へのrestore、DBと実ファイルの整合性確認、接続先の切替というWorkspace単位の処理である。移転先へOrganization所属を引き継がず、必要なら移転後に同じServer内のOrganizationへ明示的に追加する。Organization IDをServer間の共通認可、content共有、移転の根拠にしてはならない。

## 9. ExportとRestore

- Workspace exportはOrganizationなしで完結する。
- export manifestは、Workspace自身のMember、Room、Activity、Knowledge、ファイル、必要なprovenanceを扱う。
- 所属中のOrganization referenceは任意のprovenanceとして残せるが、restoreの必須入力にしない。
- restore先は独立Workspaceを標準とし、明示操作で同一Server上のOrganizationへ追加できる。
- Server間移転では、移転先の検証と切替が完了するまで移転元を自動削除しない。切替後は移転元をarchiveとして残し、削除は別の明示操作とする。
- Organization全体exportは将来の一括管理機能として扱う。Workspace export / restoreの互換性を壊してはならない。

## 10. 既存実装からの移行

現在の未コミット実装は、AccountへのOrganization自動生成、Workspaceの必須Organization所属、Organization-first API / UIを前提にしている。この設計へ移行する実装では、次を行う。

1. WorkspaceのOrganization所属を任意にし、既存Workspaceを全て独立状態へ戻す。
2. 現在の開発データには利用者が明示作成したOrganizationがないため、自動生成されたOrganization、Organization Membership、Invitation、必須Event scopeを残さない。
3. OrganizationのテーブルとOperationは、任意機能として必要なものだけを残す。
4. Organization未所属のWorkspaceで、招待、Room、Chat、Agent実行、Knowledge、export / restore、再起動復元が成立することを確認する。
5. Native Appから必須Organization選択、zero Organization空状態、Organization配下に固定したWorkspace操作を取り除く。

この移行は本番利用前に行う。既存のOrganizationデータを推測して保存する互換処理や、旧必須構造の残骸を残さない。

## 11. 失敗時の扱いと検証

| 事象 | 扱い |
| --- | --- |
| Organizationなし | Workspace作成・選択を表示し、利用を妨げない |
| Organization追加の競合 | Workspace所属を変更せず、現在の所属を返す |
| Organization解除 | Workspaceのデータ、Member、Room、履歴を保持する |
| Organization削除 | 全所属Workspaceを独立状態へ解除し、contentを削除しない |
| Organization Adminのcontent読取り | denyし、DBを変更しない |
| Workspace直接招待 | Organizationの有無にかかわらず受諾・revoke・期限切れを正しく扱う |
| Server間Workspace移転 | 移転先の整合性確認後に切り替え、移転元をarchiveとして残す。OrganizationをServer間で引き継がない |
| Server再起動 | 独立Workspace、所属Workspaceのどちらも再認可後に開ける |

実PostgreSQL、実ファイル、実Agent、Native Appで少なくとも次を確認する。

1. OrganizationなしのWorkspace作成、招待、Room選択、Chat、証拠確認、学習、再起動。
2. Organization作成、Workspace作成、既存Workspace追加、既存Memberの最小Organization Member追加。
3. Organization Owner / AdminがWorkspace Membershipを管理できる一方、contentを読めないこと。
4. Workspace直接招待がOrganizationなし・所属済みの両方で動くこと。
5. Workspace解除とOrganization削除後も、WorkspaceのID、データ、export / restoreが維持されること。
6. 同一Server外のWorkspaceをOrganizationへ追加できないこと。

## 12. 対象外と将来

現段階では、決済、課金、SSO、SCIM、複雑な企業監査、専用Compute、Compute共有、詳細な利用量管理、複数Server横断Organizationを実装しない。

将来これらを追加しても、Workspaceを単体で成立させる原則、Workspace Membershipがcontent accessを決める原則、Organizationが任意である原則を崩してはならない。
