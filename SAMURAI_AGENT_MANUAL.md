# Samurai Agent Manual

## 人とAIが一緒に活動し、その経験から知識と仕組みが育つワークスペース

---

## 目次

0. [この文書について](#0-この文書について)
1. [Samurai Agentとは何か](#1-samurai-agentとは何か)
2. [中心となる設計思想](#2-中心となる設計思想)
3. [全体構造](#3-全体構造)
4. [Workspace](#4-workspace)
5. [メンバーと役割](#5-メンバーと役割)
6. [RoomとSession](#6-roomとsession)
7. [人・Agent・外部アプリ・Samurai System](#7-人agent外部アプリsamurai-system)
8. [情報を表す用語](#8-情報を表す用語)
9. [情報の所有範囲と利用範囲](#9-情報の所有範囲と利用範囲)
10. [学習ループ](#10-学習ループ)
11. [共通EventとWorkspace正本](#11-共通eventとworkspace正本)
12. [Agent・Backend・Compute](#12-agentbackendcompute)
13. [保存とポータビリティ](#13-保存とポータビリティ)
14. [ユーザー体験](#14-ユーザー体験)
15. [参照プロジェクトから取り入れるもの](#15-参照プロジェクトから取り入れるもの)
16. [Samurai Agent独自の統合](#16-samurai-agent独自の統合)
17. [現状実装との差分](#17-現状実装との差分)
18. [未決定事項](#18-未決定事項)

---

# 0. この文書について

この文書は、Samurai Agentが**何を目指し、どのような概念・用語・関係性で作られるのか**を一つにまとめた、プロダクト全体像の正本である。

対象とする内容は以下。

- プロダクトの定義
- Workspace・Room・Sessionの関係
- 人・Agent・外部アプリ・Samurai Systemの位置づけ
- Memory・Knowledge・Skillなどの情報構造
- 学習ループ
- Backend・Compute・外部接続
- 権限・保存・ポータビリティ
- 参照プロジェクトとの違い

短期的な実装手順ではなく、Samurai Agentが最終的に目指す全体像を示す。

まだ決まっていない内容を無理に確定せず、以下のように区別する。

- **決定事項**: 設計の前提として採用する
- **要検討事項**: 方向性だけを示し、詳細は後から設計する
- **実装差分**: 現在の実装から変更が必要な部分

文書の優先順位は以下とする。

1. `PRINCIPLES.md`: 設計思想・判断基準・前提
2. `SAMURAI_AGENT_MANUAL.md`: プロダクト全体像・概念・用語・関係性
3. `ARCHITECTURE.md`: システム構造・責務・境界・データ流れ
4. `PUBLIC_NAMING.md`: 公開面の命名ルール
5. `WEB_UI_DESIGN.md`: 固定Web UIの視覚設計・UI shell
6. `plans/`: 実装順・レビュー・作業計画

このManualで「決定事項」とした内容は実装判断の正本とする。「要検討事項」は方向性の記録であり、実装時に暗黙に確定してはならない。

---

# 1. Samurai Agentとは何か

> **Samurai Agentは、人とAIが一緒に活動し、その経験から知識と仕組みが育つワークスペースです。**

Samurai Agentの中心は、特定のAIモデルやAgentではない。

中心にあるのは、人とAIが継続的に活動する**Workspace**である。

```text
人とAIが活動する
        ↓
会話・判断・成果が残る
        ↓
経験がMemoryになる
        ↓
KnowledgeやSkillへ育つ
        ↓
次の活動で再利用される
```

ここでいう「活動」には、仕事だけでなく、調査・学習・開発・日常的な相談も含まれる。

「知識と仕組み」には、次のようなものが含まれる。

- 過去の経験や決定
- 再利用できるKnowledge
- 繰り返し使えるSkill
- 文書やコードなどのArtifact
- 構造化されたCollection
- 必要に応じた自動化

Samurai Agentは、単なるAIチャットではない。

また、たくさんのAgentを見せること自体を目的としたAIチーム製品でも、CodexやClaudeなど特定Backendの管理画面でもない。

人やBackendが変わっても、活動から得られた知識と成果は、所有者のWorkspaceに残り続ける。

---

# 2. 中心となる設計思想

## 2.1 Workspaceを所有と保存の中心にする

> **Workspaceは、個人またはチームが所有する、Knowledge・活動履歴・成果物・Agent・Roomの保存単位である。**

- Backup・Export・Restore・削除はWorkspace単位で行う
- RoomやAgentはWorkspaceを所有しない
- AgentやBackendが変わっても情報はWorkspaceに残る
- Workspaceへの保存と、全メンバーへの公開は分けて考える

「Personal Workspace」と「Shared Workspace」は別種類にしない。同じWorkspaceを、参加者と権限によって柔軟に利用する。

## 2.2 日常の活動はRoomを中心にする

Workspaceが全体の保存・管理単位である一方、日常的な会話や作業はRoomを中心に行う。

```text
Workspace
├── Workspace Knowledge
│   └── 全Roomで共通する少量の知識
│
└── Rooms
    ├── Room Knowledge
    │   └── 主となるKnowledge
    │
    └── Sessions
        └── Knowledgeの材料となる会話・作業履歴
```

- Workspaceは所有・管理の場所
- Roomは活動・共有範囲
- Sessionは一回の会話・作業

## 2.3 人とAgentを同じ活動面に置く

人とAgentは、Roomの中で同じ参加者として活動する。

ただし、人・Agent・外部アプリ・Samurai Systemは、同じ権限や信頼度を持つわけではない。

```text
Workspace / Room
├── Owner
├── Admin
├── Member
├── Guest
└── Agent
```

用語を増やしすぎず、WorkspaceとRoomで同じ役割名を使う。

## 2.4 Agentと実行Backendを分離する

Agentは継続する名前・役割・権限を持つ。

Codex・Claude・ローカルモデルなどは、そのAgentが仕事を実行するために利用する交換可能なBackendである。

```text
Agent
├── 名前・役割
├── 利用権限
├── Agent向けKnowledge
└── Backend
    ├── Codex
    ├── Claude
    └── Local Model
```

Backendを交換しても、Agentの役割やKnowledgeは失われない。

## 2.5 MemoryとLearningを分ける

Memoryは経験を残すもの。Learningは、その経験を再利用可能なKnowledgeやSkillへ変える処理である。

```text
Activity History
        ↓
      Memory
        ↓ Learning
├── Knowledge
└── Skill
```

学習とは、すべての会話を無条件に記憶することではない。

必要な経験を選び、適切な利用範囲で再利用できる形へ変えることである。

## 2.6 共通Eventと正本を分ける

人・Agent・外部アプリ・Samurai Systemは、共通Eventを通じてやり取りする。

ただし、Eventを受け取れることと、Workspaceの正しい情報として採用することは別である。

```text
共通Event
    ↓
出所・権限・対象Roomを確認
    ↓
Activity Historyとして保存
    ↓ Learning
Workspace正本へ反映
```

## 2.7 情報は一括保存し、利用範囲を分ける

Memory・Knowledge・Skill・Artifact・Collectionなどは、Workspaceがまとめて保存する。

ただし、Workspaceに保存されているからといって、全員が閲覧・検索・利用できるわけではない。

- 保存場所
- 利用範囲
- 閲覧権限

この3つを分けて管理する。

## 2.8 表側はシンプルに、裏側で責務を分ける

利用者が日常的に見る中心画面はRoomとChatである。

Backend・Compute・保存形式・権限判定などの内部構造は、必要な設定や確認時だけ見せる。

> **表側はRoom中心でシンプルに、裏側はWorkspaceが一括管理する。**

---

# 3. 全体構造

Samurai Agentは、次の階層で構成する。

```text
Samurai Agent
├── Workspace A
│   ├── 人
│   ├── Agents
│   ├── 情報・成果物
│   └── Rooms
│       └── Sessions
│
└── Workspace B
    └── ...
```

それぞれの役割は異なる。

| 概念 | 役割 |
|---|---|
| Samurai Agent | プロダクト全体 |
| Workspace | 所有・保存・Backupの単位 |
| Room | 活動・共有範囲の単位 |
| Session | 一回の会話・作業の単位 |
| Agent | 継続する名前・役割・権限を持つAI |

Samurai Agentは、Workspaceを包むシステム全体を表す。Workspaceの上に、さらにデータを所有する階層は作らない。

```text
所有の中心：Workspace
活動の中心：Room
会話の中心：Session
実行の担当：Agent
```

---

# 4. Workspace

> **Workspaceは、個人またはチームが所有する、Knowledge・活動履歴・成果物・Agent・Roomの保存単位である。**

Workspaceには、次のものが含まれる。

```text
Workspace
├── 人と役割
├── Agents
├── Rooms
├── Activity History
├── Memory・Knowledge・Skill
├── Artifact・Collection
├── 外部接続・Compute設定
└── 権限・Backup情報
```

ただし、これは保存上の全体像である。Workspace内に保存されていることは、全員が閲覧できることを意味しない。

## 4.1 Workspaceの基本ルール

- Backup・Export・Restore・削除はWorkspace単位
- RoomやAgentはWorkspaceを所有しない
- Workspaceへの保存と、全員への公開は別
- 検索結果には、本人が閲覧できる情報だけを表示する
- 復元時もRoom・権限・出所を維持する

## 4.2 PersonalとSharedを別種類にしない

「Personal Workspace」と「Shared Workspace」という別の型は作らない。

すべて同じWorkspaceとして扱い、参加者と権限によって利用方法を変える。

同様に、「Personal Room」と「Shared Room」も別種類にしない。

```text
Workspace / Room
└── 参加者と権限によって利用形態が変わる
```

## 4.3 Workspace Knowledge

Workspace Knowledgeには、すべてのRoomで共通して利用できる少量のKnowledgeだけを置く。

Room固有の情報を無理にWorkspace Knowledgeへ移すと、関係のない作業へ悪影響を与える。

```text
Workspace Knowledge
└── 全Roomで共通する前提・方針・知識

Room Knowledge
└── 特定の活動や目的に必要な主たるKnowledge
```

---

# 5. メンバーと役割

WorkspaceとRoomでは、同じ役割名を使う。

```text
Workspace
├── Owner
├── Admin
├── Member
├── Guest
└── Agent

Room
├── Owner
├── Admin
├── Member
├── Guest
└── Agent
```

| 役割 | 意味 |
|---|---|
| Owner | 対象となるWorkspaceまたはRoomの責任者 |
| Admin | Ownerを補佐し、メンバーや設定を管理する |
| Member | 通常の人間メンバー |
| Guest | 許可された範囲だけを利用する外部参加者 |
| Agent | AIとして活動する参加者 |

## 5.1 WorkspaceとRoomの役割は別に判定する

Workspaceの役割を持つことと、特定Roomへ参加できることは別である。

```text
Workspaceに所属
        ≠
すべてのRoomを閲覧可能
```

- Workspace Owner／AdminはWorkspace全体の設定を管理する
- Room Owner／AdminはRoomの参加者と情報を管理する
- Roomの内容を見るには、そのRoomでの権限が必要
- 管理権限と、内容を読む権限を混同しない

## 5.2 Agentの扱い

AgentはMemberやBotの別名ではなく、独立した参加者種別として扱う。

Agentは、次の情報を持つ。

- 名前・アイコン
- 役割・指示
- 参加できるRoom
- 利用できるKnowledge・Skill・Compute
- 実行に使うBackend

ただし、AgentはWorkspaceそのものを所有しない。Agentの情報やKnowledgeも、Workspaceが保存・管理する。

## 5.3 Sessionには役割を置かない

Sessionはメンバー管理の単位ではない。

Sessionの閲覧・利用権限は、基本的に所属するRoomから引き継ぐ。

## 5.4 Core 06: Room参加者・権限・共有境界

人とAgentは同じ役割表に混ぜない。人はWorkspaceとRoomで別々に役割を持ち、AgentはRoomごとの個別許可だけを持つ。

```text
人の役割: Owner > Admin > Member > Guest
Agent: 閲覧 / 編集 / 実行を個別に許可
```

- Workspace Ownerは1人。Workspaceの役割だけで、未参加Roomの内容は読めない。
- Room Ownerは1人。AdminはOwnerや他のAdminを変更・解除できない。
- Agentの編集・実行には、必ず閲覧許可も必要である。AgentはRoom Ownerになれない。
- Session独自の役割は作らず、所属Roomの現在の参加状態を使う。
- 参加解除は削除ではなく履歴として残す。ただし解除直後から、新しい閲覧・検索・実行・編集は拒否する。
- Room間共有は、両Roomに参加する人の明示操作だけで成立する。元データは複製せず、出所を保った閲覧・利用資格だけを追加する。
- `Grant`と`UsageScope`は参加権限ではない。`UsageScope`は、Room境界で許可された候補をさらに狭める用途だけに使う。

---

# 6. RoomとSession

> **Roomは活動・共有範囲の単位、Sessionは一回の会話・作業の単位である。**

## 6.1 Room

Roomは、人とAgentが目的ごとに集まって活動する場所である。

```text
Workspace
└── Rooms
    ├── 日常
    ├── 開発
    ├── 調査
    └── プロジェクトA
```

Roomごとに、次のものを分離できる。

- 参加者
- Agent
- 会話
- Knowledge
- Artifact
- Collection
- 外部アプリからのEvent
- 利用できるSkillやCompute

これらをWorkspace内のどこへ具体的に配置するかは、後続設計で検討する。

### Core 05着手前のバックエンド基盤

現時点では、RoomとAgentをSQLiteのWorkspace管理情報として保存する。

- RoomはID・名前・作成／更新日時を持つ。
- AgentはID・名前・役割・指示・Backend ID・有効状態を持つ。
- `settings.patch`で既定Room／既定Agentを選び、SessionにはRoom、Backend RunにはAgentを保存する。
- `room.create / patch / list / view` と `agent.create / patch / backend.bind / list / view` で操作する。

Core 06では、Room参加者・Agent権限・明示共有をSQLiteへ保存する。招待メール、外部認証、Room管理画面、Room削除・アーカイブは含めない。

この基盤は新しいWorkspace形式から使い始める。旧Session／RunへのRoom・Agent出所のbackfillや、旧Bundleの復元互換は行わない。

## 6.2 Room Knowledge

日常的に最も多く育つのはRoom Knowledgeである。

```text
Workspace
├── Workspace Knowledge
│   └── 全Roomで共通する少量の知識
│
└── Rooms
    ├── Room Knowledge
    │   └── 主となるKnowledge
    │
    └── Sessions
        └── Knowledgeの材料となる会話・作業履歴
```

Room Knowledgeは、Room自身が別の保存媒体を持つという意味ではない。

Workspace内へ保存し、Roomの利用範囲と権限を付けて管理する。

## 6.3 Session

Sessionは、Room内で行われる一回の会話または作業である。

```text
Room
├── Session A：機能の企画
├── Session B：実装
└── Session C：レビュー
```

Sessionが持つ中心的なものは、その作業中の文脈とActivity Historyである。

- 会話
- Agentの実行履歴
- 外部Event
- 使用したKnowledgeやSkill
- 作成したArtifactや変更内容

Sessionは独立した長期Knowledgeを育てない。

Sessionで得られた経験は、学習ループを通じてMemory・Knowledge・Skillの材料になる。

```text
Sessionの経験
        ↓
学習候補
        ↓
Memory・Knowledge・Skill
```

新しいSessionを開始しても、RoomのKnowledgeや過去の成果物は失われない。

---

# 7. 人・Agent・外部アプリ・Samurai System

人・Agent・外部アプリ・Samurai Systemは、共通Eventを通じて同じWorkspace／Room上でやり取りする。

> **同じ言語で話せることと、同じ立場や権限を持つことは別である。**

これらは、次のように役割を分ける。

```text
参加者
├── 人
└── Agent

接続元
└── 外部アプリ

内部実行者
└── Samurai System
    ├── Workflow
    ├── Automation
    └── Scheduler
```

Eventの出所としては、次の4種類になる。

```text
Human / Agent / External / System
```

## 7.1 人

人はWorkspaceとRoomへ参加し、それぞれの役割と権限に従って活動する。

人が最終的な所有・管理・判断の責任を持つ。

## 7.2 Agent

Agentは、継続する名前・役割・権限を持つAI参加者である。

```text
Agent
├── 名前・アイコン
├── 役割・指示
├── 参加できるRoom
├── 利用できる情報・能力
└── 交換可能なBackend
```

Agentは、CodexやClaudeそのものではない。

Codex・Claude・ローカルモデルなどは、Agentが仕事を実行するために利用するBackendである。

## 7.3 外部アプリ

外部アプリは、原則としてWorkspaceやRoomのメンバーではなく、共通Eventを送受信する接続元として扱う。

```text
外部アプリ
    ↓ 共通Event
Samurai Agent
    ↓
対象Workspace・Room
```

外部アプリからEventが届いた場合は、次を確認する。

- 誰が送ったか
- どのWorkspaceに対するものか
- どのRoomに対するものか
- 送信者に権限があるか
- 正式な情報として採用できるか

外部Eventを表示・保存できることと、Knowledgeとして採用することは別である。

## 7.4 Samurai System

Samurai Systemは、Workflow・Automation・Schedulerなど、Samurai Agent内部の処理を実行する主体である。

Systemが生成したEventも、人やAgentのEventと同様に出所と処理内容を記録する。

ただし、SystemはRoomのメンバーとして見せる必要はない。UIでは、人・Agentの発言と区別できるSystem Eventとして表示する。

---

# 8. 情報を表す用語

Samurai Agentでは、情報を一つの「記憶」という言葉にまとめない。

## 8.1 Activity History

実際に何が起きたかという記録。

- 会話
- 操作
- Agentの実行
- 外部Event
- System Event
- 作成・変更された成果物
- エラーや結果

Activity Historyは経験の材料だが、それ自体がKnowledgeではない。

## 8.2 Memory

Activity Historyから選び出された、後から思い出すべき経験・決定・個人理解。

```text
Activity History
        ↓ 選別・要約
      Memory
```

Memoryは「過去に何があり、どのように受け止めたか」を残す。

## 8.3 Learning

経験を、今後も再利用できるKnowledgeやSkillへ変える処理。

Learningは保存される情報の種類ではなく、情報を変換・整理する過程である。

## 8.4 Knowledge

Memory・資料・成果物などから得られた、指定された範囲で再利用できる知恵・判断・前提。

「汎用的」とは、必ずしもWorkspace全体で使えるという意味ではない。

- Room内で再利用できるKnowledge
- 特定Agentが再利用できるKnowledge
- Workspace全体で再利用できるKnowledge

が存在する。

## 8.5 Knowledge Wiki

Knowledgeをページとして読み、探し、関連付け、編集するための管理形式。

> **Knowledgeが中身、Knowledge Wikiがその閲覧・管理面である。**

```text
Knowledge
└── Knowledge Wiki
    ├── ページ
    ├── リンク
    ├── 検索
    └── 編集
```

MulmoClaudeにおける`LLM Wiki`は、Samurai Agentでは`Knowledge Wiki`と呼ぶ。

## 8.6 Skill

繰り返し実行できる作業手順。

Knowledgeが「何を知っているか」なら、Skillは「どう実行するか」を表す。

## 8.7 Artifact

人やAgentの活動によって完成した成果物。

- 文書
- コード
- 表
- グラフ
- 画像
- PDF
- レポート

ArtifactはKnowledgeそのものではないが、Learningの材料になる。

## 8.8 Collection

決められた項目に従って管理される構造化データ。

- 顧客一覧
- タスク一覧
- 調査資料一覧
- プロジェクトデータ
- コンテンツ一覧

Collectionは情報を整理する器であり、そこから得られた理解や判断はKnowledgeになる。

## 8.9 情報同士の関係

```text
Activity History
        ↓
      Memory
        ↓
     Learning
        ↓
├── Knowledge ── Knowledge Wikiで管理
└── Skill

活動の結果
├── Artifact
└── Collection

Artifact・Collection・外部資料
        ↓
Learningの材料
```

---

# 9. 情報の所有範囲と利用範囲

> **保存場所・利用範囲・閲覧権限は別である。**

```text
保存場所
└── どこが情報を所有するか

利用範囲
└── どの活動で情報を使うか

閲覧権限
└── 誰が情報を読めるか
```

## 9.1 保存場所

Memory・Knowledge・Skill・Artifact・Collectionなどは、すべてWorkspaceが保存・所有する。

RoomやAgentごとに、新しい独立した保存媒体を作らない。

## 9.2 利用範囲

情報には、次のような利用範囲を付けられる。

| 範囲 | 意味 |
|---|---|
| Workspace | 複数のRoomを横断して利用する |
| Room | 特定のRoom内で利用する |
| Agent | 特定のAgentの役割として利用する |
| Session | 現在の会話・作業で利用する |

Agent向けの情報も、Agent自身が所有するのではない。

Workspace内に保存し、Agentが利用できる範囲として管理する。

現時点のバックエンド基盤では、Memory・Knowledge Wiki・Skillにこの利用範囲を保存し、SQLite indexで先に絞ってから実行文脈へ渡す。閲覧権限の判定や自動昇格は、別の後続設計で扱う。

## 9.3 閲覧権限

Workspaceに保存されていても、すべてのメンバーが閲覧できるわけではない。

```text
Workspaceに保存
        ≠
Workspace全員へ公開
```

- Workspace検索には、本人が閲覧可能な情報だけを表示する
- Room情報は、権限のある参加者だけが利用する
- Agentには、許可された情報だけを渡す
- 外部アプリには、送受信を許可した情報だけを渡す

## 9.4 要検討事項

Activity History・Memory・Knowledge・Skill・Artifact・Collectionを、Workspace／Room／Agentへ具体的にどう配置するかは未決定である。

この章では、以下だけを決定事項とする。

- すべてWorkspaceが保存する
- 利用範囲を情報ごとに分ける
- 閲覧権限を利用範囲とは別に管理する
- 保存場所を分散させない

---

# 10. 学習ループ

> **学習とは、すべてを記憶することではなく、経験を再利用可能にすることである。**

## 10.1 基本的な流れ

```text
人・Agentが活動する
        ↓
Activity Historyが残る
        ↓
候補信号があるRunだけをRoom単位でBackground Reviewする
        ↓
Memory・経験則（Knowledge）・Skill候補を、根拠付きで作る
        ↓
次のRunで本文を読み、実際に使った時だけ評価する
```

Activity Historyは会話、Run、Event、Tool、Workspace Change、Artifactなどの生の履歴である。通常の会話を、毎ターンMemoryへ複製してはならない。明示保存、Session summary、Background Reviewで整理されたMemoryだけをMemoryにする。

Memoryは、同じ意味と利用目的を持ち、単独で思い出し訂正できる情報である。Knowledgeのうち経験則は、`knowledge_kind: experience_rule`として管理する。経験則は「条件・推奨判断または行動・予測結果・根拠」を持ち、根拠Memoryを消したり置き換えたりしない。Skillは反復可能な手順である。

新しい学習Resourceは、根拠の状態、利用の状態、保存形式を混同しない。

- 根拠の状態: `direct_confirmed`、`inferred`、`supported`、`conflict`
- 利用の状態: `normal`、`limited`、`dormant`
- 保存形式: Memory、Knowledge、Skill

各ResourceにはUsage Scope、発生元Activity Context、根拠Run、Version、内容ハッシュを残す。本文の現行正本はWorkspaceの人間可読ファイルであり、SQLiteは検索、状態、Version履歴のmetadataだけを持つ。

## 10.2 利用範囲を越える学習

Room内で得られた経験を、WorkspaceやAgentへ広げる場合は慎重に扱う。

```text
Room内の経験
├── Room固有 → Room内で利用
├── Agentの役割固有 → Agent向け候補
└── 全Room共通 → Workspace向け候補
```

Roomの情報を、AgentやWorkspaceへ自動的に持ち出してはならない。

Sessionは一時的な証拠の範囲であり、長期経験則の通常保存先にはしない。新しいMemoryと経験則の標準範囲はRoomである。Agent範囲は役割、道具、Runtimeに依存する場合だけ使う。Workspace範囲は明示したユーザー指示または複数Roomの独立根拠があっても「昇格候補」に留め、Scope変更はコピーや移動ではなく、発生元Roomを残す新Versionとして記録する。

## 10.3 学習に必要な情報

学習結果には、少なくとも次の情報が必要になる。

- 何を学んだか
- 何を根拠にしたか
- どのRoom・Sessionから生まれたか
- 誰またはどのAgentが作ったか
- どの範囲で利用できるか
- 後から編集・取消できるか

Run完了時は追加LLMを呼ばず、明示保存・訂正・Tool失敗後の成功・客観結果・実利用・意味のあるWorkspace Change・反復手順・Backend Learning Signalから候補信号だけを登録する。Activity Contextを解決できないRunは候補にしないが、会話は成功させる。同じsource RunのBackground Review候補は1件だけである。

Background Reviewは、同じRoomの証拠とResourceだけを入力にし、型付きMutation Planを通じて次だけを行う。

- Memory、経験則、Skill候補を作る
- 既存Resourceへ根拠を追加した新Versionを作る
- 条件分割、置き換え、Skill修正の候補を作る

削除、Archive、自動統合、自動Scope拡張、別Room本文の混在、Activity History変更、外部サービス操作、学習効果の判定はBackground Reviewに許可しない。

ResourceがIndexで選ばれた`selected`、本文をBackend Contextへ渡した`body_loaded`、Skill補助を読んだ`support_loaded`、実際の判断・行動に使った`applied`は分けて保存する。`applied`は同じRunで本文を読み、Resource ID・Version・内容ハッシュ・Usage Scopeが一致し、`conflict`でも`dormant`でもない場合だけ記録できる。Contextへ入れただけでは`applied`にしない。

Evaluationは`applied`を起点に、その正確なVersionと同じRunの客観結果または明確なユーザー修正だけを評価する。予測結果と因果効果を分け、`supported`、`refuted`、`indeterminate`を保存する。沈黙やRun完了だけを裏付けにしない。反証時は対象Versionを新Versionで`conflict / limited`にし、次の通常判断から除外する。

## 10.4 Version・Curator・コスト制御

Resourceの編集、訂正、Scope変更、復元はResource単位の不変Version履歴を通す。過去Versionは`learning-history/`に保存し、復元は古い内容を元にした新Versionを作る。複数ResourceをArchiveする前の復旧にはWorkspace Snapshotを使う。通常のhard deleteはしない。

Curatorは定期的な全件掃除ではない。置き換え、反証、環境変化、ユーザーの整理・復元・Archive指示という理由がある時だけ動く。固定日数や未使用だけでArchiveせず、pinned Resourceを自動Archiveしない。

候補がないRoomでは追加AIを呼ばない。候補はRoom単位で処理し、通常は安価な補助モデルを使う。学習はSettingsで完全停止でき、過去7日間の通常Run使用量に対する比率を予算として設定できる。予算超過は候補を`deferred`にするだけで、通常会話を止めない。通貨とTokenの値を混ぜて比較しない。

経験則から危険操作や権限を許可してはならない。既存の確認・権限経路を常に使う。

---

# 11. 共通EventとWorkspace正本

> **共通Eventは、Samurai Agentの内外で起きた活動を表す共通言語である。**

Eventを生成する主体は、次の4種類とする。

```text
Eventの出所
├── Human
├── Agent
├── External
└── System
```

- Human: 人による会話や操作
- Agent: Agentによる発言や実行
- External: 外部アプリやWebhookからの入力
- System: Workflow・Automation・Schedulerなどの内部処理

## 11.1 Eventの基本的な流れ

```text
Human・Agent・External・System
                ↓
             共通Event
                ↓
├── 出所を確認
├── Workspaceを確認
├── Roomを確認
├── 権限を確認
└── Eventの形式を確認
                ↓
        Activity Historyへ保存
```

Eventが受理されたことは、その内容がKnowledgeとして正しいことを意味しない。

```text
Eventとして受理
        ≠
Knowledgeとして採用
```

Knowledgeへ反映する場合は、別途Learningを通じて判断する。

## 11.2 BuzzがNostr Relayを土台にする意味

BuzzにおけるNostrの本質は、単にNostr形式の通信を採用していることではない。

Relayを、次の共通境界として扱っていることに価値がある。

### 全員が同じ活動記録を残す

人・Agent・Workflow・外部接続の活動が、同じEvent形式になる。

```text
誰が
いつ
何をしたか
どの種類の活動か
改ざんされていないか
```

メッセージ・リアクション・Workflow・成果物更新などを、同じEvent契約で保存・検索・配信できる。

### 身元と出所がアプリから独立する

Eventは送信者の公開鍵と署名を持つ。

そのため、特定アプリのユーザーIDではなく、Eventそのものが「誰から来たか」を証明できる。

Agentの実行環境が変わっても、同じ鍵・名前・活動履歴を継続できる。

### 送信側と受信側を分離する

送信側は、受信側の内部APIを直接知る必要がない。

受信側も、送信者ごとに個別接続を作らず、必要なEventを購読できる。

```text
Eventを送る
        ↓
      Relay
   ↙    ↓    ↘
人   Agent   Workflow
```

### Workspaceを自己所有できる

Relayを活動履歴・Identity・検索・配信の中心に置くことで、一つのWorkspaceを自分の環境で管理できる。

ただし、BuzzのRelayはP2P型の完全分散システムではない。

一つのRelayを中心とした、自己所有可能な中央システムとして理解する。

## 11.3 Samurai Agentで価値を残す条件

Samurai Agentでは、次の3つを別々の責務として扱う。

| 責務 | 本質的な役割 |
|---|---|
| Event Core／Relay | 誰が何をしたかを受け取り、保存・配信する |
| Gateway | Slack・メールなどを共通Eventへ変換する |
| Domain API | その操作をWorkspaceへ反映してよいか判断する |

これらを、必ず3つの独立システムとして順番に並べる必要はない。

```text
Nostr対応アプリ ───────────┐
                          ↓
外部アプリ → Gateway → 共通Event Core
                          ↓
                      Domain API
                          ↓
                   Workspace正本
                          ↓
                    結果Eventを配信
```

Nostr対応アプリはGatewayを通さず、Event Coreへ直接接続できる。

初期段階では、Event Core・Gateway・Domain APIをSamurai Core内部の別責務として実装できる。

## 11.4 Nostrを飾りにしない

次を守ることで、BuzzがNostrを採用する本質的な価値をSamurai Agentにも残せる。

- Eventの署名・出所・IDを途中で失わない
- Human・Agent・External・Systemが同じEvent契約を使う
- 外部ClientがEventを送信・購読できる
- Activity Historyを後から検索・追跡できる
- Domain APIで処理した結果もEventとして外へ戻す
- Samurai専用Clientを使わなくても共通プロトコルへ接続できる

反対に、Nostr Eventを受信してすぐ独自API形式へ変換し、署名・ID・Event履歴を捨てるなら、Nostrを使う価値はほとんど残らない。

> **Nostrの価値は、Relayを増やすことではなく、署名付きEventをSamurai固有APIより上位の共通契約にすることにある。**

## 11.5 共通形式と共通の意味は別である

Nostr形式を採用しても、すべての外部アプリがSamurai独自Eventの内容を理解できるわけではない。

```text
共通の封筒
└── Nostr形式で実現できる

中に書かれた意味
└── 公開されたEvent仕様が必要
```

Samurai独自Eventを外部から利用可能にする場合は、Event kind・内容・権限・互換性を公開仕様として定める必要がある。

## 11.6 Nostrの採用範囲

Nostrは、共通Eventを外部とやり取りするための有力な候補である。

ただし、Samurai Agent内部のすべてをNostr Eventだけで保存する必要はない。

```text
Nostr的な共通Event
└── 外部と話すための共通言語

Workspace
└── Knowledge・成果物・権限・履歴を管理する正本
```

Nostrを正式採用する範囲は、今後の要検討事項とする。

---

# 12. Agent・Backend・Compute

> **Agentは継続する役割、Backendは交換可能な実行エンジン、Computeは実際に動く場所である。**

```text
Agent
├── 名前・役割・指示
├── 利用権限
├── 利用できる情報・能力
│
├── Backend
│   ├── Codex
│   ├── Claude
│   └── Local Model
│
└── Compute
    ├── 自分のPC
    ├── チームのサーバー
    └── Cloud VM
```

## 12.1 Agent

Agentは、Workspaceに所属し、許可されたRoomで活動する。

Agentが保持するのは、誰として何を担当し、どの情報や能力を使えるかという設定である。

Agent自身が独立した保存媒体を所有するわけではない。

## 12.2 Backend

Backendは、Agentの仕事を実際に考え、実行する部分である。

BackendをCodexからClaudeへ交換しても、次のものは変わらない。

- Agentの名前
- Agentの役割
- Roomへの参加権限
- Agent向けの情報
- 過去の活動とのつながり

永続的にAgentのBackendを変える操作は`agent.backend.bind`だけとする。`chat.turn.run`の`backend_id`は既存呼び出し向けの一回限りの互換入力であり、Agent設定を書き換えない。

Backend Sessionは`Room + Session + Agent + Backend`ごとに分ける。Agentの名前・役割・指示はBackendへ補助的なContextとして渡すが、System・所有者・現在のユーザー依頼より強い命令にはしない。

## 12.3 Compute

Computeは、Backendが実際に動く実行環境である。

ComputeはAgentへ固定せず、Workspaceが登録・管理し、RoomやAgentへ利用権限を渡す。

```text
RoomでAgentを呼ぶ
        ↓
Agentの権限を確認
        ↓
Backendを選ぶ
        ↓
利用可能なComputeで実行
        ↓
結果をEventとしてWorkspaceへ戻す
```

機密性の高いRoomではローカルComputeだけを使うなど、Roomごとに制限できる構造を目指す。

共有Computeの具体的な実装方式は、今後の要検討事項とする。

---

# 13. 保存とポータビリティ

> **Workspaceにまとめて保存し、人とAgentが特定サービスに依存せず持ち運べる状態を作る。**

## 13.1 保存の基本方針

すべての情報は、最終的にWorkspaceへ保存する。

```text
Workspace
├── 人が読めるファイル
├── SQLiteなどの管理情報
├── Activity History
├── 権限・利用範囲
└── 出所・変更履歴
```

- Knowledge・Memory・Skillなどの本文は、人が確認・編集できる形式を優先する
- 検索・状態・履歴・実行管理にはSQLiteなどを利用する
- 同じ情報について、どちらが正本なのかを明確にする

## 13.2 一括管理の目的

Workspaceへまとめて保存することで、次が可能になる。

- 一括Backup
- Export
- Restore
- 検索
- Backendの交換
- 別環境への移行
- 情報の利用範囲変更

## 13.3 保存と公開を分ける

WorkspaceのBackupには、Workspace内の情報がまとめて含まれる。

ただし、通常の画面や検索では、権限のある情報だけを表示する。

Restore時には、次の情報も一緒に復元する。

- Roomとの関係
- 閲覧・利用権限
- Eventの出所
- Activity History
- Knowledgeの利用範囲

---

# 14. ユーザー体験

> **表側はRoom中心でシンプルに、裏側はWorkspaceが一括管理する。**

## 14.1 Workspace画面

Workspace画面は、全体を所有・管理する場所として見せる。

```text
Workspace画面
├── Rooms
├── Agents
├── 閲覧可能な情報
├── メンバー・権限
├── 外部接続・Compute
└── Backup・Export
```

Workspaceに保存されたすべてを、無条件に表示する画面ではない。

## 14.2 Room画面

日常的に利用する中心画面はRoomである。

```text
Room画面
├── 人とAgentの会話
├── Sessions
├── Roomで利用する情報
├── Artifact・Collection
└── External・System Event
```

- 人とAgentには名前とアイコンを表示する
- External EventとSystem Eventは、人やAgentの発言と見分けられるようにする
- Personal／Sharedというモード切替は作らない
- 人を招待すれば、同じRoomがそのまま共同利用へ変化する

## 14.3 Chat-firstとUI on demand

Chatを継続的な主要インターフェースとする。

文書・表・グラフ・Collectionなどは、必要なときだけ操作画面として表示する。

```text
Chat
   ↓ 必要なとき
Artifact・Table・Form・Graphなどの画面
```

Backend・Compute・Event処理などの内部構造は、通常の利用時には意識させない。設定・問題確認・高度な操作のときだけ表示する。

---

# 15. 参照プロジェクトから取り入れるもの

Samurai Agentは、特定の参照プロジェクトをそのまま再現するものではない。

それぞれの強みを、Workspace中心の構造へ組み直す。

## 15.1 OpenClaw

OpenClawは、個人用AIアシスタントを複数の外部チャネルへ常時接続するGateway構造に強みがある。

Samurai Agentでは、次を参考にする。

- 外部チャネルとの接続
- Sessionの振り分け
- 常時稼働するGateway
- ローカル環境との接続
- 複数Backend・AgentへのRouting

ただし、GatewayをWorkspace正本にはしない。

公式: <https://github.com/openclaw/openclaw>

## 15.2 Hermes Agent

Hermesは、Agent自身が経験からMemoryとSkillを改善する学習ループに強みがある。

Samurai Agentでは、次を参考にする。

- 経験からのMemory抽出
- Skillの作成と改善
- Reflection
- Curator
- 過去Sessionの検索と再利用

HermesがAgent単位で育てるものを、SamuraiではWorkspace・Room・Agentの利用範囲へ拡張する。

公式: <https://hermes-agent.nousresearch.com/docs/>

## 15.3 MulmoClaude

MulmoClaudeは、人とAIが扱えるWorkspaceと、ファイルとして残る成果物の構造に強みがある。

Samurai Agentでは、次を参考にする。

- ファイル中心のWorkspace
- Knowledge Wiki
- Artifact
- Collection
- Skill
- 会話から必要な画面を表示する仕組み

ただし、Claude Codeを固定の実行部にせず、交換可能なBackendとして扱う。

公式: <https://github.com/receptron/mulmoclaude>

## 15.4 Buzz

Buzzは、Room／Channelを中心とした共同活動と、Nostr形式の共通Eventに強みがある。

Samurai Agentでは、次を参考にする。

- 人とAgentを同じ活動面に置く
- 共通Event
- 署名付きIdentity
- Room単位の権限
- Eventの購読と配信
- 共有Compute

ただし、SamuraiではEventだけを正本にせず、Knowledge・Skill・ArtifactなどをWorkspaceへ残す。

公式OSS: <https://github.com/block/buzz.git>

## 15.5 Type.com

Type.comは、Knowledge・Integration・Skillを共有Spaceへ集め、CodexやClaude Codeで行った仕事をチームへ持ち込む製品体験に強みがある。

Samurai Agentでは、次を参考にする。

- Knowledge・Integration・Skillをまとめる共有Space
- CodexやClaude Codeから文書・Skill・Sessionを持ち込む導線
- 人とAIが同じ場所で共同作業する見せ方
- TeamやChannel単位で外部接続の利用範囲を分ける考え方
- 共有Memoryを別のAIから検索・再利用する体験

Type.comはOSSではない。公開Webサイトから確認できる製品体験だけを参照し、内部構造や実装方式を推測しない。

公式: <https://type.com/>

---

# 16. Samurai Agent独自の統合

Workspace・Room・Agentという階層や、チャット形式のUI自体はSamurai Agentだけのものではない。

Samurai Agentの中心価値は、それらを**Workspace所有の学習ループ**で接続することにある。

```text
Roomで人とAgentが活動
        ↓
共通Event・Activity History
        ↓
Memory
        ↓ Learning
Knowledge・Skill
        ↓
次のSessionで再利用
        ↓
Artifact・Collectionが生まれる
        ↓
すべてWorkspaceへ戻る
```

## 16.1 Samurai Agentが目指す状態

- 人やAgentが変わっても経験が残る
- Backendを交換してもKnowledgeが失われない
- Roomごとに必要な文脈を分離できる
- 必要なKnowledgeだけをAgentへ渡せる
- 人がKnowledgeやSkillを確認・編集できる
- WorkspaceごとBackup・Export・Restoreできる
- 外部アプリも共通Eventで活動へ参加できる

## 16.2 参照プロジェクトとの関係

```text
OpenClaw
└── 外部との入口

Buzz
└── 人・Agent・外部をつなぐ活動基盤

Hermes
└── 経験を再利用可能にする学習ループ

MulmoClaude
└── Knowledgeや成果物を残すWorkspace

Type.com
└── 共有Spaceと既存Agent作業の持ち込み方
```

Samurai Agentは、これらを次の流れとして統合する。

```text
外部とつながる
↓
Roomで活動する
↓
経験から学ぶ
↓
Knowledgeと仕組みを残す
↓
別のAgent・Backendでも再利用する
```

---

# 17. 現状実装との差分

現在のSamurai Agentには、すでに次の基盤が存在する。

- Workspace保存基盤
- filesystemとSQLiteの正本分離
- Session・Backend Run・Backend Event
- Memory
- Knowledge Wiki
- Skill
- Artifact
- Collection
- 共通Domain Operation
- Backup・Restore
- Chatと必要時に開く管理画面

一方、今回再定義した構造には、まだ実装されていない部分がある。

## 17.1 主な追加・変更対象

```text
現在
└── 個人Workspace中心

今後
└── Workspace
    ├── 人と役割
    ├── Agents
    ├── Rooms
    │   └── Sessions
    ├── 情報ごとの利用範囲
    └── 共通Event
```

主な差分は以下。

- Workspace／Roomのメンバーと権限
- Agentを継続的な参加者として扱う構造
- AgentとBackendの分離
- Workspace／Room／Agentごとの情報範囲
- Roomを中心としたUI
- Human／Agent／External／SystemのEvent出所
- Nostr対応を含む共通Event Core
- Computeの登録・共有・制限
- 複数範囲を扱う学習ループ

## 17.2 既存Memoryの再整理

現在のMemoryには、個人理解・重要ルール・教訓・作業手順など、複数の役割が含まれている。

今後は次のように整理する。

```text
経験・決定・個人理解
└── Memory

再利用できる知恵・判断
└── Knowledge

繰り返し使える手順
└── Skill
```

既存Memoryを削除するのではなく、役割を整理し直す。

## 17.3 既存資産を壊さない

今回の再定義は、既存実装をすべて作り直すことを意味しない。

既存のWorkspace Store・Domain API・Backend cassette・各種リソースを残しながら、新しい利用範囲と権限を段階的に追加する。

---

# 18. 未決定事項

以下は、現時点では方向性だけを決め、詳細を確定しない。

## 18.1 情報の配置

- MemoryをWorkspace／Room／Agentへどう配置するか
- Skillを誰へ割り当てるか
- Artifact・Collectionの標準利用範囲
- Agent向け情報とRoom情報の境界

## 18.2 学習ループ

- 何を自動的に学習するか
- どこで人へ明示確認するか
- Knowledgeを別の範囲へ昇格する条件
- 誤学習・競合・重複の処理
- 評価・統合・取消方法

## 18.3 共通Event

- Nostrを正式採用する範囲
- Samurai独自Eventの公開仕様
- Eventの保存期間
- Activity Historyと監査履歴の関係
- Event Coreをどこまで外部公開するか

## 18.4 権限

- Workspace Owner／AdminとRoom内容の関係
- Guestの利用範囲
- Agentへ渡せる情報の制限
- 外部アプリの認証・署名・失効
- Backup管理権限と内容閲覧権限の分離

## 18.5 Compute

- ローカル・クラウド・共有Computeの登録方法
- Roomごとの利用制限
- 機密情報を扱えるComputeの条件
- 実行量・費用・優先順位の管理
- AgentとComputeの割り当て方法

## 18.6 移行

- 既存Workspaceを新構造へ移す方法
- 既存Memoryの分類し直し
- Knowledge Wikiへの利用範囲追加
- 現在のSessionをRoomへ所属させる方法
- 既存Backupとの互換性

未決定事項は、実装時に暗黙の判断で埋めず、個別の設計として合意してから進める。
