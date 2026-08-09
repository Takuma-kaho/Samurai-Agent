# Samurai Agent Manual

## AI-native Knowledge Workspaceの全体像

---

## 0. この文書について

この文書は、Samurai Agent（以下Samurai）の完成形、主要概念、利用の流れをまとめるプロダクト全体の正本である。

- 完成形を本文に書く。
- 現状実装との差分は「現状と移行」に書く。
- 未確定の実装詳細を、完成した機能として扱わない。

設計思想は PRINCIPLES.md、実装境界は ARCHITECTURE.md、公開用語は PUBLIC_NAMING.md、Native Appの見た目は WEB_UI_DESIGN.md が正本である。

---

## 1. Samuraiとは何か

> **Samuraiは、人間の知識を一か所に集め、外部アプリから届く経験をAIが整理・成長させるAI-native Knowledge Workspaceである。**

人間は、Codex、Claude Code、メモ、Native Appなど複数の場所で仕事をする。従来は、それぞれの場所に知識が分かれていた。

Samuraiは普段のアプリを置き換えず、活動のうち再利用できる情報を共通のWorkspaceへ集める。

~~~text
いつものアプリで作業
        ↓
指示・結果・変更・検証をActivityとして送る
        ↓
Knowledge HostがRoomの範囲で整理する
        ↓
Knowledge・Memory・Skill・Artifactが育つ
        ↓
次のアプリ作業で再利用する
~~~

Samuraiの中心はChatや単一のAgentではない。人間が所有し、育て続けられるWorkspaceである。

### 1.1 作るもの

- 人間のKnowledgeを一か所で保管・検索・再利用する基盤
- 外部アプリの経験を受け取り、整理する学習ループ
- Room単位の共有・閲覧権限
- 交換可能なAgent Backend cassette
- Artifact、Collection、Memory、Skillを保管する正本
- 必要な時だけ表示されるNative AppのChatとSurface

### 1.2 作らないもの

- Workspace内でAIチームが自律的に活動することを主目的にした製品
- WorkspaceをChatアプリの履歴置き場にする設計
- SessionをWorkspaceの必須構成要素にする設計
- Native Appだけが使える特別なKnowledge領域
- すべての会話全文を強制保存する仕組み
- Hostが通常知識を無制限に書き換える自動学習

---

## 2. 全体構造

~~~mermaid
flowchart TB
  subgraph Clients["利用するアプリ"]
    External["Codex / Claude Code / 他社アプリ"]
    Native["Samurai Native App"]
  end

  Gateway["Gateway・共通入口"]
  Activity["Activity Ingest"]
  Core["Workspace Core"]
  Host["Knowledge Host"]
  Backend["Backend cassette"]
  Store["Workspace正本"]

  External --> Gateway
  Native --> Gateway
  Gateway --> Activity
  Activity --> Core
  Core --> Host
  Host --> Backend
  Core --> Store
  Host --> Store
~~~

すべてのクライアントは同じCoreを使う。Native AppはChatとSurfaceの互換性が最も高いクライアントだが、Workspaceから特別扱いされない。

---

## 3. WorkspaceとRoom

### 3.1 Workspace

Workspaceは、個人またはチームが所有するKnowledgeの保管単位である。

保存するもの。

- Roomと権限
- Knowledge、Memory、Skill
- Activity HistoryとWorkspace Change
- ArtifactとCollection
- Backend実行結果と参照情報
- 検索用Index、ファイル、バックアップ情報

Workspaceは「作業画面」ではない。画面が閉じても、知識と履歴が残る正本である。

### 3.2 Room

Roomは、Workspace内でKnowledgeを分け、誰が見られるかを決める境界である。

例。

- 個人の生活
- プロジェクト
- 顧客ごとの資料
- チーム内の共有Knowledge

Roomは会話の入れ物ではない。会話や作業は外部アプリのSessionで行われ、Roomはその結果を保管・共有する範囲になる。

### 3.3 WorkspaceとRoomの関係

~~~text
Workspace
├─ Workspace-level metadata
├─ Room A: 個人の知識
│  ├─ Knowledge
│  ├─ Activity
│  └─ Artifact / Collection
└─ Room B: プロジェクトの知識
   ├─ Knowledge
   ├─ Activity
   └─ Artifact / Collection
~~~

Room間のKnowledgeは自動で混ぜない。共有・昇格・コピーは、権限を確認した明示的な操作として扱う。

---

## 4. 参加者とPrincipal

### 4.1 Principal

Principalは、WorkspaceやRoomにアクセスした主体を表す安定した識別子である。

- Human：人間
- Agent：継続的な役割を持つAgent
- External App：Codex、Claude Code、Native Appなどの接続元
- System：Hostや定期処理の起点

External Appは、勝手に権限を持つ主体ではない。人間またはAgentの権限と、接続設定の範囲内で動作する。

### 4.2 Agent

Agentは、名前、役割、利用可能なRoom、参照できるKnowledgeを持つ参加者である。

AgentとBackendは別物である。

| 概念 | 役割 |
| --- | --- |
| Agent | 誰として、どの範囲で知識を使うか |
| Backend | どの実行エンジンで処理するか |
| Native App Agent | Native App内で人間とチームを組むアプリ機能 |

Native App Agentは、Native Appの操作体験である。Workspace内で常に会話したり、自律的にタスクを開始したりするものではない。

---

## 5. SessionとActivity

### 5.1 Session

Sessionは、Native Appや外部アプリが管理する会話・作業の単位である。

- Sessionの一覧、全文、再開、UI表示はアプリ側の責任
- WorkspaceはSessionを必須の親にしない
- Workspaceには、必要なSession IDやturn IDを参照情報として残せる
- App Session BackupとWorkspace Backupは別に扱う

### 5.2 Activity History

Activity Historyは、外部アプリの作業からKnowledge Hostが扱える構造化証拠を保存する場所である。

標準で保存するもの。

- 何を依頼したか
- 最終的に何が起きたか
- 何が変更されたか
- どの検証を通ったか、失敗したか
- どのアプリ、Agent、Backendから届いたか
- 元のSession、turn、runへの参照

標準で保存しないもの。

- 会話全文
- 内部思考
- 価値のない中間ストリーム

全文が必要なアプリは、アプリ側に保存し、Workspaceには参照だけを送る。Roomや接続設定ごとに全文保存を許可する余地は残すが、Coreの標準にはしない。

---

## 6. 情報の種類

| 種類 | 役割 | 正本 |
| --- | --- | --- |
| Activity History | 作業の構造化された証拠 | Workspace |
| Knowledge | 再利用できる知識 | Workspace / Room |
| Memory | すぐ使う短い個人理解 | Workspace / Room |
| Skill | 再利用する作業手順 | Workspace / Room |
| Artifact | 文書、コード、表、画像などの成果物 | Workspace |
| Collection | 構造化された業務データ | Workspace / Room |
| Surface | 必要時だけ表示する画面 | Native App |
| Session | 会話・作業の履歴 | 利用アプリ |

Activityは材料、Knowledgeは選別された結果である。履歴を残しただけでKnowledgeになったとは扱わない。

---

## 7. Knowledge Hostと学習ループ

Knowledge Hostは、Workspaceに届いたActivityを整理し、Knowledgeが育つ流れを維持するバックエンドの役割である。

~~~mermaid
flowchart LR
  A["Activity"]
  R["分類・要約・出所付与"]
  C["Room内の暫定Knowledge"]
  U["利用・検証"]
  P["再利用できるKnowledge / Memory / Skill"]

  A --> R
  R --> C
  C --> U
  U --> P
~~~

### 7.1 自動保存の範囲

Hostは、同じRoomの中へ、根拠付きの暫定Knowledgeを自動保存できる。

例：

> 「このプロジェクトでは、公開前にテストXを実行することが多い」

この情報には、元のActivity、確からしさ、作成時刻、変更履歴を付ける。

Hostが自動で行わないこと。

- Workspace全体への昇格
- Roomをまたぐ共有
- 既存Knowledgeの削除・統合
- 権限の変更
- 機密情報の採用
- 根拠のない通常Knowledgeの確定

人間が「この知識を保存して」と明示した場合は、Domain Operationとして確定保存する。

### 7.2 学習の段階

1. Activityを受け取る
2. 出所とRoomを確認する
3. 類似Knowledgeと照合する
4. Room内の暫定Knowledgeを作る
5. 利用・検証の結果を記録する
6. 必要ならMemoryやSkillへ整理する
7. 変更履歴と根拠を残す

---

## 8. Host、Backend、Workspace Job

### 8.1 Host

Hostは、Workspace、Knowledge Host、Backend cassette、Domain Operation、Activityをつなぐ実行の調整役である。

Hostが持つ責任。

- RoomとPrincipalの権限を確認する
- 必要なKnowledgeを読む
- Backend cassetteへ処理を渡す
- Backend Eventを正規化する
- ActivityとKnowledge ChangeをWorkspaceへ戻す

Hostは、Native AppのChat画面やSession一覧の所有者ではない。

### 8.2 Backend cassette

Backend cassetteは、交換可能な実行エンジンの境界である。

- Claude Code Backend
- Codex Backend
- Samurai Native Backend
- 将来の外部Backend

どのBackendでも、Hostからは同じ入力・出力・Eventの契約で扱う。

### 8.3 Workspace Job

Workspace Jobは、AIが行う非同期・長時間処理の単位である。

含めるもの。

- Backend実行
- Knowledge整理
- Memory・Skillの学習
- Curator処理
- Generative処理

含めないもの。

- 単純な保存・更新
- 通常の検索
- Sessionの一覧や会話表示
- すべての処理をまとめる万能Workflow

単純な保存・更新はDomain Operationで処理する。

---

## 9. Artifact、Collection、Surface

### 9.1 Artifact

Artifactは、作業の結果として生まれた成果物である。

- 文書
- コード
- 表やグラフ
- 画像、PDF
- 生成・修正されたファイル

ArtifactはWorkspaceで管理し、Native Appは必要な時に閲覧・編集Surfaceを表示する。

### 9.2 Collection

Collectionは、複数の項目を同じ構造で管理するためのデータである。

例：

- 顧客一覧
- 案件一覧
- タスク一覧
- 日記の構造化データ

会話からCollectionを作る場合でも、会話自体はNative Appの責任である。生成されたCollectionだけがWorkspaceの正本になる。

### 9.3 Surface

Surfaceは、Chatの返答に必要な時だけ現れる表示・操作面である。

- Artifact preview
- Collection editor
- Memory review
- Run status
- Knowledge view

Surfaceは再表示できる投影であり、Workspaceデータそのものではない。

---

## 10. 権限と共有

権限はWorkspaceとRoomの二段階で確認する。

~~~text
Principal
   ↓
Workspace membership
   ↓
Room membership / Agent permission
   ↓
Resource action
~~~

- Workspace権限がなければRoomを見られない
- Room権限がなければ、そのRoomのKnowledgeを読めない
- Agentは参加しているRoomの許可されたResourceだけを読める
- System起点の処理も権限を迂回しない
- 外部アプリは接続主体であり、Workspaceの所有者ではない

Room間共有は、明示的なShareやCopyとして記録する。

---

## 11. 外部アプリとNative App

### 11.1 外部アプリ

Codex、Claude Code、その他のアプリは、Samuraiを裏側のKnowledge基盤として利用できる。

外部アプリの体験。

- いつもの画面、CLI、操作を維持する
- 作業の要約と結果をActivityとして送る
- 必要なRoomのKnowledgeを読む
- 必要な変更や成果物をWorkspaceへ戻す

外部アプリをSamuraiの中へ埋め込むことは、Coreの要件ではない。

### 11.2 Native App

Native Appは、Samuraiと最も互換性の高い外部アプリである。

Native Appが担当するもの。

- Chat
- Session
- App Agent
- 会話からのCollection作成
- Surfaceの表示
- App Session Backup

Native Appが担当しないもの。

- Workspaceの正本を独占すること
- 他社アプリにはない特別なKnowledge領域を持つこと
- Workspace内で自律的なチーム活動を常時行うこと

---

## 12. 保存とバックアップ

### 12.1 Workspace Backup

Workspace Backupには、Workspaceが所有する次の情報を含める。

- Room、Principal、権限
- Knowledge、Memory、Skill
- Activity History
- Artifact、Collection
- Workspace Change、Backend結果、参照情報
- Workspaceファイルと検索用状態

### 12.2 App Session Backup

App Session Backupには、Native Appや外部アプリが所有する会話全文、UI状態、再開情報を含める。

Workspace側にNative App専用の保管領域は作らない。Workspaceには、Activityと外部Sessionへの参照だけを残す。

---

## 13. Gatewayと将来の接続

Gatewayは、外部アプリ、CLI、Automation、将来のチャネルからの入口である。

- 認証と接続状態を確認する
- 受信情報をDomain OperationまたはActivity Ingestへ渡す
- Workspaceへ直接書き込ませない
- BackendとWorkspaceの境界を越えて権限を拡大しない

Nostr、署名Event、Relayは、将来のGateway接続候補として扱う。Workspace Coreの正本、必須Event形式、権限モデルの中心には置かない。

Computeの採用方式は未決定であり、Gatewayの基本境界とは分けて検討する。

---

## 14. Native AppのUI

Native AppのUIは、Chat-firstとUI on demandを採用する。

~~~text
Chat
 ├─ 必要な時だけArtifactを表示
 ├─ 必要な時だけCollectionやKnowledgeを開く
 └─ 必要な時だけContext / Run情報を表示
~~~

Chat、Session、App Agent、SurfaceはNative Appの状態である。Workspace Coreは、それらを表示するための正本ではない。

詳しい色、レイアウト、Responsiveルールは WEB_UI_DESIGN.md に定義する。

---

## 15. 現状と移行

### 15.1 現在確認できる実装

現行コードには、次の基盤が存在する。

- Workspace StoreとSQLiteの永続化、Backup・Restore
- sessions、backend runs、workspace changesの保存
- Agent Backendの契約とClaude Code / Codex系の実装
- Room権限とHuman / Agent / System Principal
- Memory、Knowledge Wiki、Skill、Learningの基盤
- Artifact、Collection、Generated Surface
- Gateway、Automation、Sandboxの基盤
- Chat APIとSession単位のRuntime経路

一方、現在の接続部分はSession中心である。

- Backend Run入力にSession参照が必要
- APIや検索・学習経路にSession IDを要求する箇所がある
- Room、Agent、Backend RunがSessionを通して結び付いている

現在の完了レポートはsource差分を含むため、基盤の存在と「検証済み完了」を分けて扱う。

### 15.2 目標へ移行する順序

| Core | 役割 |
| --- | --- |
| Core01〜05 | 契約、Host、Backend、Workspace、Memory・Skill学習の既存基盤 |
| Core06 | Room・Principal・権限境界とSession依存の整理 |
| Core07 | 共通Activity、Activity History、限定Workspace Job |
| Core08 | Artifact・Collection・SurfaceのSession分離 |
| Core09 | Gateway・Automation・外部アプリ接続 |
| Native App | Core外のChat、Session、App Agent、Surface実装 |

Core01〜05の基盤は残す。Core06以降でSessionをWorkspaceの必須親から外し、ActivityとKnowledgeの流れへ組み替える。

### 15.3 Core07の現在の停止地点

Core07で追加するのは、Activity History、Resource利用履歴、限定したWorkspace Job、交換可能なProcessor境界までである。

- Activity保存後に学習Jobを自動起動しない。
- JobのProcessor結果は保存するが、Memory・Knowledge・Skillへ適用しない。
- 本番用Processor、外部アプリ接続、MCP・Plugin adapterは後続Coreで扱う。

つまり、Core07完了は「自動学習完成」ではない。将来の学習方式を差し替えられる履歴と実行基盤が完成した状態を指す。

---

## 16. 未決定・将来検討

- Computeをどの実行基盤にするか
- Room内の暫定Knowledgeを正式Knowledgeへ昇格する詳細UI
- 全文保存を許可するRoom・Connector設定の詳細
- 外部アプリごとのActivity変換アダプタ
- Nostrなど将来Gateway接続の具体仕様

これらは、本文の責務境界を変えない範囲で決める。
