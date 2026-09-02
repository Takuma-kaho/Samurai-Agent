# Workspace-first・Organization再設計マスタープラン

- 状態: 実装承認済み。別チャットで実装開始可能
- 作成日: 2026-09-02
- 基準コミット: 74a73cf
- 対象ブランチ: codex/native-app-productization
- 旧計画: 本計画へ置換済み。混同防止のため削除
- 正本: [PRODUCT.md](../PRODUCT.md)、[ARCHITECTURE.md](../ARCHITECTURE.md)
- 詳細設計: [organization.md](../docs/designs/organization.md)、[native-app.md](../docs/designs/native-app.md)

最新の会話合意により、Native AppはBuzzのCommunity switcherと同じく、Workspaceを利用者向けの切替単位とし、Serverを裏側の配置先として扱う。この点は現在のnative-app.mdに残るConnection selector先行の記述より新しく、Phase 0で正本と詳細設計へ反映してから実装する。

本計画は、Phase 2で実装したOrganization必須構造を、Workspace単体で成立する構造へ完全移行するための承認済み実装計画である。旧計画は本計画へ置き換えて削除し、過去内容はGit履歴から参照する。

- 未決定事項: なし
- Server間移転後の移転元Workspace: archiveへ確定。自動削除せず、削除は別の明示確認操作とする

---

## 1. 目的と完成体験

### 1.1 目的

Samuraiの基本単位をWorkspaceへ戻し、個人利用や小規模チームではOrganizationを意識せず利用できるようにする。同時に、大規模利用者が複数Workspaceをまとめて管理したい場合だけ、Organizationを任意の追加機能として利用できる構造にする。

### 1.2 今回完成させる一本の体験

1. 利用者がNative Appの統合Workspace一覧を開く。
2. Serverの違いを意識せず、OrganizationなしのWorkspaceを作成または選択する。
3. Roomで実Agentへ依頼する。
4. 実行結果、証拠、ファイル、学習結果を保存する。
5. 再起動後も保存内容を利用できる。
6. 次回のAgent実行で学習結果を再利用する。
7. 人間が結果を確認し、必要なら修正する。
8. 必要な利用者だけ、複数WorkspaceをOrganizationへ追加して管理する。
9. Organizationを解除または削除しても、Workspaceは独立状態で利用し続けられる。
10. 必要な場合はWorkspaceを別Serverへ移転し、検証後も同じWorkspaceとして利用し続けられる。

Organizationの操作だけを通しても完成とはしない。Workspace単体の実Agent体験を先に成立させ、その上にOrganization操作を重ねる。

---

## 2. 製品上の固定方針

### 2.1 基本階層

~~~mermaid
flowchart TD
    UI[Native App Workspace switcher] --> W1[Workspace A]
    UI --> W2[Workspace B]
    W1 --> R1[Room]
    W2 --> R2[Room]
    W1 -. 配置先 .-> S1[Server A]
    W2 -. 配置先 .-> S2[Server B]
    O[Optional Organization] -. 同一Server内の管理 .-> W1
    R1 --> C1[Chat / Agent / Evidence]
    R2 --> C2[Chat / Agent / Evidence]
~~~

- Workspaceが製品の基本単位であり、Organizationなしで作成・招待・利用・Export・Restoreできる。
- Organizationは複数Workspaceをまとめる任意の管理レイヤーである。
- WorkspaceはOrganizationに所属しないか、同一Server内の1つのOrganizationにだけ所属する。
- 現段階のOrganizationは同一Server内限定とする。
- 複数Server横断のOrganization管理は将来拡張として明記し、今回の抽象化や疑似実装には含めない。
- Room、Chat、Agent、Evidence、Knowledge、Skillの利用権限はWorkspace側で完結させる。
- Native Appでは、登録済みの複数ServerにあるWorkspaceを一つのWorkspace switcherへ統合する。
- ServerはWorkspaceの配置先と接続情報であり、通常操作の先頭に置く製品階層ではない。
- Workspaceを選ぶと、Native Appが対応するServer接続と資格情報を裏で選択し、再認可してから表示する。
- このWorkspace切替は、複数Server横断Organizationとは別のNative App接続機能である。

### 2.2 権限境界

- Organization MembershipだけではWorkspaceやRoomの内容を閲覧できない。
- Workspace Membershipがコンテンツ認可の根拠である。
- Organization Owner/Adminは管理操作としてWorkspace Membershipを追加・削除できる。
- Workspaceへの直接招待はOrganizationの有無に関係なく利用できる。
- WorkspaceをOrganizationへ追加するとき、既存WorkspaceメンバーをOrganizationの最低権限メンバーとして補完する。
- 補完時にWorkspace Role、Room Role、コンテンツ閲覧権限は変更しない。

### 2.3 ライフサイクル

- Organization作成は明示操作とし、初回起動やWorkspace作成時に自動生成しない。
- Organization内から作ったWorkspaceも通常のWorkspaceであり、後から独立状態へ戻せる。
- OrganizationからWorkspaceを解除しても、Workspace本体と内部データは残す。
- Organizationを削除すると、所属Workspaceをすべて独立状態へ戻してからOrganizationだけを削除する。
- 本番利用前で既存Organizationを保存する必要がないため、現在の自動生成Organizationや必須関連は完全移行で除去する。
- WorkspaceはServer AからServer Bへ移転できる。移転はportable bundleのExport、移転先Restore、DBと実ファイルの整合性確認、Native Appの接続先切替という順序で行う。
- Server間移転ではOrganization所属を引き継がず、移転先では独立WorkspaceとしてRestoreする。必要ならRestore後に移転先Server内のOrganizationへ追加する。
- Server間を跨ぐ単一transactionは作れないため、再実行可能なtransfer IDと明示的な状態遷移で中断復旧する。
- 移転先を検証して切替が完了するまで、移転元を自動削除しない。切替後は移転元をarchiveし、削除は別の明示確認操作とする。

### 2.4 Native Appの主導線

~~~text
Workspace選択 → 接続先Serverを裏で解決・再認可 → Room選択 → Chat / Agent / Evidence
~~~

- 初期画面は、登録済みの全接続先を横断したWorkspace一覧とし、Server選択やOrganization選択を起動条件にしない。
- Serverの追加、資格情報、接続障害は設定・補助情報として扱い、通常ナビゲーションの最上位に置かない。
- Workspace作成・参加時には配置先Serverを確定するが、作成後の主操作はWorkspace名による切替とする。
- Organization未作成は正常状態であり、警告や設定不足として扱わない。
- Organization UIは、利用者が追加機能を使う場合だけ表示する。
- デザイン完成より先に、実Agent、実PostgreSQL、実ファイル、再起動保持を操作できる簡素なUIを成立させる。

---

## 3. 禁止事項

- UIからOrganizationを隠すだけで、DBのorganization_id必須制約を残さない。
- Organization MembershipをWorkspace内容の閲覧許可として使わない。
- Workspace APIとOrganization配下のWorkspace APIで、異なる認可規則を重複実装しない。
- Serverを選択してからWorkspace一覧を開く二段階ナビゲーションを主導線にしない。
- 異なるServerに同じworkspace_idが存在しても、ID衝突や誤接続を起こす実装にしない。
- Workspace選択前のlocal cacheだけを認可根拠として内容を表示しない。
- Server間移転を、ファイルだけのcopy、DBだけのcopy、接続先URLの書換えで完了扱いしない。
- 移転先の整合性確認前に移転元Workspaceを削除しない。
- Server間の処理を成功したように見せるため、分散transactionや同時書込みを擬似実装しない。
- 自動生成されたOrganizationをPersonal Organizationなどの別概念に名前だけ変えて残さない。
- 移行対象外となったOrganization IDをEvent、Bundle、Desktop設定へ残さない。
- Workspace、Room、Agent、Knowledge、Evidenceの責務をOrganizationへ移さない。
- 将来の複数Server対応を理由に、今回使わない分散管理層を先行実装しない。
- テスト専用の成功分岐、固定ID、実行時の認可回避を追加しない。
- focused test、型検査、静的Migration検査だけで実PostgreSQLやNative App E2E成功と判定しない。
- 実装後すぐにUI仕上げ、push、PRへ進まない。実機dogfoodingと修正再実行を先に行う。

---

## 4. 確認済みの現状

基準コミット74a73cfには、旧方針に基づくOrganization必須のPhase 2実装と、React/Electron Native Appの基盤が含まれている。

### 4.1 残す基盤

- React Native App shell、Electron起動、Server接続状態表示
- 複数のServer URLとAccountを保持・選択できるWorkspace connection registry
- Server接続ごとに最後のWorkspace候補を保持し、選択時に接続先を切り替えるElectron IPC
- Workspace、Room、Chat、Evidenceの基本画面
- Workspace Server、PostgreSQL接続、認可基盤
- 実Agentのstreaming、session、approval、evidence保存経路
- 同一Server上の複数Workspace対応
- Workspace単位のRuntime、Knowledge、Skill、Export、Restoreの設計思想
- idempotency、transaction、監査Event、生成bindingの検証基盤

### 4.2 修正が必要な部分

- workspaces.organization_idの必須制約
- Organizationの自動生成と初期選択
- Organizationから始まるWorkspace一覧取得、作成、切替
- zero-organizationを異常状態とするNative App状態
- OrganizationSwitcherを主導線とする画面構造
- Organization必須を前提としたDomain API、HTTP API、Desktop bridge
- Organization IDを必須前提としたWorkspace EventやBundle処理
- 現在のactive connectionだけを前提にOrganizationとWorkspaceを読み込むNative App hook
- WorkspaceではなくServer connectionを選択単位とし、serverUrlとaccountIdだけで重複排除するconnection registry
- 複数ServerのWorkspaceを一つに集約するswitcherと、Workspace選択時の接続先自動切替がないこと
- Workspace BundleのExport・Restore部品は存在するが、現状はOrganization前提であり、別Serverへの移転、cutover、中断復旧、実環境E2Eは完成していないこと
- 現在のworkspace moveは同一Server内のOrganization間移動であり、Server間Workspace移転ではないこと
- 旧Organization前提のテスト、fixture、検証報告

### 4.3 既存検証の扱い

旧Phase 2では関連テスト、型検査、Desktop build、静的Migration検査などが実行されている。ただし、これは旧Organization必須構造の証拠であり、新構造の成功証拠として流用しない。

未完了の実PostgreSQL RLS、Hosted/Self-host migration、rollback、実Electron、実Agent、実ファイル、再起動保持は、本計画内で改めて確認する。

---

## 5. 対象範囲

### 5.1 含める

- Workspace単体の作成、一覧、選択、参加、招待、Membership、権限
- Organizationなしで動くRoom、Chat、Agent、Evidence、Knowledge、Skill
- Organizationの明示作成、Membership、権限
- WorkspaceのOrganizationへの追加、解除、同一Server内の付け替え
- Organization削除時のWorkspace独立化
- Workspace作成元に依存しない同一ライフサイクル
- Workspace direct invite
- 初期Workspace visibilityとしてInvite Only
- 将来のOpen、By Request、Hiddenへ拡張できる状態モデル
- 既存データをOrganization必須構造から独立Workspaceへ戻す完全Migration
- Workspace-firstのDomain API、HTTP API、Desktop bridge
- 複数Serverの認可済みWorkspaceを統合表示するWorkspace directory
- Workspace選択から対応するServer接続を自動選択するNative App switcher
- Server・Account・Workspaceの組で衝突しないWorkspace target識別
- Workspaceごとの接続状態、再認可、最後に開いたRoomの復元
- Hosted、Self-hostを問わないServer間Workspace移転
- 移転前確認、portable bundle、移転先Restore、整合性検証、cutover、中断再開、移転元の明示削除
- 実PostgreSQLでの認可、移行、rollback、再実行
- Native AppのWorkspace-first操作
- 実Agent、実ファイル、学習再利用、再起動保持のE2E
- dogfooding後の問題修正と再検証

### 5.2 含めない

- 課金、請求、利用量の詳細管理
- Samurai運営による専用Compute提供
- Native Agentを別途立てる仕組み
- 複数Server横断Organization
- SSO、SCIM、企業ディレクトリ同期
- メール送信基盤とメール招待
- 複雑な企業監査、法令対応レポート
- Workspace visibilityのOpen、By Request、HiddenのUI完成
- インストーラー、署名、公証、自動更新
- 全画面のデザイン完成と広範な横機能追加

---

## 6. 責務境界

| 層 | 責務 | 持たせない責務 |
|---|---|---|
| Server | Workspaceの配置先、DB、Storage root、接続・資格情報の境界 | 利用者向けの最上位ナビゲーション、コンテンツ権限の代替 |
| Workspace | Membership、Room、Chat、Agent、Evidence、Knowledge、Skill、Export/Restore | 複数Workspaceの企業管理 |
| Organization | 複数Workspaceの関連付け、Organization Membership、管理者によるWorkspace Membership管理 | Room/Chat内容の自動閲覧権 |
| Room | 会話と作業コンテキスト | ServerやOrganizationの管理 |
| Native App | 複数ServerのWorkspace統合表示、Workspace選択に伴う接続切替、Roomの操作と状態表示 | 独自認可やDB規則、Server-firstの製品階層 |
| PostgreSQL | 関係、権限、履歴、transaction | Knowledge/Skill本文の唯一の保存先 |
| Storage root | 実ファイル、Evidence、Knowledge/Skill本文 | Membership判定 |

### 6.1 認可の原則

~~~text
Organization管理操作
  → Organization Membership / Roleで判定

Workspace・Room・コンテンツ操作
  → Workspace Membership / Room Roleで判定

Organization AdminによるWorkspace Membership管理
  → 明示的な管理権限として判定
  → コンテンツ閲覧権へは変換しない
~~~

### 6.2 Eventの原則

- workspace_idはWorkspace Eventの主スコープとして維持する。
- organization_idは関連付け時点の補助的なprovenanceとして必要な場合だけ持つ。
- organization_idの有無を、Workspace内容の認可条件にしない。
- Workspace解除後もEventの意味と追跡性を失わない形を選ぶ。

### 6.3 Workspace targetと接続の原則

- 利用者へ見せる選択単位はWorkspaceとする。
- 内部のWorkspace targetは、少なくともconnection_idとworkspace_idの組で一意にする。
- connectionはServer URL、Account、資格情報を扱い、Workspace targetはそのconnection上のWorkspaceを指す。
- 同じWorkspace IDが異なるServerに存在しても、別Workspaceとして安全に扱う。
- Workspace一覧のlocal情報は表示候補にすぎず、選択時には対象ServerでMembershipを再認可する。
- Workspace Aから別Server上のWorkspace Bへ切り替える処理は、接続、realtime、選択状態、Room候補を一つの切替操作として更新する。
- 一つのServerがofflineでも、ほかのServer上のWorkspaceまで利用不能扱いにしない。

---

## 7. 要件対応表

| ID | 要件 | 実装Phase | 主な証拠 |
|---|---|---|---|
| R1 | OrganizationなしでWorkspaceを利用できる | 1、2、5 | DB、API、Native App E2E |
| R2 | Workspaceは0または1 Organizationに所属する | 1、3 | 制約、transaction test |
| R3 | Organization Membershipだけでは内容を読めない | 2、3、6 | 実PostgreSQL allow/deny |
| R4 | 追加時に既存WorkspaceメンバーをOrganizationへ補完する | 3 | membership test、実DB |
| R5 | 解除・Organization削除後もWorkspaceを保持する | 3、6 | rollback、restart E2E |
| R6 | Workspace direct inviteが単独で動く | 2、5、6 | API/UI E2E |
| R7 | Export/RestoreがOrganizationなしで動く | 2、4、6 | Bundle round-trip |
| R8 | Native AppがWorkspace-firstで起動する | 5、6 | Electron E2E |
| R9 | 旧必須構造を残骸なく完全移行する | 1、6 | Migration、schema監査 |
| R10 | 実Agent・実ファイル・学習再利用を確認する | 6、7 | 実機report、dogfooding |
| R11 | PR前に利用者確認で停止する | 7 | 明示承認待ち |
| R12 | 複数ServerのWorkspaceを一つのswitcherで切り替える | 2、5、6 | target contract、Electron E2E |
| R13 | Workspaceを別Serverへ安全に移転できる | 4、5、6 | two-server transfer E2E、hash照合、再開test |

---

## 8. 旧計画からの移行

| 旧計画の領域 | 扱い | 新計画での位置 |
|---|---|---|
| 正本文書更新 | Organization任意化は維持し、Buzz型Workspace switcherを追記 | Phase 0 |
| Organization schemaと自動作成 | 必須前提を廃止 | Phase 1 |
| Organization APIとEvent | 任意管理機能へ分離 | Phase 2、3 |
| PostgreSQL RLS | Workspace-firstへ再構成 | Phase 2、5 |
| Self-host複数Workspace | 維持 | Phase 1、2 |
| Organization間Workspace move | 同一Server内の任意管理操作として整理 | Phase 3 |
| Export/Restore | Organization非依存化し、Server間移転の基盤へ発展 | Phase 2、4、6 |
| Server間Workspace移転 | portable bundle、検証、cutover、中断復旧を新設 | Phase 4、5、6 |
| React Native shell | 維持 | Phase 5 |
| ElectronとChat | 維持し回帰確認 | Phase 5、6 |
| 複数Server connection registry | Workspace target registryと全Server横断switcherへ発展 | Phase 2、5、6 |
| Organization管理UI | 追加機能へ降格 | Phase 5 |
| 旧E2E | 新しい主導線で再実行 | Phase 6、7 |

旧計画は本計画への置換時に削除し、並行する2つのマスタープランを残さない。

---

## 9. 実装Phase

### Phase 0: 基準点固定と変更対応表の確定

#### 目的

基準コミットから、残す実装、修正する実装、廃止する実装をファイル単位で確定し、変更漏れと不要な作り直しを防ぐ。

#### 主な対象

- packages/workspace-server
- packages/domain-api
- packages/domain
- apps/server
- apps/web/src/native-app
- apps/desktop
- PRODUCT.md
- ARCHITECTURE.md
- docs/designs/native-app.md
- docs/designs/organization.md
- apps/desktop/src/workspace-connections.ts
- apps/web/src/lib/workspace-browser-bridge.ts
- apps/web/src/lib/native-app-preferences.ts
- packages/workspace-server/src/workspace-bundle-v3.ts
- packages/workspace-server/src/workspace-completion-bundle-v4.ts
- packages/domain-operations/src/operations/organization/workspace-bundle-export.operation.ts
- packages/domain-operations/src/operations/organization/workspace-bundle-restore.operation.ts
- packages/electron-startup-orchestrator

#### 作業

1. HEADと未コミット差分を確認する。
2. organization_id、自動Organization、zero-organization、OrganizationSwitcher、Organization配下routeを横断検索する。
3. activeConnectionId、serverUrlとaccountIdによる重複排除、lastWorkspaceId、selectWorkspaceCandidateの現在の実行経路を確認する。
4. DB、Domain、API、Desktop bridge、UI、test、fixture、reportの依存表を作る。
5. PRODUCT.mdとARCHITECTURE.mdにはWorkspaceが主語でServerが配置先であり、Workspaceが別Serverへ移転可能であることを短く反映する。具体的な全Server横断switcher、Workspace target、再認可はnative-app.mdへ反映する。
6. organization.mdでは同一Server内Organizationの制限を維持し、Native Appの複数Server Workspace切替とServer間Workspace移転をOrganization横断管理と混同しないよう明記する。
7. BuzzはCommunity switcherからRelay接続を切り替える導線と、tenant解決、transaction、idempotencyを必要箇所だけ再確認する。
8. Slackは通常Workspaceが単独で成立し、Enterprise側が追加管理層になる境界だけを参考にする。
9. 旧計画が削除され、新計画だけが実装基準として残っていることを確認する。

#### 禁止境界

- 調査中にschemaやUIだけを先行変更しない。
- BuzzやSlackの名称、権限体系、製品階層をそのまま移植しない。

#### 検証

- 変更対象と対応要件がすべてR1からR13へ紐づくこと。
- 必須Organization前提の検索結果に分類漏れがないこと。
- Server-firstのUI、単一active connection前提、Workspace ID単独参照の検索結果に分類漏れがないこと。

#### 完了条件

- ファイル単位の変更対応表が確定している。
- 正本と詳細設計が、Server-firstではなく全Server横断Workspace switcherで一致している。
- 既存差分と利用者の変更を壊さない編集順が決まっている。

#### 次のGate

DB完全移行の削除対象と保持対象を明示できること。

---

### Phase 1: Workspace単体DBと完全Migration

#### 目的

OrganizationなしのWorkspaceをDB上の正常状態にし、旧必須構造の残骸を除去する。

#### 主な対象

- packages/workspace-server/src/schema.ts
- packages/workspace-server/src/postgres-schema.ts
- packages/workspace-server/src/postgres-migration.ts
- packages/workspace-server/src/postgres-rls.ts
- packages/workspace-server/src/postgres-migration-tests.ts
- schema生成物と関連test

#### データフロー

~~~text
旧DB
  → Workspaceと内部データを保持
  → WorkspaceとOrganizationの必須関連を解除
  → 自動生成Organizationと関連Membershipを削除
  → Workspace単体schemaへ確定
  → 再実行しても同じ結果
~~~

#### 実装要件

- workspaces.organization_idを任意にするか、明示的な関連テーブルへ移すかを現行queryとlock順から決定する。
- 0または1 Organization制約をDBで保証する。
- Workspace、Room、Session、Message、Evidence、Knowledge、Skill、MembershipのIDとデータを保持する。
- Organization IDを認可の必須入力にしている関数、view、policy、triggerを除去または任意化する。
- EventのOrganization参照はprovenance用途に限定する。
- 完全Migrationはtransaction内で行い、失敗時に中間状態を残さない。
- Migrationは冪等に再実行できる。

#### テスト

- 空DBへの新規適用
- 旧Organization必須schemaからのMigration
- 複数Workspaceを持つ旧ServerからのMigration
- Migration中の意図的失敗とrollback
- Migration再実行
- 外部キー、unique、NOT NULL、RLS policyの実schema確認
- Workspace内部データの件数と参照整合性確認

#### 自己レビュー

- 自動生成Organization、不要Membership、古い必須column、triggerが残っていないか。
- Organization削除がWorkspace削除へcascadeしないか。
- lock順がattach、detach、deleteで一貫しているか。

#### 完了条件

- OrganizationなしのWorkspaceをDBから作成・取得できる。
- 旧データがWorkspace単体へ残骸なく移行する。
- 実PostgreSQLでrollbackと再実行を確認できる準備が整う。

#### 次のGate

APIがOrganization IDなしでWorkspaceを扱えるschemaになっていること。

---

### Phase 2: Workspace-first Domain・API・認可

#### 目的

Workspaceの基本操作をOrganizationから完全に独立させ、すべてのクライアントが同じ認可規則を使うようにする。

#### 主な対象

- packages/domain-api/src/index.ts
- packages/domain
- apps/server/src/workspace-server/http-server.ts
- apps/desktop/src/main.ts
- apps/desktop/src/preload.cts
- apps/web/src/lib/workspace-browser-bridge.ts
- apps/web/src/lib/native-app-preferences.ts
- packages/workspace-server/src/workspace-bundle-v3.ts
- packages/workspace-server/src/workspace-completion-bundle-v4.ts
- packages/domain-operations/src/operations/organization/workspace-bundle-export.operation.ts
- packages/domain-operations/src/operations/organization/workspace-bundle-restore.operation.ts
- 関連testと生成binding

#### API境界

~~~text
Workspace API
  list / create / read / update / invite / membership / export / restore
  → Organization ID不要

Organization API
  create / membership / attach / detach / delete
  → 任意管理機能として分離
~~~

#### 実装要件

- 各Serverは、そのServer上でAccountが利用できるWorkspace一覧をOrganization IDなしで返せるようにする。
- Native Appが複数接続先の結果を統合できる、安定したWorkspace summary契約を提供する。
- Workspace summaryには内部で接続先と対応づけられるWorkspace IDを含めるが、Serverを製品階層として強制しない。
- Workspace direct inviteとMembership管理をOrganizationなしで成立させる。
- Room、Chat、Agent、Evidence、Knowledge、SkillはWorkspace Membershipで認可する。
- Organization Membershipだけの利用者がWorkspace一覧や内容を読めないことを保証する。
- Organization AdminによるWorkspace Membership管理だけは明示的な管理権限として分離する。
- Export/RestoreはOrganization IDなしで実行できる。
- Restore先Workspaceは独立状態を既定とし、Organizationへの追加は別操作にする。
- HTTP、Desktop、Browser bridgeが同じApplication ServiceまたはFacadeを通り、認可を重複させない。
- Desktop bridgeはWorkspace targetを受け取り、対応するconnectionとWorkspaceを同時に選択できる契約を持つ。
- idempotency key、error code、監査Eventの契約を維持する。

#### テスト

- OrganizationなしのWorkspace CRUD
- direct invite、accept、revoke、role変更
- Workspace memberのallowと非memberのdeny
- Organization memberだけのdeny
- Organization Admin管理操作とコンテンツ閲覧の分離
- Export/Restore round-trip
- HTTP、Desktop client、Browser bridgeの契約一致
- 二つのServerから取得したWorkspace summaryの統合と、同一workspace_id衝突時の分離
- Workspace target選択時の接続切替、Membership再認可、拒否時の安全な状態復元
- 生成bindingの差分検査

#### 自己レビュー

- organizationIdが便宜上の必須parameterとして残っていないか。
- transportごとに認可結果が変わらないか。
- connectionIdとworkspaceIdの片方だけで別ServerのWorkspaceへ誤接続しないか。
- error時にMembershipやファイルの一部だけが残らないか。

#### 完了条件

- Organizationを1件も作らず、Workspaceの全基本操作がAPIから完結する。
- 実PostgreSQL RLSでWorkspace境界を検証できる。

#### 次のGate

任意Organization機能を追加してもWorkspace APIを変更しない構造になっていること。

---

### Phase 3: 任意Organization管理機能

#### 目的

複数Workspace管理が必要な利用者だけがOrganizationを追加し、安全に関連付けと解除を行えるようにする。

#### 主な対象

- packages/workspace-serverのOrganization repository/service
- packages/domain-apiのOrganization contract
- apps/serverのOrganization route
- Membership、Event、idempotency、transaction関連test

#### 操作フロー

~~~mermaid
stateDiagram-v2
    [*] --> Standalone
    Standalone --> Attached: Organizationへ追加
    Attached --> Standalone: Organizationから解除
    Attached --> Standalone: Organization削除
    Attached --> Attached: 同一Server内で付け替え
~~~

#### 実装要件

- Organizationは利用者の明示操作でだけ作成する。
- attach時にWorkspaceとOrganizationが同一Serverであることを検証する。
- attach、detach、付け替え、Organization削除はtransactionと一貫したlock順で処理する。
- attach時に既存WorkspaceメンバーをOrganization最低権限へ冪等に補完する。
- 既存Organization Roleが高い場合は降格しない。
- Workspace Role、Room Role、コンテンツ権限は変更しない。
- detach時にWorkspace内部データとWorkspace Membershipを変更しない。
- Organization削除時は全Workspaceを独立化し、Organization固有データだけを削除する。
- Organization内から作るWorkspaceも通常のWorkspace作成処理を再利用し、最後にattachする。
- Workspace visibilityはInvite Onlyを初期値とし、将来状態を表現できる契約だけを用意する。

#### テスト

- create、rename、membership、role変更、delete
- attach、重複attach、別Organization所属時の拒否またはatomic付け替え
- detach、再attach
- attach時のMembership補完とrole不変
- Organization memberだけのコンテンツdeny
- Organization AdminによるWorkspace Membership管理
- Organization削除後のWorkspace継続利用
- 同時attach、detach、deleteの競合
- idempotency replayと部分失敗rollback

#### 自己レビュー

- Organization削除にWorkspace cascadeが混入していないか。
- Membership補完が招待承認や閲覧権付与を暗黙に行っていないか。
- Organization操作を使わないWorkspaceに性能・操作上の負担が増えていないか。

#### 完了条件

- Organizationがなくても製品が動き、追加しても認可とデータ境界が変質しない。
- attach、detach、deleteを繰り返してWorkspaceが壊れない。

#### 次のGate

Native AppがWorkspace-first APIだけで初期表示できること。

---

### Phase 4: Server間Workspace移転

#### 目的

WorkspaceをServer AからServer Bへ、DB上の関係、実ファイル、Evidence、Knowledge、Skill、履歴、Membershipを壊さず移転できるようにする。HostedからSelf-host、Self-hostからHosted、Self-host間でも同じportable bundle契約を使う。

#### 主な対象

- packages/workspace-server/src/workspace-bundle-v3.ts
- packages/workspace-server/src/workspace-server-commands.ts
- packages/workspace-server/src/workspace-completion-bundle-v4.ts
- packages/domain-operations/src/operations/organization/workspace-bundle-export.operation.ts
- packages/domain-operations/src/operations/organization/workspace-bundle-restore.operation.ts
- apps/serverのWorkspace export・restore route
- packages/domain-apiのBundle・transfer contract
- apps/desktop/src/main.ts
- apps/desktop/src/workspace-connections.ts
- apps/web/src/native-appのWorkspace移転操作
- Bundle、Migration、rollback、Desktop bridgeの関連test

実装開始時に現行のBundle実行経路を再確認し、存在しないmoduleやrouteを新設前提で断定しない。

#### 移転フロー

~~~mermaid
stateDiagram-v2
    [*] --> Preflight
    Preflight --> Exported: Sourceを固定してBundle作成
    Exported --> Restoring: Target Serverへ送信
    Restoring --> Verified: DB・file・hash検証成功
    Verified --> Cutover: Native AppのWorkspace target切替
    Cutover --> SourceRetained: Sourceをarchiveで保持
    SourceRetained --> SourceDeleted: 利用者が別操作で明示削除
    Preflight --> Failed: 条件不成立
    Exported --> Failed: Restore失敗
    Restoring --> Failed: 検証失敗
    Failed --> Preflight: 同じtransfer IDで安全に再開
~~~

#### 実装要件

- 移転元と移転先は異なるServer connectionとして明示選択する。
- 移転先ServerはWorkspace作成権限、schema互換性、容量、ID衝突、必要なAccount identityをpreflightで確認する。
- Workspace IDは移転先に衝突がなければ維持する。衝突時に既存Workspaceを上書きせず、preflightで停止する。
- portable bundleは、Workspace本体、Membership、Room、Chat、Activity、Evidence、Knowledge、Skill、Agent設定、実ファイル、version、manifest、各file hashを含む。
- secret、Server固有credential、local絶対path、Organization所属はBundleへ持ち込まない。
- 移転先はStandalone WorkspaceとしてRestoreし、Organization追加は移転完了後の別操作にする。
- export開始時のWorkspace versionを固定し、最終Bundle作成中の書込みを安全に停止または拒否する。
- Server間を一つのDB transactionに見せず、transfer IDと冪等なexport・restore operation IDで段階を記録する。
- 同じtransfer IDの再送でWorkspaceやfileを重複作成しない。
- Restore失敗時は移転先のDBとstorageに不完全な残骸を残さない。cleanup失敗は隠さず復旧可能な状態として記録する。
- Restore後にrecord件数、参照整合性、manifest、file hash、Workspace versionを移転元と照合する。
- 検証完了後にNative AppのWorkspace targetを移転先connectionへ切り替え、Room候補とrealtimeを再認可する。
- cutover完了前は移転元を自動削除しない。cutover後の移転元は二重書込みを避けるためarchiveし、削除は別の明示確認操作にする。
- Native AppやServerが中断しても、最後に確定した状態から再開または安全に取消できる。

#### UI境界

- Server選択を通常ナビゲーションへ戻さない。
- Workspace管理の「移転」操作でだけ移転先Serverを選ぶ。
- preflightには、移転元、移転先、データ量、書込み停止、Organization解除、移転元がarchiveされることを表示する。
- cutover後は同じWorkspace名を主表示とし、配置先Serverだけを補助情報として更新する。

#### テスト

- Server AからServer Bへのportable bundle round-trip
- Hosted相当からSelf-host相当、Self-host相当からHosted相当
- Workspace ID、Room ID、Membership、履歴、Knowledge、Skill、Agent設定の保持
- 実ファイル件数、size、hashの一致
- 移転先Workspace ID衝突時の無変更拒否
- schema version非互換、容量不足、権限不足、通信切断の拒否
- export中の書込み競合とversion conflict
- restore途中のDB error、file error、Native App終了、Server再起動
- 同一transfer IDの再開と冪等性
- Restore失敗後のDB・storage残骸ゼロ
- cutover後に移転先だけへChat、Agent、realtime requestが送られること
- 移転元がarchiveされ、明示削除するまで自動削除されないこと

#### 自己レビュー

- Organization間移動とServer間移転を同じoperationとして混同していないか。
- BundleにServer secret、credential、絶対pathが含まれていないか。
- DB成功・file失敗、file成功・DB失敗の両方を復旧できるか。
- cutover前にsourceを削除、cutover後にsourceへ書込み、target検証前に成功表示していないか。
- 旧Server offline時でも、確定済みの移転状態と復旧方法を利用者へ説明できるか。

#### 完了条件

- 実際に異なる二つのServerとStorage rootを使い、Workspaceを移転できる。
- DB、実ファイル、Evidence、Knowledge、Skill、Agent設定の整合性がhashと件数で確認される。
- 中断と再実行で重複や残骸が発生しない。
- cutover後、Native AppのWorkspace switcherから同じWorkspaceを選ぶと移転先Serverへ接続される。
- 移転元はarchiveされ、利用者の明示削除操作まで安全に保持される。

#### 次のGate

Native Appが、通常切替とServer間移転後のcutoverを同じWorkspace targetモデルで扱えること。

---

### Phase 5: Native AppのWorkspace-first化

#### 目的

Native AppをBuzzのCommunity switcherと同じ考え方へ変更する。複数Server上のWorkspaceを一つの一覧に表示し、Workspaceを選ぶだけで対応するServer接続へ裏で切り替える。Organizationは任意の管理画面へ移す。

#### 主な対象

- apps/web/src/native-app/NativeApp.tsx
- apps/web/src/native-app/use-native-app.ts
- apps/web/src/native-app/types.ts
- WorkspaceNavigator、RoomNavigator、ChatSurface、EvidenceInspector
- OrganizationSwitcher、OrganizationManagement
- apps/desktop/src/main.ts
- apps/desktop/src/workspace-connections.ts
- apps/desktop/src/workspace-organization-requests.ts
- apps/web/src/lib/native-app-preferences.ts
- apps/desktop/src/preload.cts、apps/web/src/lib/workspace-browser-bridge.ts、関連test

#### 画面骨格

~~~text
Side navigation
  Workspace switcher（全Server横断）
  Room list
  Organization management（利用時だけ）

Main
  Chat
  Agent execution status
  Approval
  Evidence / files

Settings / secondary surface
  Server connection追加・修正
  Workspaceの配置先・接続状態
  Workspaceを別Serverへ移転
~~~

#### Workspace切替フロー

~~~mermaid
sequenceDiagram
  participant U as User
  participant D as Native App
  participant R as Workspace target registry
  participant S as Target Server
  U->>D: Workspace Bを選択
  D->>R: connection_id + workspace_idを解決
  D->>D: 旧realtimeと選択状態を安全に切替
  D->>S: 対象AccountでWorkspace Bを再認可
  alt 許可済み
    S-->>D: Workspace / Room summary
    D-->>U: Workspace Bを表示
  else offlineまたは拒否
    S-->>D: 接続失敗またはdeny
    D-->>U: Workspace Bだけに安全なerrorを表示
  end
~~~

#### 実装要件

- 起動時にOrganization一覧を先に要求しない。
- zero-organization状態を削除し、Workspace 0件を通常の初期状態として扱う。
- 登録済みの全connectionから認可済みWorkspace summaryを取得し、一つのWorkspace switcherへ統合する。
- ServerごとのWorkspace一覧を最上位ナビゲーションとして表示しない。
- Workspace項目は表示名を主とし、配置先Serverと接続状態は補助情報として扱う。
- Workspace targetはconnection_idとworkspace_idの組で識別し、異なるServer間のID衝突を防ぐ。
- Workspaceを選ぶと、対応するServer connection、Account資格情報、active Workspace、realtime接続を裏で切り替える。
- 選択後に対象Serverへ再認可し、許可されたWorkspaceとRoomだけを表示する。
- 最後に利用したWorkspace targetとRoom候補を復元するが、再認可前に内容を表示しない。
- Workspaceの作成・招待参加では配置先Serverを確定し、成功後にWorkspace switcherへ追加する。Server選択を常設の主導線にはしない。
- Workspace管理からServer間移転を開始し、preflight、進行状態、検証結果、cutover、移転元の状態を表示する。
- cutover成功時は同じWorkspace項目のtarget connectionを移転先へ更新し、重複した二つの通常Workspaceとして表示しない。
- 一つのServerがofflineでも、ほかのServer上のWorkspace一覧と操作を維持する。
- Organization groupingは任意表示とし、Standalone Workspaceも同じ一覧で操作できるようにする。
- Organization管理画面からcreate、attach、detach、delete、Membership管理を操作できる。
- Chat、Agent streaming、Approval、Evidence、Connection、再接続の既存機能を維持する。
- デザイン仕上げは行わず、状態、エラー、空表示、操作結果が判断できる骨格に留める。

#### テスト

- Organization 0件、Workspace 0件の初回表示
- Server AのWorkspace AとServer BのWorkspace Bを同じswitcherへ表示
- Workspace AからWorkspace Bを選び、接続先、資格情報、realtime、Roomが自動で切り替わること
- 異なるServer上で同じworkspace_idを持つ二つのWorkspaceを誤接続せず表示
- Server AがofflineでもServer BのWorkspaceを開けること
- 切替先でMembershipがrevoke済みの場合に内容を閉じ、ほかのWorkspaceを壊さないこと
- Standalone Workspace作成、招待参加、切替
- Room選択と実Chat経路
- Organization追加後のgroup表示
- attach、detach、delete後の一覧更新
- reload、Desktop再起動後に最後のWorkspace targetを再認可して復元
- Server接続追加・変更と、rendererへ秘密情報を渡さないこと
- Server間移転のpreflight、進行再開、cutover後のswitcher更新
- keyboard操作、focus、button label、error表示
- preloadとrendererの境界

#### 自己レビュー

- Organizationが暗黙の選択状態や必須contextとして残っていないか。
- Serverが最上位の選択画面として残っていないか。
- active connection切替とWorkspace選択が分離し、中間状態で別Serverへrequestしていないか。
- Workspace ID単独のcache key、local preference、realtime filterが残っていないか。
- 一つのServerの失敗で全Workspaceをoffline扱いにしていないか。
- 移転中のWorkspaceを通常の切替操作で二重に開ける状態にしていないか。
- UIだけで認可可否を決めていないか。
- StandaloneとAttachedでChatの挙動が変わっていないか。
- Electron startup raceやprocess cleanupを悪化させていないか。

#### 完了条件

- Organizationなしで、複数ServerのWorkspaceを同じswitcherから操作できる。
- Workspace Aから別Server上のWorkspace Bを選ぶだけで、Server選択画面を挟まず安全に表示が切り替わる。
- Server間移転後も同じWorkspace項目から移転先へ接続される。
- Organizationを追加・解除しても同じWorkspaceとRoomを利用し続けられる。

#### 次のGate

実PostgreSQLと実Agentを接続した技術E2Eへ進めること。

---

### Phase 6: 実環境の技術E2Eと証拠保存

#### 目的

mockや静的検査ではなく、実PostgreSQL、実Native App、実Agent、実ファイルで完成体験を確認する。

#### 検証順

1. focused testと型検査
2. schema、Migration、生成bindingの静的検査
3. 実PostgreSQL MigrationとRLS allow/deny
4. ServerとWeb shellの起動
5. Electron Native App起動
6. Standalone Workspaceの完成体験
7. Server間Workspace移転
8. Optional Organizationの追加・解除体験
9. 再起動とデータ保持
10. failure injectionとrollback・中断再開
11. 全体回帰検査

#### 使用する既存command候補

実装時にpackage.jsonの現行scriptを再確認し、存在するものだけを使用する。

~~~bash
pnpm test
pnpm typecheck
pnpm verify:postgres-migration:static
pnpm verify:postgres-runtime-scope
pnpm verify:local-light
pnpm verify:ci-full
pnpm desktop:build
pnpm desktop:verify
pnpm desktop:audit
pnpm desktop:dev
~~~

#### 実PostgreSQL確認

- 新規DBへの適用
- 旧必須Organization DBからの完全Migration
- Hosted相当とSelf-host相当の接続
- Workspace member allow
- 非member deny
- Organization memberだけのdeny
- Organization Admin管理操作と内容閲覧の分離
- attach、detach、deleteのtransaction
- Bundle export、restore、衝突、rollback
- 失敗後のDBとstorage残骸ゼロ

#### 実機E2E A: Standalone Workspace

1. Native Appを起動する。
2. Server A上のWorkspace AとServer B上のWorkspace Bを登録する。
3. 二つが同じWorkspace switcherに並び、Server選択画面が主導線にないことを確認する。
4. Workspace Aを選び、対応するServer Aへ裏で接続されることを確認する。
5. OrganizationなしでWorkspace memberを直接招待する。
6. Roomを作成または選択する。
7. 実Agentへ依頼する。
8. 実行結果とEvidenceを保存する。
9. Workspace Bを選ぶだけでServer Bへ切り替わり、Workspace BのRoomと内容だけが表示されることを確認する。
10. Workspace Aへ戻り、先ほどのRoom、Evidence、実ファイル、学習結果を確認する。
11. Appと両Serverを再起動する。
12. 最後のWorkspace候補が対象Serverで再認可された後に復元されることを確認する。
13. 次のAgent実行で学習結果が再利用されることを確認する。
14. 人間が修正し、次回結果へ反映されることを確認する。
15. Server Aを停止しても、Server BのWorkspaceを選択・利用できることを確認する。

#### 実機E2E B: Optional Organization

1. Organizationを明示作成する。
2. 既存Standalone Workspaceを追加する。
3. Workspace memberがOrganization memberへ補完されることを確認する。
4. Workspace Roleと内容閲覧権が変わらないことを確認する。
5. Organization memberだけの利用者が内容を読めないことを確認する。
6. Workspaceを解除し、単体利用を続ける。
7. 再度追加する。
8. Organizationを削除する。
9. Workspaceと全内部データが残ることを確認する。
10. 再起動後もStandalone Workspaceとして利用できることを確認する。

#### 実機E2E C: Server間Workspace移転

1. Server A上のStandalone WorkspaceへRoom、Chat、Evidence、Knowledge、Skill、Agent設定、実ファイルを作成する。
2. Workspace管理からServer Bを移転先に選び、preflightを実行する。
3. 移転中にNative Appを終了する条件と、Server BのRestoreを意図的に失敗させる条件をそれぞれ確認する。
4. 同じtransfer IDで再開し、重複Workspaceやfile残骸が発生しないことを確認する。
5. Restore成功後、DB record件数、参照、manifest、file hashをServer AとServer Bで照合する。
6. cutoverし、Workspace switcherの同じWorkspace項目がServer Bへ接続されることを確認する。
7. Room、Chat、Evidence、Knowledge、Skill、Agent設定、実ファイルをServer Bで利用する。
8. Server A側が自動削除されず、archiveで保持されていることを確認する。
9. Appと両Serverを再起動し、移転先Workspaceが再認可されることを確認する。
10. 移転元削除は別の明示確認操作でだけ実行できることを確認する。

#### 報告

実際の検証条件、command、成功、失敗、未検証範囲を、新しい作業報告としてreports/へ保存する。旧Phase 2報告は当時の証拠として保持し、上書きで歴史を消さない。

#### 自己レビュー

- build成功を実起動成功として報告していないか。
- PostgreSQL testが実DBを使ったか、skipされていないか。
- Electron、Agent、ファイル、再起動の証拠が揃っているか。
- Workspace切替時に接続先Serverも変わったことをrequest先と画面内容の両方で確認したか。
- 同じworkspace_id、offline Server、revoke済みMembershipの境界を確認したか。
- Hosted相当とSelf-host相当を混同していないか。
- failure時の最初のDB errorとcleanup結果を記録したか。

#### 完了条件

- Standalone Workspaceの完成体験が実機で通る。
- 複数Server上のWorkspaceをServer選択なしで切り替えられる。
- Optional Organizationを追加・解除しても完成体験が壊れない。
- 実際の二つのServer間でWorkspace移転と中断再開が成立する。
- 未検証事項が成功扱いされず、明記されている。

#### 次のGate

ドパガキくんによる最終dogfoodingへ渡せること。

---

### Phase 7: Dogfooding、修正、再実行、PR前停止

#### 目的

実際の使い込みで発見した問題を修正し、同じ完成体験をもう一度通してからUI仕上げとPR判断へ進む。

#### 役割分担

| 担当 | 内容 |
|---|---|
| Codex | 実装、focused test、型検査、実PostgreSQL、技術E2E、失敗修正、報告 |
| ドパガキくん | Native Appを実際に操作し、製品体験、分かりにくさ、修正可能性を確認 |
| 共同 | dogfoodingで見つかった問題の優先順位と今回修正範囲を判断 |

#### 作業

1. ドパガキくんへ起動方法、前提、E2Eチェック項目を簡潔に渡す。
2. Standalone Workspaceを主経路としてdogfoodingする。
3. Workspaceを別Serverへ移転し、移転後のWorkspaceを通常どおり使う。
4. Optional Organizationの追加、解除、削除をdogfoodingする。
5. 学習結果が次回利用されたか、間違いを人間が修正できるか確認する。
6. 今回の境界内の問題を修正する。
7. 影響範囲のfocused testを再実行する。
8. Standalone、Server間移転、Optional Organizationの実機E2Eを再実行する。
9. よく使う画面と操作だけを必要最小限磨く。
10. 変更、検証、未検証事項を報告する。
11. commit、push、PRの前で停止し、ドパガキくんの明示承認を待つ。

#### 完了条件

- 一度使っただけでなく、修正後に同じ体験を再度通している。
- よく使う操作が判明し、UI仕上げ対象が証拠に基づいている。
- PRへ進めるか利用者が判断できる報告がある。
- 明示承認前にpushやPRを行っていない。

---

## 10. Phase Gate一覧

| Gate | 進行条件 | 停止条件 |
|---|---|---|
| G0 調査完了 | 必須Organization依存が分類済み | 対象不明の依存が残る |
| G1 DB完了 | Standalone Workspace schemaと完全Migrationが成立 | データ欠損、残骸、rollback不成立 |
| G2 API完了 | Organizationなしで全基本操作が成立 | transport間の認可差、orgId必須残存 |
| G3 Org完了 | attach、detach、deleteがWorkspace非破壊 | cascade、権限昇格、競合不整合 |
| G4 移転完了 | 二つの実Server間でBundle、検証、cutover、中断再開が成立 | 欠損、hash不一致、残骸、自動source削除 |
| G5 UI完了 | 全Server横断Workspace-firstで操作可能 | Server-first、zero-org blocker、Chat回帰 |
| G6 技術E2E完了 | 実DB、実Agent、実ファイル、移転、再起動を確認 | skip、mockのみ、未cleanup |
| G7 Dogfood完了 | 修正後の再実行が成功 | 主要体験の未解決問題 |
| G8 PR判断 | 報告後に利用者が承認 | 承認なし |

---

## 11. 検証戦略

### 11.1 Phase中のfocused検証

- 変更したpackageのtest、typecheck、lintを優先する。
- schema変更時はMigrationとRLSの関連testを同じPhaseで実行する。
- UI変更時はcomponent testとDesktop bridge testを実行する。
- transaction変更時は成功、拒否、競合、rollbackを確認する。
- Server間移転変更時は、二つの実Serverを使う前にBundle unit、hash、冪等性、failure cleanupをfocused検証する。

### 11.2 最終回帰検証

- repository全体のtest、typecheck、build
- 生成bindingとAPI contract
- PostgreSQL migration static/runtime
- Desktop build、verify、audit
- 実PostgreSQL allow/deny
- 実Electron起動と終了
- 実Agent streamingとEvidence
- 異なる二つのServerとStorage rootを使ったExport/Restore、cutover、中断再開、再起動保持

### 11.3 検証結果の分類

| 分類 | 意味 |
|---|---|
| planned | 計画しただけで未実行 |
| static_verified | 静的検査、型、buildまで確認 |
| focused_verified | 対象testを実行して確認 |
| postgres_verified | 実PostgreSQLで確認 |
| native_e2e_verified | 実Native Appと実Agentで確認 |
| dogfood_verified | ドパガキくんが実操作で確認 |
| unverified | 未確認、skip、環境不足 |

低い証拠を高い証拠として報告しない。

---

## 12. 主なリスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| UIだけWorkspace-firstになる | DB/APIでOrganization必須が残る | schemaから順に移行し、orgId横断検索をGate化 |
| Organization削除でWorkspaceも消える | 重大なデータ損失 | FK、cascade、transaction、実DB failure test |
| Org memberが内容を読める | 権限漏洩 | Workspace MembershipだけでRLS allow/deny |
| attach時にroleが変わる | 意図しない権限昇格・降格 | 補完とrole変更を別処理にし不変test |
| Workspace APIが二重化する | 将来の仕様ずれ | 単一Application ServiceとFacadeを共有 |
| Server-firstの画面が残る | Workspaceが基本単位に見えない | 全Server横断switcherを主導線にし、Server管理を設定へ置く |
| 切替時に旧Serverへrequestする | 誤表示、誤更新、情報漏洩 | connectionとworkspaceを一体で切り替え、切替中は操作を停止 |
| 異なるServerでWorkspace IDが衝突する | 別WorkspaceのcacheやRoomを表示 | connection_idとworkspace_idの複合targetを全Client状態で使用 |
| 一つのServer障害が全体へ波及する | 利用可能なWorkspaceも開けない | Server単位で接続状態とerrorを分離 |
| 移転先検証前に移転元を消す | Workspace全体のデータ損失 | cutover完了までsource保持、削除は別の明示操作 |
| Server間移転が途中で止まる | sourceとtargetの二重状態、残骸 | transfer ID、冪等operation、状態記録、cleanup、再開 |
| DBと実ファイルの片方だけ移る | EvidenceやKnowledgeが開けない | manifest、件数、参照整合性、file hashをcutover前に照合 |
| cutover後も旧Serverへ書き込む | 二つのWorkspaceが分岐 | sourceをarchiveし、target connectionを一体更新 |
| 完全Migrationで既存Workspaceを失う | 開発データと証拠の破壊 | 保持対象表、transaction、件数照合、rollback |
| 旧testが旧仕様を正当化する | 誤った成功判定 | 要件単位で更新し、新しいdeny testを追加 |
| Electron起動競合が再発する | 実機確認不能 | API health、Web shell、Desktopの順序とcleanup確認 |
| UI磨きが先行する | 本質的な不具合が隠れる | dogfooding修正後に頻出操作だけ仕上げる |
| 旧計画が再配置され新計画と併存する | 実装方針が分裂する | 実装基準は新計画だけとし、過去内容はGit履歴で参照 |

---

## 13. OSS参照方針

### Buzzから参考にする範囲

- Communityを利用者向けの切替単位とし、Relay URLを裏側の接続先として扱う導線
- 複数Communityを同じアプリへ登録し、Community選択でRelay接続を切り替える境界
- Server内tenant解決
- transactionとlock順
- idempotencyと再実行
- Membership更新の一貫性
- migrationと失敗時cleanup

SamuraiではBuzzのCommunity switcherをWorkspace switcherとして参考にする。一方、Buzzの名称、Compute提供、Community MembershipとSamuraiのOrganization権限をそのまま移植しない。Samuraiでは外部Agentを使うため、OrganizationにCompute所有責務を持たせない。

### Slackから参考にする範囲

- 通常のWorkspaceが単体で成立する考え方
- 大規模利用時だけ上位管理層を追加する考え方
- Workspace参加と上位組織所属を分ける考え方
- 上位管理者の管理権限とコンテンツ閲覧権を分離する判断材料

Slack Enterpriseの契約、role名、招待方法、監査機能をそのままSamuraiの要件にしない。

参照OSSや外部サービスは、実装前に現行versionの該当箇所を再確認し、参照時点と採用理由を実装報告へ残す。

---

## 14. 完成条件

次をすべて満たしたとき、本計画の実装を完了とする。

- Organizationを1件も作らず、Workspace、Room、Chat、Agent、Evidence、Knowledge、Skillを利用できる。
- 複数Server上のWorkspaceが一つのWorkspace switcherへ並び、Workspace選択だけで対応するServerへ安全に切り替わる。
- Serverは配置先・接続状態として確認できるが、通常ナビゲーションの最上位には表示されない。
- 同じworkspace_idの衝突、Server障害、Membership revokeで別Workspaceの内容を誤表示しない。
- WorkspaceをHosted／Self-hostを含む別Serverへ移転できる。
- Server間移転ではDB、Room、Chat、Evidence、Knowledge、Skill、Agent設定、実ファイルを検証してからcutoverする。
- 移転中断後に同じtransfer IDで再開でき、重複や残骸を残さない。
- 移転元Workspaceはarchiveされ、明示削除まで安全に保持される。
- Workspace direct inviteとMembership管理がOrganizationなしで動く。
- Organizationを任意作成し、Workspaceを安全に追加・解除できる。
- Organization MembershipだけではWorkspace内容を読めない。
- Organization削除後もWorkspaceと全内部データが残る。
- 旧Organization必須schema、API、UI、fixtureの残骸がない。
- 実PostgreSQLでMigration、RLS、rollback、再実行を確認している。
- 実Electron、実Agent、実ファイル、学習再利用、再起動保持を確認している。
- dogfoodingで発見した問題を修正し、同じ体験を再実行している。
- 未検証範囲が明記されている。
- ドパガキくんの確認前にpush、PRを行っていない。

---

# 非エンジニア向け簡略版

## 何を直すのか

現在の実装は、Workspaceを使う前にOrganizationが必ず必要な構造になっている。これを次の形へ直す。

~~~text
普段の利用
Workspace A → Room → Agent
Workspace B → Room → Agent

裏側
Workspace AはServer Aへ接続
Workspace BはServer Bへ接続

必要な人だけ追加
Organization → 複数Workspaceの管理
~~~

個人や小規模チームはOrganizationを作らず使える。Native Appには、BuzzのCommunity switcherと同じように複数Server上のWorkspaceが一つの一覧へ並ぶ。利用者はServerを先に選ばず、Workspaceを選ぶ。Native Appが裏で正しいServerへ接続する。100人、1,000人規模で複数Workspaceをまとめたい場合だけOrganizationを追加する。

## 何を残すのか

- すでに作ったReact/ElectronのNative App基盤
- 実Agentと会話するChat
- Evidence、ファイル、学習結果の保存
- PostgreSQLとWorkspace Server
- 複数Server接続を保存・選択する既存基盤
- 複数Workspaceを動かす仕組み

全部作り直すのではなく、Organization必須になっている部分だけを責務ごとに直す。

## どんな順番で進めるのか

1. Organization必須になっている場所を全部洗い出す。
2. DBをWorkspace単体で保存できる形へ直す。
3. APIと権限をWorkspace中心へ直す。
4. Organizationを任意の追加機能として作り直す。
5. Workspaceを別Serverへ安全に移転する仕組みを作る。
6. Native Appへ全Server横断のWorkspace switcherを作り、Workspace選択時に接続先も自動で切り替える。
7. 実PostgreSQL、実Agent、実ファイルでE2E確認する。
8. ドパガキくんが実際に使う。
9. 問題を修正し、同じ流れをもう一度試す。
10. よく使うUIだけ磨く。
11. PR前で止まり、ドパガキくんの確認を待つ。

## Organizationを削除するとどうなるか

Organizationだけが消え、Workspaceは消えない。Workspaceは独立状態へ戻り、Room、Chat、Agentの結果、Evidence、Knowledge、Skill、Membershipをそのまま使い続けられる。

## Serverはどこに見えるのか

ServerはWorkspaceの置き場所として、接続設定や障害表示でだけ確認する。普段はWorkspace A、Workspace Bを直接切り替える。Server Aを選んでからWorkspace Aを探す操作にはしない。

## Workspaceを別Serverへ移すとき

Workspace管理の「移転」でだけ移転先Serverを選ぶ。Server Aからデータと実ファイルをExportし、Server BへRestoreして内容を照合してから、Native Appの接続先をServer Bへ切り替える。Server A側はarchiveし、元Workspaceの削除は別の確認操作にする。

## E2Eは誰がやるのか

- Codexが技術E2Eを担当する。実PostgreSQL、実Agent、実ファイル、二つのServer間移転、再起動、権限拒否、失敗時rollbackと中断再開まで確認する。
- ドパガキくんは最終的な製品体験を担当する。実際に操作し、分かりやすさ、学習の再利用、間違いの修正を確認する。
- 問題があれば修正して再度使う。最初の1回だけで完成とはしない。

## 今回やらないこと

課金、Compute提供、複数Server横断Organization、SSO、SCIM、メール送信、高度な企業監査、全画面のデザイン完成は後回しにする。

## 最終判断

技術E2Eとdogfoodingが終わったら、変更内容、成功した検証、失敗、未確認事項、起動方法をまとめる。その時点でPR前に停止し、ドパガキくんが次へ進めるか判断する。
