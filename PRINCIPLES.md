# Samurai Agent Principles

## 0. この文書の位置づけ

この文書は、Samurai Agent（以下Samurai）の設計思想と判断基準を固定する正本である。

文書の優先順位は次のとおり。

1. PRINCIPLES.md：なぜ作るか、何を優先するか
2. SAMURAI_AGENT_MANUAL.md：何を作り、概念がどう関係するか
3. ARCHITECTURE.md：どう分解し、どう接続するか
4. PUBLIC_NAMING.md：公開面で何と呼ぶか
5. WEB_UI_DESIGN.md：Native AppのWeb UIをどう見せるか
6. plans/：実装順と作業記録

本文は完成形を示す。現状実装との差分はManualとArchitectureの末尾に短く記録する。

---

## 1. Samuraiが作るもの

> **Samuraiは、人間の知識を一か所に集め、外部アプリから届く経験をAIが整理・成長させるAI-native Knowledge Workspaceである。**

価値の中心は、Samuraiの中で会話することではない。Codex、Claude Code、Native Appなど、普段使うアプリを変えずに活動を続け、その経験が一つのWorkspaceに蓄積されることである。

~~~text
普段のアプリで作業する
        ↓
指示・結果・変更・検証がActivityとして届く
        ↓
Knowledge Hostが根拠を整理する
        ↓
Roomの知識・Memory・Skill・Artifactが育つ
        ↓
次のアプリ作業で再利用される
~~~

Samuraiは、特定のAIモデル、単一のAgent、または新しいチャットアプリに知識を閉じ込める製品ではない。

---

## 2. 中心原則

### 2.1 Workspaceが知識の正本

- Workspaceは人間が所有する永続的な知識の箱である。
- Knowledge、Memory、Skill、Artifact、Collection、Activity Historyを保管する。
- 外部アプリ、Agent、Backendを交換しても知識はWorkspaceに残る。
- Backup・Export・RestoreはWorkspace単位で考える。

### 2.2 Roomは知識と権限の境界

- Roomは、知識を混ぜないための分類・共有・閲覧権限の境界である。
- Roomは会話アプリや自律チームの作業場ではない。
- 個人、プロジェクト、顧客、組織など、必要な範囲でRoomを分ける。
- Workspace自体をRoomとして保存しない。RoomはWorkspace直下または別のRoomの下に置け、階層数で製品上の上限を設けない。
- 親子は整理と参加できる範囲を狭める関係である。親子間でKnowledge、検索、AI Context、閲覧権限を自動共有しない。
- 子Roomの直接メンバーは、すべての親Roomにも直接参加している。親Roomへ参加しただけでは子Roomを見られない。

### 2.3 Sessionはアプリ側の会話単位

- SessionはNative Appや外部アプリが持つ会話・作業履歴である。
- WorkspaceはSessionを必須の親にしない。
- Workspaceが受け取るのは、必要なActivityとSessionの参照情報である。
- App Sessionの保存・バックアップはアプリ側が責任を持つ。

### 2.4 Chat-firstはNative Appの原則

- Native Appでは、会話を中心に作業を始め、必要な時だけUIを出す。
- CoreはChatに依存しない。
- 外部アプリは、同じWorkspace Coreを利用する対等なクライアントである。

### 2.5 Knowledge Hostは整理役

Knowledge Hostは、Workspaceに届いた情報を整理し、Memory・Knowledge・Skillの学習ループを動かす。

- Activityを要約・分類し、根拠を残す。
- 同じRoom内へ、根拠付きの暫定知識を自動保存できる。
- Workspace全体への昇格、削除・統合、権限変更、機密情報の採用は自動で決めない。
- 人間の明確な保存指示はDomain Operationとして直接処理する。

### 2.6 Backend cassetteは一種類の実行境界

Hostから見た実行部は、交換可能なBackend cassetteで統一する。

~~~text
Workspace Core
      ↓
Knowledge Host
      ↓
Agent Backend cassette
  ├─ Claude Code
  ├─ Codex
  └─ Samurai Native Backend
~~~

外部アプリから届く作業も、Host内部の学習処理も、必要な場合は同じBackend境界を通る。外部アプリ用とNative App用で別の実行方式を作らない。

### 2.7 Activityは証拠、Knowledgeは再利用物

- Activity Historyは、指示、最終結果、変更、検証、失敗・修正、出所を構造化して保存する。
- 会話全文や内部思考をWorkspace Coreの必須保存対象にしない。
- KnowledgeはActivityから選別された再利用物であり、Activityと同一視しない。
- すべてのKnowledge変更は、根拠と変更履歴を追えるようにする。

### 2.8 Artifact・Collection・Surfaceを分ける

- Artifactは文書、コード、表、画像、PDFなどの成果物である。
- Collectionは、顧客、案件、タスクなどの構造化された知識である。
- Surfaceは、Native Appが必要な時だけ表示する一時的な操作・閲覧面である。
- SurfaceをWorkspaceの正本にしない。

### 2.9 中立な共通基盤

- Native AppをWorkspace側で特別扱いしない。
- Claude Code、Codex、他社アプリ、Native Appは、同じ権限とActivity入口を利用する。
- App AgentはNative Appのチーム機能であり、Workspaceの常駐参加者や外部APIの主役ではない。

---

## 3. 作らないもの

- Chatだけで知識が完結するアプリ
- CodexやClaude Codeの薄いGUIラッパー
- Workspace内でAIチームが自律活動することを主目的にした製品
- SessionをWorkspaceの必須構成要素にする設計
- すべての会話全文を強制的にWorkspaceへ保存する仕組み
- Hostが通常知識を無制限に書き換える自動学習
- Nostr、Relay、署名Eventを中核正本にする設計
- Workspace Jobに保存・検索・会話・実行のすべてを背負わせること

---

## 4. 判断の優先順位

迷った場合は、次の順で判断する。

1. 人間の知識が一つのWorkspaceに残るか
2. 外部アプリの普段の体験を壊していないか
3. Workspace・Room・Session・Agent・Backendの責務が分かれているか
4. ActivityとKnowledgeを区別できるか
5. 誤った自動学習を同じRoom内に閉じ込められるか
6. Backendを交換しても同じCoreを使えるか
7. UIを必要な時だけ出せるか
8. 後から見直せる根拠と履歴が残るか

新しい概念を追加する前に、既存の境界で表現できないかを確認する。

---

## 5. 設計の全体像

~~~mermaid
flowchart LR
  Apps["Codex / Claude Code / Native App"]
  Gateway["Gateway・共通入口"]
  Ingest["Activity Ingest"]
  Core["Workspace Core"]
  Host["Knowledge Host"]
  Cassette["Backend cassette"]
  Knowledge["Room Knowledge・Memory・Skill"]
  Surface["Native App Surface"]

  Apps --> Gateway
  Gateway --> Ingest
  Ingest --> Core
  Core --> Host
  Host --> Cassette
  Host --> Knowledge
  Core --> Knowledge
  Apps --> Surface
  Surface --> Gateway
~~~

この図の中心はChatではなく、Workspace Coreである。Native AppのChatやSurfaceは、Coreを利用する一つのクライアントである。

---

## 6. 実装時の注意

- Domain Operationは明確な保存・変更命令を扱う。
- Activity Ingestは外部の実行結果を正規化する。
- Workspace JobはAI処理、学習、Curator、長時間処理に限定する。
- Gatewayは入口と接続境界であり、Workspaceへ直接ファイルを書き込まない。
- Agentは継続する参加者・権限主体、Backendは交換可能な実行エンジンとして扱う。
- 設計資料を変更する時も、正本間の用語を先に確認する。
