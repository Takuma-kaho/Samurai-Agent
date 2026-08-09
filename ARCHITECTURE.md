# Samurai Agent Target Architecture

## 0. 文書の役割

この文書は、Samurai Agentの完成形を実装境界として定義する正本である。

対象は次のとおり。

- Workspace Coreの責務
- Native Appと外部アプリの境界
- HostとBackend cassetteの実行経路
- Domain Operation、Activity、Workspace Jobの関係
- Room、Principal、Session参照、Knowledgeの保存境界
- Artifact、Collection、Surface、Gateway、Backup

これは「実装がすべて完了した」という意味の版番号ではない。完成形と現状の差分は末尾で分けて記載する。

---

## 1. 設計不変条件

1. WorkspaceがKnowledgeの正本である。
2. RoomはKnowledgeとアクセス権の境界である。
3. Sessionはアプリ側の会話単位であり、Workspaceの必須親ではない。
4. Native Appと外部アプリは同じWorkspace Coreを使う。
5. Hostから見た実行部は一つのBackend cassette境界に統一する。
6. Activity Historyは構造化証拠、Knowledgeは再利用物である。
7. Hostの自動学習は同じRoom内の根拠付き暫定Knowledgeに限定する。
8. Workspace JobはAI処理・学習・長時間処理に限定する。
9. Surfaceは表示投影であり、Workspaceの正本ではない。
10. Gatewayは接続境界であり、権限を迂回する書き込み口ではない。

---

## 2. システム全体

~~~mermaid
flowchart TB
  subgraph Apps["Application Layer"]
    Native["Samurai Native App"]
    External["Codex / Claude Code / Other Apps"]
  end

  subgraph Boundary["Ingress Boundary"]
    Gateway["Gateway"]
    ActivityIngest["Activity Ingest"]
    DomainIngress["Domain Operation Ingress"]
  end

  subgraph Core["Workspace Core"]
    Policy["Principal / Room Permission"]
    Store["Workspace Store"]
    History["Activity History"]
    Jobs["Workspace Job"]
    Host["Knowledge Host"]
  end

  subgraph Execution["Execution Boundary"]
    Cassette["Agent Backend cassette"]
    Claude["Claude Code Backend"]
    Codex["Codex Backend"]
    NativeBackend["Samurai Native Backend"]
  end

  Native --> Gateway
  External --> Gateway
  Gateway --> ActivityIngest
  Gateway --> DomainIngress
  ActivityIngest --> Policy
  DomainIngress --> Policy
  Policy --> Store
  Policy --> History
  Store --> Host
  History --> Host
  Host --> Jobs
  Host --> Cassette
  Cassette --> Claude
  Cassette --> Codex
  Cassette --> NativeBackend
  Jobs --> Store
  Host --> Store
~~~

依存方向は、ApplicationからGateway、GatewayからCore、CoreからBackend Portへ向かう。BackendやSurfaceがWorkspaceの正本を直接所有しない。

---

## 3. レイヤーと責務

| レイヤー | 主な責務 | 持たない責務 |
| --- | --- | --- |
| Native App | Chat、Session、App Agent、Surface | Workspace正本の独占 |
| External App Adapter | 外部アプリの入力・結果をActivityへ変換 | Room権限の迂回 |
| Gateway | 認証、接続、入口、配信 | Knowledgeの直接編集 |
| Domain Operation | 明示された保存・変更・権限操作 | AIの長時間処理 |
| Activity Ingest | 外部実行結果の正規化 | Knowledgeの無条件確定 |
| Workspace Core | 正本、権限、履歴、成果物、検索 | UI状態の所有 |
| Knowledge Host | Context構築、整理、学習、Backend接続 | App Sessionの所有 |
| Backend cassette | 実行とBackend Eventの返却 | Workspace Knowledgeの正本 |
| Surface | Coreデータの一時的な表示・操作 | 永続状態の正本 |

---

## 4. 中核データモデル

### 4.1 Workspace

Workspaceは、Room、Principal、Knowledge、Memory、Skill、Activity、Artifact、Collectionを所有する。

### 4.2 Room

Roomは、Workspace内のKnowledgeとアクセス権を分ける境界である。RoomはActivityとResourceの分類キーとして使えるが、Sessionの所有者ではない。

### 4.3 Principal

Principalは、誰が操作したかを表す安定した識別子である。

- Human
- Agent
- External App
- System

外部アプリは、接続設定と委任されたHuman / Agent権限の範囲で動く。

### 4.4 SessionRef

SessionRefは、アプリ側SessionをWorkspaceから参照するための任意情報である。

含められる情報。

- app_id
- session_id
- turn_id
- message_id
- resume_urlまたは外部参照キー

SessionRefを削除しても、Activity、Knowledge、Artifactの正本が壊れない設計にする。

### 4.5 ActivityRecord

ActivityRecordは、外部作業の構造化された証拠である。

最低限の意味。

- workspace_id
- room_id
- actor principal
- source app / connector
- instruction summary
- final result summary
- changed resources
- verification outcome
- failure / correction summary
- provenance
- optional SessionRef

会話全文や内部思考は必須フィールドにしない。

### 4.6 WorkspaceJob

WorkspaceJobは、AIが非同期で行う処理の実行単位である。

許可する種類。

- backend execution
- activity organization
- memory / knowledge / skill learning
- curator
- generative processing

単純な保存、削除、権限変更、検索はDomain OperationまたはQueryとして扱う。

### 4.7 BackendRun

BackendRunは、Backend cassetteによる一回の実行結果である。

BackendRunは、WorkspaceJobまたはActivityの処理結果として作られる。Sessionを必須の親にしない。SessionRefはあれば保持するが、実行の同一性や権限の根拠にはしない。

### 4.8 KnowledgeChange

KnowledgeChangeは、Knowledge、Memory、Skill、Artifact、Collectionに対する変更記録である。

- 変更したPrincipal
- 変更理由
- 根拠Activity
- 変更前後のVersion
- Room
- 自動作成か明示操作か

を追跡できるようにする。

---

## 5. 入口と操作の境界

### 5.1 Domain Operation

Domain Operationは、人間やアプリが明確に指定した変更を処理する。

例。

- Knowledgeを保存する
- Artifactを作成・修正する
- Collectionを更新する
- Room権限を変更する
- Backupを作成・復元する

Domain Operationは、入力、権限、冪等性、永続化を一つの契約として扱う。

### 5.2 Activity Ingest

Activity Ingestは、外部アプリから届いた実行結果をWorkspaceの共通形へ変換する。

処理順。

1. 接続元とPrincipalを確認する
2. WorkspaceとRoomを解決する
3. Backend固有Eventを正規化する
4. 構造化証拠を作る
5. Activity Historyへ保存する
6. 必要ならHostの整理Jobを起動する

Activity Ingestは、受信した内容を通常Knowledgeとして即確定しない。

### 5.3 Query

Queryは、Workspace、Room、Activity、Knowledge、Artifact、Collectionを読む。

Queryは副作用を持たない。読み取り時にSessionを作成したり、Knowledgeを自動変更したりしない。

---

## 6. HostとBackend cassette

### 6.1 Hostの実行経路

~~~mermaid
sequenceDiagram
  participant App as 外部アプリ / Native App
  participant G as Gateway
  participant H as Knowledge Host
  participant B as Backend cassette
  participant W as Workspace Core

  App->>G: Activityまたは明示操作
  G->>H: 認証済みContext
  H->>W: Room / Knowledge / Permissionを読む
  H->>B: 共通Backend入力
  B-->>H: 正規化前のBackend Event
  H->>W: Activity / BackendRun / KnowledgeChange
  W-->>G: 結果と参照
  G-->>App: 状態またはSurface用データ
~~~

Backendの種類が変わっても、Hostの入力とWorkspaceへの戻し方は変えない。

### 6.2 Backend cassetteの契約

Backend cassetteは、最低限次を扱う。

- 実行要求
- Backend Eventのストリーム
- 成功・失敗・中断・要確認の終端
- 生成されたArtifactや変更の参照
- Backend固有のSession情報（任意）

Claude Code、Codex、Samurai Native Backendは、同じcassette契約の実装である。

### 6.3 Hostがしないこと

- Native AppのSession一覧を作る
- App Agentを外部から直接呼び出す
- Roomをまたいで権限を拡大する
- Backendの確認ポリシーを勝手に置き換える
- 根拠のないKnowledgeを確定する

---

## 7. 学習ループ

~~~mermaid
flowchart LR
  Activity["ActivityRecord"]
  Review["整理・抽出・照合"]
  Draft["同じRoomの暫定Knowledge"]
  Use["利用と検証"]
  Promote["明示操作または十分な根拠"]
  Memory["Memory / Knowledge / Skill"]

  Activity --> Review
  Review --> Draft
  Draft --> Use
  Use --> Promote
  Promote --> Memory
~~~

標準自動処理。

- Activityの要約と分類
- 根拠と出所の付与
- 同じRoom内の暫定Knowledge作成
- 利用記録と検証結果の記録
- Memory / Knowledge / Skill候補の整理

人間の確認が必要な処理。

- Workspace全体への昇格
- Roomをまたぐ共有
- 既存Knowledgeの削除・統合
- 権限変更
- 機密情報の採用

暫定Knowledgeは、確度、根拠、作成元Job、Versionを持つ。自動保存しても、確定済みの通常Knowledgeとは区別する。

---

## 8. 権限の評価順

すべてのRead / Write / Executeで次を確認する。

1. 接続元が認証されているか
2. Principalが有効か
3. Workspace membershipがあるか
4. Room membershipまたはAgent permissionがあるか
5. 対象Resourceに対する操作権限があるか
6. Activityの出所と委任元が記録されているか

System Principalも権限を迂回しない。External Appは、接続できたことだけでRoomの所有者にはならない。

---

## 9. 永続化とバックアップ

### 9.1 Workspace Store

Workspace Storeは、Workspaceの正本をファイルとSQLiteへ保存する。

- ファイル：人間が直接読めるKnowledgeやArtifact
- SQLite：整合性、検索、履歴、Queue、Index

UI stateや一時的なSurface stateをWorkspace正本へ混ぜない。

### 9.2 Workspace Backup

Workspace Backupに含めるもの。

- Workspace metadata
- Room、Principal、Permission
- Knowledge、Memory、Skill
- Activity History、KnowledgeChange
- Artifact、Collection
- BackendRun、WorkspaceJobの必要な履歴
- Workspace fileとindex

### 9.3 App Session Backup

App Session Backupは、Native Appまたは外部アプリが所有する。

- 会話全文
- UIの表示状態
- App Agentの会話状態
- 再開に必要なアプリ固有情報

WorkspaceにはSessionRefを保存できるが、Native App専用のバックアップ領域は設けない。

---

## 10. Artifact・Collection・Surface

### 10.1 Artifact

ArtifactはWorkspaceが所有する成果物である。Revision、出所、作成したActivity、関連するRoomを追跡できるようにする。

### 10.2 Collection

CollectionはWorkspaceが所有する構造化データである。Native Appの会話から作る場合でも、保存後は外部アプリに依存しない。

### 10.3 Surface

SurfaceはNative AppがWorkspaceのデータを表示・操作する一時的な面である。

- Chat message
- Artifact preview
- Collection editor
- Knowledge view
- Context drawer

Surfaceは再生成できる。SurfaceのDOM、レイアウト、表示順をWorkspace正本に保存しない。

---

## 11. Gatewayと外部接続

Gatewayは、外部アプリ、CLI、Automation、将来のチャネルからの接続境界である。

責務。

- 認証・接続状態・Pairingの確認
- 入力元とPrincipalの記録
- Activity IngestまたはDomain Operationへの振り分け
- Backend Eventの返却
- 冪等性と再送の境界

Gatewayがしないこと。

- Workspaceファイルへの直接書き込み
- Room権限の省略
- Native Appだけの優先処理
- SessionをWorkspaceの必須親にすること

Nostr、署名Event、Relayは将来の接続候補として調査できるが、Coreの必須契約には含めない。

Computeの方式は別決定とし、Gatewayの責務へ混ぜない。

---

## 12. 依存方向のルール

許可する依存。

~~~text
Native App / External App
        ↓
Gateway / Application Adapter
        ↓
Domain Operation / Activity Ingest
        ↓
Workspace Core / Permission / Store
        ↓
Knowledge Host
        ↓
Backend Port → Backend cassette implementation
~~~

避ける依存。

- BackendがWorkspace Storeを直接呼ぶ
- SurfaceがDBを直接更新する
- GatewayがDomain Operationを迂回する
- SessionがRoomやKnowledgeの所有者になる
- Workspace Jobがすべての処理を代行する
- Activityを受けただけで通常Knowledgeを無条件に更新する

---

## 13. 現状実装と移行

### 13.1 現状

現行コードには、Workspace Store、Room permission、Agent Backend、Memory・Skill・Learning、Artifact、Collection、Generated Surface、Gatewayの基盤がある。

ただし、接続経路はSession中心である。

- BackendRun入力にSession参照が必要
- Server APIや検索・学習経路がSession IDを要求する
- Room、Agent、BackendRunの関係がSessionに結び付いている

したがって、現在の実装を完成形と同一視しない。Session中心の経路を段階的に参照情報へ変える。

### 13.2 Coreの移行単位

| Core | 実装テーマ |
| --- | --- |
| Core01〜05 | 契約、Host、Backend、Workspace、Memory・Skillの基盤を維持 |
| Core06 | Room・Principal・PermissionとSession依存の境界を組み替える |
| Core07 | 共通Activity、Activity History、限定Workspace Jobを追加する |
| Core08 | Artifact・Collection・SurfaceからSession必須依存を外す |
| Core09 | Gateway・Automation・外部アプリ接続を整理する |
| Native App | Core外でChat、Session、App Agent、Surfaceを提供する |

### 13.3 検証の扱い

完了レポートにsource差分や証拠不足がある場合、実装の存在を「完了」と書かない。

- 基盤あり
- 実行経路あり
- 契約テスト済み
- 実Backendで確認済み
- 完了判定済み

を分けて記録する。

### 13.4 Core07の移行停止地点

Core07は、`ActivityRecord`、`ResourceUsageRecord`、`WorkspaceJob`、`ActivityProcessorPort`を追加する移行単位である。

- Activityの確定は事実の保存であり、学習結果の採用ではない。
- `activity_processing` Jobは明示enqueueでのみ実行し、Activity保存から自動作成しない。
- Processorは読み取り専用の構造化結果を返し、Workspace StoreやMemory・Knowledge・Skillを直接変更しない。
- MCP/API/Pluginのtransportと本番学習ProcessorはCore09以降で接続する。

---

## 14. 参照元

- MulmoClaude型Host：Host、Artifact、Collection、Rendererの考え方
- Hermes Agent：Memory、Skill、Reflection、改善ループ
- Buzz：Room、参加者、共有境界の考え方
- Type.com：Knowledge、Skill、Integrationの持ち込み体験
- Claude Code / Codex：交換可能なBackend cassetteの候補

参照元の固有実装をそのまま正本へ持ち込まない。公開面の命名は PUBLIC_NAMING.md に従う。
