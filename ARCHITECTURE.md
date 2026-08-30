# Samurai Agent Architecture

## 0. この文書の役割

この文書は、Samurai Agentの構造、責務境界、データ所有、接続、検証不変条件を定義する**技術正本**である。

製品の目的、概念、公開用語は`PRODUCT.md`を正本とする。UI資料、計画、進捗台帳、完了レポートは補助資料であり、この文書の完成形と現在の実装状況を混ぜない。

---

## 1. 技術不変条件

1. WorkspaceがKnowledgeと作業証拠の正本である。
2. RoomがKnowledgeと認可の境界である。
3. SessionのUI状態と、Coreが実行・証拠・復旧に使うSession記録を分ける。
4. Native App、Workspace Core、Runtimeは一つの製品を構成し、外部アプリも同じCoreを使う。
5. Gateway、MCP、AdapterはQuery、Domain Operation、Activity Ingest、Run Controlを迂回しない。
6. BackendはWorkspace Storeへ直接アクセスしない。
7. ActivityとEpisodeは証拠、Knowledge、Knowledge Wiki、Skillは再利用物として分ける。
8. Memoryを独立したWorkspace Resourceにせず、経験はEpisode、再利用知識はKnowledgeとして表現する。
9. 自動学習は同じRoomの根拠付き処理に限定する。
10. 本文ファイルとDatabaseを二重正本にしない。
11. Surface、Client UI状態、Runtime CacheをWorkspace Knowledgeの正本にしない。
12. 未認証、権限失効、古いVersion、不完全な証拠は安全側で拒否する。
13. Source、契約テスト、実環境確認、完成判定を別々に扱う。

---

## 2. システム全体

~~~mermaid
flowchart TB
  subgraph Product["Samurai Product"]
    Native["Native App"]
    ClientAPI["Client API / Desktop IPC"]
    Core["Workspace Core"]
    Runtime["Runtime"]
    KnowledgeHost["Knowledge Host"]
  end

  subgraph ExternalApps["External Apps"]
    External["Codex / Claude Code / Cursor / CLI"]
    OAuth["OAuth / Pairing / Credential Adapter"]
    MCP["MCP / API / Plugin / Hook"]
    Gateway["Gateway"]
  end

  subgraph Ingress["Formal Ingress"]
    Query["Query"]
    Operation["Domain Operation"]
    Activity["Activity Ingest"]
    RunControl["Run Control"]
  end

  subgraph Workspace["Workspace Authority"]
    Auth["Principal / Room Authorization"]
    Store["Workspace Store"]
    History["Activity / Evidence / Audit"]
    Jobs["Workspace Job"]
  end

  subgraph Execution["Execution Boundary"]
    Port["Agent Backend Port"]
    Backends["Codex / Claude Code / Native Backend"]
  end

  Native --> ClientAPI
  ClientAPI --> Query
  ClientAPI --> Operation
  ClientAPI --> Activity
  ClientAPI --> RunControl
  External --> MCP
  MCP --> OAuth
  OAuth --> Gateway
  Gateway --> Query
  Gateway --> Operation
  Gateway --> Activity
  Gateway --> RunControl
  Query --> Auth
  Operation --> Auth
  Activity --> Auth
  RunControl --> Auth
  Auth --> Store
  Auth --> History
  Auth --> Core
  Core --> Runtime
  Runtime --> Port
  Port --> Backends
  History --> KnowledgeHost
  Store --> KnowledgeHost
  KnowledgeHost --> Jobs
  Jobs --> Store
  KnowledgeHost --> Store
~~~

この図は処理の流れを表す。Native App、Workspace Core、Runtimeは内部的に分離するが、Samuraiという一つの製品を構成する。外部アプリはTransport AdapterとGatewayを経由し、Native Appと同じWorkspace Authorityへ到達する。package/import依存は12章で別に定義する。

---

## 3. レイヤーの責務

| レイヤー | 持つ責務 | 持たない責務 |
| --- | --- | --- |
| Native App | Samuraiの公式製品面、Knowledge管理、教え込み、Chat、Session表示、Surface | Workspace正本、認可、実行状態の独占 |
| Client API / Desktop IPC | Native App入力の変換、認証済みCore接続 | Workspaceへの直接書込み |
| External App Adapter | 外部入力・結果の変換 | Room権限の決定 |
| OAuth / Pairing | Connectionの本人性とCredential参照 | Workspace権限の付与 |
| Gateway | 接続、再送、配信、Formal Ingressへの振り分け | Workspaceへの直接書込み |
| Query | 認可済みの読取り | 副作用、学習起動 |
| Domain Operation | 明示的な保存・変更・権限操作 | AI長時間処理 |
| Activity Ingest | 外部実行証拠の正規化と保存 | 通常Knowledgeの即時確定 |
| Run Control | 実行開始、Cancel、Resume、Syncなど内部実行制御の受付 | チームAgentの製品体験の定義 |
| Workspace Core | 正本、認可、Session記録、履歴、検索、成果物 | UI表示状態、入力途中の内容 |
| Runtime | 実行受付、Context構築、Backend接続、Event、取消、再開、復旧 | Knowledgeの正本、チームAgentのUI仕様 |
| Knowledge Host | ActivityとEpisodeの整理、学習、Knowledge更新調整 | チームの一員としての実作業、Runtime全体の代替 |
| Workspace Job | AI処理、学習、Curator、長時間処理 | 単純なCRUD、通常Query |
| Backend Port | 交換可能な実行契約 | Knowledgeの正本 |
| Surface | Coreデータの表示・操作 | 永続Resourceの所有 |

「Agent」はチームの一員としてWorkspaceに参加する製品概念を指す。`AgentRuntime`や`AgentHost`は現行コード上の内部名であり、チームAgentそのものやKnowledge Hostを意味しない。チームAgentの表示、操作、自律性、実行範囲はNative App設計まで固定しない。

---

## 4. データ所有

### 4.1 WorkspaceとRoom

WorkspaceはRoom、Principal、Knowledge、Skill、Policy、PROFILE／SOUL、Activity、Episode、Artifact、Collectionを所有する。

Roomは同じ種類のままWorkspace直下または別Roomの下へ置ける。親子関係は整理と参加可能範囲の制約だけを表し、Knowledge、検索、AI Context、権限を継承しない。

Room操作は次を原子的に検証する。

- 同じWorkspaceの親であること
- 循環がないこと
- 子Roomの直接メンバーが全親Roomへ直接参加していること
- 最後のOwnerを失わないこと
- 期待VersionとOperation IDが一致すること

### 4.2 PrincipalとConnection

Principalは操作主体を表す。

- Human
- Agent
- External App
- System / Maintenance

Accountは、人間が複数のHosted・Self-host Serverで再利用できる安定した本人識別子である。Accountは権限そのものではなく、WorkspaceとRoomのRoleは各Workspaceで別に評価する。private keyをWorkspaceやBundleへ保存しない。

Connectionは接続元、委任元、許可Room上限、入口上限、失効状態を持つ。Connectionが存在するだけではRoom membershipを得ない。認可は毎回、現在のWorkspace membership、Room membership、Agent permissionとの積集合で評価する。

Maintenance identityは一つのDeploymentとWorkspaceにだけ結び、通常Client利用やBundle移送を許可しない。

### 4.3 SessionとSessionRef

Sessionは、会話、作業、Runtime実行、Activityを関連付けるCore側の記録を持つ。ただし、SessionをKnowledge、Room、Artifactなどの所有者にはしない。

Workspace Coreが持つもの。

- session identityとRoomとの関係
- 実行、Backend Run、Activity、Evidenceとの関係
- Cancel、Resume、Sync、Recoveryに必要な状態
- 検索、履歴、監査に必要なmetadata

Clientが持つもの。

- 入力途中の内容
- Navigation、選択、split比率などのUI状態
- Client固有の表示Cache
- Workspaceへ保存すると決めていない会話本文

SessionRefは外部Sessionへの任意参照であり、app_id、session_id、turn_id、message_id、resume_urlまたは外部参照キーを持てる。SessionRefを削除しても、Activity、Knowledge、Artifact、権限の正本が壊れないことを必須とする。

### 4.4 Activity、Episode、Knowledge、Knowledge Wiki

Activityは最低限、次を持つ。

- workspace_id、room_id
- actor、source app、connector、Backend
- instruction summary、final result summary
- changed resources
- verification outcome
- failure、correction、provenance
- 任意のSessionRef

Episodeは関連するActivityをまとめる。Memoryを別Resourceとして追加せず、従来Memoryと呼んでいた内容は、経験のまとまりをEpisode、再利用する知識をKnowledgeとして表現する。Activityはその根拠、Skillは再利用手順として分ける。

Knowledgeは`fact`、`decision`、`explanation`、`experience_rule`に分ける。Knowledge WikiはKnowledgeをMarkdownページとして扱う主要方式であり、次を持つ。

- 人間が読める本文とFrontmatter
- Room scope
- Link、backlink、検索、再index
- Version、Evidence、provenance、状態
- 提案、採用、却下、修正、Archive、復元

Knowledge WikiはKnowledgeと競合する別の所有領域ではなく、同じRoom境界と認可を使う。検索IndexとDatabase metadataは再構築可能な管理情報であり、本文の二重正本にしない。

呼出元の`verification_outcome`は自己申告として残せるが、機械検証の根拠にはしない。対象Versionと本文hashが一致する追記専用Attestationだけを`machine_verified`として扱う。

### 4.5 Skill、Policy、PROFILE／SOUL

- Skillは`SKILL.md`と補助ファイルを一つのVersionとして扱う。Copy、Move、Restoreはpackage全体のpath、size、hashを検証する。
- Policyは、Serverが認証済みHuman requestから作ったCaller Contextでだけ有効化する。任意header、connection ID、署名文字列、AI、Maintenanceは有効化できない。
- PROFILE／SOULは人間の明示操作でだけ更新する。学習、Curator、Migrationは更新しない。

### 4.6 Artifact、Collection、Surface

- ArtifactはRevisionと出所を持つ成果物である。
- CollectionはSchemaとRecordを持つ構造化データである。
- SurfaceはArtifact、Collection、Knowledge、Activityを表示・操作する再生成可能な投影である。

SurfaceのDOM、開閉、表示順、split比率をWorkspace正本へ保存しない。

### 4.7 Runtime Cache

RuntimeやBackend固有の短期Context、生成Context、Cacheは派生データである。

- 参照元のRoomとKnowledge Versionを記録する
- 権限失効後は再利用しない
- Export対象のKnowledge正本にしない
- CacheからWorkspace KnowledgeやKnowledge Wikiを無条件に更新しない

---

## 5. Formal Ingress

### 5.1 Query

Queryは認可済みResourceを読む。副作用を持たず、Session、Activity、Job、Knowledge Changeを自動作成しない。

通常のKnowledge検索はRoom IDを必須にし、親、子、兄弟Roomへ自動拡張しない。Workspace全体検索は別の明示操作として扱う。

### 5.2 Domain Operation

Domain Operationは、人間やClientが明確に指定した変更を扱う。

例。

- Knowledge、Artifact、Collectionの保存・修正
- Room、Member、Permissionの変更
- Knowledgeの共有、Copy、Move、固定
- Backup、Export、Restore
- 明示的な教え込み

入力検証、認可、冪等性、永続化、Auditを一つの契約として扱う。

### 5.3 Activity Ingest

Activity Ingestは次の順で処理する。

1. ConnectionとPrincipalを確認する
2. WorkspaceとRoomを解決する
3. Client固有Eventを共通形式へ正規化する
4. Activity、Evidence、Resource参照を作る
5. 一つの永続化境界で保存する
6. 条件を満たす場合だけKnowledge HostのReview Jobを起動する

不完全なCaptureは成功扱いせず、再試行可能な状態と不足Evidenceを記録する。

### 5.4 Run Control

Run Controlは、Native Appまたは許可された外部接続から、Runtimeの実行制御を受け付ける内部契約である。

- start：認可済みContextで処理を開始する
- cancel：実行中または入力待ちの処理へ取消を要求する
- resume：入力待ちの処理へ追加入力を渡す
- sync：Backend側の最新状態を照合する
- recover：再起動後に未確定の実行を復旧する

これはチームAgentの製品仕様を固定する入口ではない。Chat、Workspace Job、将来のチームAgentなど、複数の製品面が共通Runtimeを安全に使うための内部境界である。受付時、外部作用前、保存前に認可と期待Versionを再確認する。

---

## 6. Runtime、Knowledge Host、Backend

~~~mermaid
sequenceDiagram
  participant App as Native / External App
  participant E as Client API / Gateway
  participant I as Formal Ingress
  participant W as Workspace Core
  participant R as Runtime
  participant B as Backend Port
  participant H as Knowledge Host

  App->>E: Query / Operation / Activity / Run Control
  E->>I: 認証済みCaller Context
  I->>W: Room認可と保存・読取り
  I->>R: 認可済み実行要求
  R->>W: Session・Context・実行状態
  R->>B: 共通Backend入力
  B-->>R: Backend Event・結果
  R->>W: BackendRun・Activity・Change
  W-->>H: Activity・Episode・Evidence
  H->>W: provisional Knowledge / Wiki / Skill
  W-->>App: 結果・参照・再利用可能Context
~~~

RuntimeとKnowledge Hostは別責務である。

- Runtimeは、処理の受付、Context構築、Backend実行、Event、Sessionとの関連、Cancel、Resume、Sync、Recoveryを扱う。
- Knowledge Hostは、確定したActivityとEpisodeを整理し、Knowledge、Knowledge Wiki、Skillの学習ループを動かす。
- チームAgentはWorkspaceに参加する製品概念であり、どちらのHostとも同一ではない。

現行コードの`AgentRuntime`はRuntime facade、`AgentHost`は実行制御を組み立てる内部Hostである。名称に`Agent`を含むが、チームAgentの製品仕様を表さない。将来改名する場合も、責務と移行対応を先に定義する。

Backend Portは次を共通契約として扱う。

- 実行要求と認可済みContext
- Event stream
- 成功、失敗、中断、要確認の終端
- Artifact、変更、Tool結果の参照
- 任意のBackend Session情報

BackendがWorkspace Store、Database、本文ファイルを直接操作することを禁止する。

### 6.1 Run lifecycle

Runtimeの実行状態は最低限、次を共通契約とする。

~~~text
queued → running → waiting_for_backend_input → running
   └──────────────→ completed / failed / cancelled / outcome_unknown
~~~

- `cancelled`はBackend側の停止を確認できた場合にだけ使う。
- 停止、完了、外部作用の有無を確認できない場合は`outcome_unknown`とし、成功扱いも自動Retryもしない。
- Retryは新しいAttemptとして記録し、同じ外部作用を二重実行しない。
- 再起動時はEventとBackend状態を照合し、根拠なしに`running`や`completed`へ戻さない。
- Sessionがなくても実行できるWorkspace Jobを認めるが、Room、Principal、Activity、Auditとの関係を失わない。

---

## 7. Knowledge学習ループ

### 7.1 Review

重要Activityと、それをまとめたEpisodeは、同じRoomのReview Jobへ渡せる。Review Jobは記録済みhigh watermarkまでの対象をsnapshot digestへ含める。入力上限を超えた場合は一部だけを処理せず`blocked`にする。

Review結果はEvidence、Confidence、Job、Attempt、Version付き`provisional`なKnowledge、Knowledge Wiki変更、Skillとして保存する。

### 7.2 UseとEvaluation

Knowledge、Knowledge Wiki、SkillをRuntimeや外部アプリへ渡す時は、利用したResource IDとVersionを記録する。結果が戻ったら、成功、失敗、訂正、機械検証、再利用結果をEvaluationとして接続する。

複数Knowledgeを同時利用した場合、結果との相関だけで個別Knowledgeの因果効果を確定しない。

### 7.3 更新、昇格、Conflict

- 非`fixed`Resourceは、同じRoomの新しい根拠に基づきVersion更新できる。
- 人間が編集したことだけでは自動更新禁止にしない。
- `fixed`はAI、Review、Curatorから更新しない。
- 矛盾は既存Versionを削除せずConflictとして残す。
- Workspace全体への昇格、Room間共有、削除・統合、権限変更、機密情報の採用は明示操作にする。

Curatorは期待Versionとhashを持ち、権限、Policy、stale確認、保存を同じTransactionで処理する。古い計画を部分適用しない。

### 7.4 再試行

JobはAttempt、使用設定Version、失敗理由、次回実行条件を記録する。未解決失敗、権限失効、入力不足を通常成功やKnowledge昇格へ変換しない。

---

## 8. 認可の評価順

すべてのRead、Write、Executeで次を確認する。

1. 接続元が認証されている
2. ConnectionとPrincipalが有効である
3. Workspace membershipがある
4. Room membershipまたはAgent permissionがある
5. ConnectionのRoom上限と入口上限に含まれる
6. Resource actionが許可されている
7. 期待Version、冪等Key、委任元が一致する
8. ActivityとAuditへ出所を記録できる

System、Maintenance、Native Appも認可を迂回しない。

Realtimeは通知直前にRoomの直接読取権限を再確認する。非公開の子Room名、件数、更新通知を親Room参加者へ漏らさない。権限失効時は購読を外す。

---

## 9. 永続化

### 9.1 本文ファイルとDatabase

Knowledge、Knowledge Wiki、Skill、Policy、PROFILE／SOULの本文は、人間が読めるファイルを正本とする。Databaseは次を管理する。

- Resource identity
- Workspace、Room、権限
- Version、hash、Evidence
- Activity、Episode、Use、Evaluation
- Job、Attempt、Audit
- 検索投影

本文更新は、ファイルとDatabase metadataを復旧可能なFile Transactionで結ぶ。途中失敗で片方だけを成功させない。

### 9.2 運用モード

一つのWorkspaceをSQLiteとPostgreSQLの同時書込みで運用しない。

- 共有、Hosted、Self-host ServerはPostgreSQLと本文ファイルを使う。
- 旧local SQLite Workspaceは互換読取りと移行元として扱う。
- 移行は移行元をread-onlyにし、snapshot、件数、hashを確認してから移行先を有効化する。
- 失敗時は移行先を破棄し、移行元を復帰できるようにする。

### 9.3 Bundle

Workspace BundleはDatabase imageではなく、Portable Recordと人間が読める本文ファイルで構成する。

含めるもの。

- Room、親Room、Principal、Permission
- Knowledge、Knowledge Wiki、Skill、Policy、PROFILE／SOUL
- Activity、Episode、Evidence、Version
- Artifact、Collection
- 必要なJob、Attempt、Audit、file hash

含めないもの。

- private key、password、token、credential
- raw model output
- maintenance identityと権限
- Session全文とUI状態

RestoreはRoom循環、親Room欠落、Member制約、Secret混入、file hash不一致を有効化前に拒否する。

---

## 10. 外部接続

### 10.1 双方向契約

外部接続は次の両方向を閉じる。

~~~text
Workspace → Context / Knowledge / Skill → External Agent
External Agent → Result / Change / Failure / Verification → Activity Ingest
~~~

取得だけ、またはActivity保存だけで完成扱いしない。利用したKnowledge Versionと返却結果を関連付け、次回の再利用まで確認する。

### 10.2 MCP、API、Plugin、Hook

Transport固有処理はAdapter内へ閉じる。すべてのTransportは同じFormal Ingressへ変換する。

- Queryは読取りだけ
- 明示変更はDomain Operation
- 実行結果はActivity Ingest
- Backend実行要求はRun Control、Runtime、Backend Port

MCPやAdapterがWorkspace Store、SQLite、PostgreSQL、本文ファイルを直接参照しない。

### 10.3 Credential

WorkspaceにはCredential本体を保存しない。ConnectionはOSやDeploymentの安全な保存先への参照、Credential種別、失効状態だけを持つ。

OAuthはstate、PKCE、redirect target、Account、Workspace、Connectionを結び、再利用や別Workspaceへの差替えを拒否する。

### 10.4 冪等性と再送

同じ冪等Keyと同じ入力hashは既存結果を返す。同じKeyで異なる入力hashはConflictとして拒否する。Timeoutや応答喪失時に同じ変更を二重適用しない。

---

## 11. Native App境界

Native AppはSamuraiの公式製品面として次を所有する。

- Chatの表示と入力状態
- UIの開閉、Navigation、split比率
- Surfaceの表示状態
- App Session Backup

Workspaceは次を所有する。

- Knowledge、Skill、Policy、PROFILE／SOUL
- Activity、Episode、Evidence、Audit
- Artifact、Collection
- Room、Principal、Permission
- Session identity、Roomとの関係、Backend Run、取消・再開・復旧状態

Native AppはClient APIまたはDesktop IPCからFormal IngressとRun Controlを使う。外部アプリとTransportは異なっても、同じ認可、Workspace Authority、Runtimeへ到達する。公式製品面であることを理由に、特別なKnowledge領域や直接Database経路を持たない。

---

## 12. 依存ルール

許可する依存。

~~~text
Native App → Client API / Desktop IPC
External App → Connection Adapter / Gateway
        ↓
Query / Domain Operation / Activity Ingest / Run Control
        ↓
Authorization / Workspace Core / Store
        ├→ Runtime → Backend Port → Backend implementation
        └→ Knowledge Host → Workspace Job
~~~

禁止する依存。

- ClientやAdapterからStoreへの直接書込み
- BackendからStore、Database、本文ファイルへの直接アクセス
- SurfaceからDatabaseへの直接更新
- Queryによる保存、学習、Session作成
- SessionをRoom、Activity、Knowledge、Artifactの所有者にする
- Runtime CacheをKnowledge正本としてExportする
- Activity受信だけで通常Knowledgeを無条件に確定する
- 片方の永続化だけを成功させるBest-effort更新

### 12.1 現行実装との対応

| 正本上の責務 | 現行の主な実装名 | 注意 |
| --- | --- | --- |
| Runtime facade | `packages/runtime/src/agent-runtime.ts` の`AgentRuntime` | チームAgentそのものではない |
| Runtime Host | `packages/runtime/src/host/agent-host.ts` の`AgentHost` | 実行制御を組み立てる内部名 |
| Run制御 | `RunControl`、`RunRecovery`、`SessionRunQueue` | Cancel、Resume、Sync、Recoveryを担当 |
| 長時間Job | `WorkspaceJobWorker` | 学習、Curator等のdurable処理 |
| Knowledge Wiki | `KnowledgeWikiRepository`、Wiki Domain Operations、PostgreSQL Wiki Adapter | KnowledgeのMarkdown方式 |
| 旧Memory実装 | `MemoryRepository`、Memory schema、関連Domain Service | 新しい公開Resourceとして維持せず、EpisodeまたはKnowledgeへの移行対象 |
| Workspace Authority | `workspace-server`、`workspace-store`、本文ファイル | 移行中の旧経路を正本仕様にしない |

この表は現行実装を探すための対応表であり、package名を公開用語へ昇格させるものではない。名称変更時は責務、入口、保存先、失敗契約の移行表を同時に更新する。

旧Memory実装は、保存済みデータをEpisodeまたはKnowledgeへ対応付け、Activityの根拠と手順化されたSkillを保全し、移行と互換読取りを検証してから廃止する。「正本でMemoryを使わない」ことだけを削除理由にしない。

---

## 13. 検証不変条件

### 13.1 成功経路

- 外部Clientが許可RoomのKnowledgeを取得できる
- 利用したVersionと実行結果をActivityへ接続できる
- 人間の訂正を含む新Versionを別Clientが再利用できる
- Export・Restore後も本文、hash、Version、Evidence、権限が一致する

### 13.2 失敗経路

- 未参加Room、親Roomだけの参加、失効Connectionを拒否する
- 改ざんされたCaller、OAuth state、PKCE、Credential参照を拒否する
- 同じ冪等Keyの異なる入力を拒否する
- 古いVersion、stale Curator、部分snapshotを拒否する
- 未解決失敗、推測、欠落EvidenceをKnowledgeへ昇格しない
- `fixed`Resource、Policy、PROFILE／SOULをAIが更新できない
- Migration中の通常書込みと、Secretを含むBundleを拒否する
- File Transaction失敗時に本文とDatabaseの片方だけを残さない
- 権限失効後のRealtime配信とRuntime Cache再利用を止める

### 13.3 完成判定

次を別々に記録する。

1. Source実装あり
2. Static / Type / Focused Test成功
3. 実Database確認
4. 実Client確認
5. 対象OS確認
6. Hosted / Self-host確認
7. 事故注入、復旧、移転確認
8. 未検証項目ゼロの完成判定

現在状態と証拠は`reports/`などの検証記録で管理する。この正本へ一時的な進捗や完了主張を書かない。

---

## 14. 参照OSSの扱い

Hermes Agent、Buzz、OpenClaw、Claude Code、Codexなどは比較・設計根拠として参照できる。ただし、参照元の名称、構造、機能をSamuraiの公開契約や実装済み事実へ直接持ち込まない。
