# Samurai Agent Product

## 0. この文書の役割

この文書は、Samurai Agentの製品定義、判断基準、概念、公開用語をまとめる**製品正本**である。

設計正本は次の2つだけとする。

1. `PRODUCT.md`：なぜ作るか、何を作るか、何と呼ぶか
2. `ARCHITECTURE.md`：どう分解し、どう接続し、どう守るか

UI資料、計画、進捗台帳、完了レポート、参照OSS資料は補助資料であり、正本ではない。正本と矛盾する場合は、この文書、次に`ARCHITECTURE.md`を優先する。

---

## 1. 製品の定義

> **Samurai Agentは、Native App、Workspace Core、Runtime、外部接続を一体で提供する、ユーザー所有のAI-native Workspaceである。**

人間はSamurai Native Appに加え、Codex、Claude Code、Cursor、CLIなど複数の環境で仕事をする。SamuraiはNative AppとWorkspace Coreを別製品にせず、一つの製品として提供する。外部アプリはそのWorkspaceへ接続する利用経路である。

Workspaceに届いた経験は、出所と根拠を保ったActivityとして記録され、関連するActivityはEpisodeとして整理される。Knowledge HostはActivityとEpisodeをKnowledge、Knowledge Wiki、Skillへ整理する。利用するBackendや外部アプリを交換しても、Knowledge、判断履歴、成果物はユーザーのWorkspaceに残る。

Samuraiは汎用Agent Backendそのものを再発明しない。一方で、Native Appからの操作、Workspaceの管理、必要な実行、学習、復旧までを一つの製品体験として提供する。価値の中心は次の3点である。

- 特定のプロバイダーに依存しないKnowledgeの所有権
- Room単位でKnowledgeを混ぜずに管理できる制御性
- 異なるBackendやアプリ間で経験を引き継げる相互運用性

---

## 2. 製品の基本原則

### 2.1 WorkspaceがKnowledgeの正本

- Workspaceは人間または組織が所有する。
- Agent、モデル、Backend、利用アプリを交換してもKnowledgeは残る。
- Backup、Export、Restore、移転はWorkspace単位で考える。
- WorkspaceはChatやNative Appの所有物ではない。

### 2.2 RoomはKnowledgeと権限の境界

- RoomはKnowledgeを分け、誰が見られるかを決める境界である。
- RoomはチャットルームやAIチームの活動場所ではない。
- 親子Roomは整理上の階層であり、Knowledge、検索、AI Context、権限を自動継承しない。
- 子Roomの直接メンバーは、すべての親Roomにも直接参加している必要がある。
- 他RoomのKnowledgeは、明示的な共有、Copy、Move、昇格なしに利用しない。

### 2.3 ActivityとEpisodeは証拠、Knowledgeは再利用物

- Activityは、指示、結果、変更、検証、失敗、修正、出所を構造化して残す。
- Episodeは、同じ目的や出来事に関係するActivityをまとめる。
- 会話全文や内部思考はWorkspaceの必須保存対象にしない。
- Activityを保存しただけでKnowledgeになったとは扱わない。
- Knowledge変更には根拠、Version、変更履歴を残す。

### 2.4 チームAgentは参加者、Workspaceは所有者

- Agentは役割と権限を持ち、許可されたRoomのKnowledgeを利用する。
- RuntimeやBackendは短期ContextやCacheを持てるが、Workspace Knowledgeの正本にはしない。
- Backendは交換可能な実行エンジンであり、Knowledgeの所有者ではない。
- Native AppはSamuraiの公式製品面であり、外部アプリも同じWorkspace Coreへ接続する。
- ClientとCoreはシステム上分離するが、別製品や別のKnowledge領域として扱わない。

### 2.5 実行とKnowledgeの成長を一つの循環にする

- SamuraiのRuntimeは、Native Appと外部接続から必要な処理を安全に実行し、結果、失敗、取消、復旧を記録する。
- Knowledge Hostは実作業を担当するチームAgentではなく、ActivityとEpisodeから学習ループを動かす内部責務である。
- チームの一員として見えるAgentの役割、操作方法、実行範囲はNative App設計で決める。現時点では特定の体験や自律動作を正本で固定しない。

---

## 3. 基本の利用ループ

~~~mermaid
flowchart LR
  AppA["Native App / External App"]
  Activity["Activity・実行証拠"]
  Review["整理・抽出・照合"]
  Draft["同じRoomの暫定Knowledge"]
  Evaluate["利用・検証・人間の修正"]
  Knowledge["Knowledge Wiki / Knowledge / Skill"]
  AppB["次の処理 / Backend / App"]

  AppA --> Activity
  Activity --> Review
  Review --> Draft
  Draft --> Evaluate
  Evaluate --> Knowledge
  Knowledge --> AppB
  AppB --> Activity
~~~

Samuraiの完成した体験は、単にKnowledgeを保存できることではない。異なる処理、Backend、アプリ間で次の循環が閉じることである。

1. Native Appまたは外部アプリがWorkspaceのKnowledgeを利用する
2. 指示、結果、変更、検証、失敗をActivityとして戻す
3. Knowledge Hostが同じRoom内で整理する
4. 人間の修正や機械検証を含めて評価する
5. 更新されたKnowledgeを次の処理、Backend、アプリが再利用する

---

## 4. 主要概念

| 概念 | 役割 | 所有者・正本 |
| --- | --- | --- |
| Workspace | Knowledgeと証拠を保管・移転する単位 | 人間・組織 |
| Workspace Server | HostedまたはSelf-hostでWorkspaceを提供するServer | Deployment |
| Account | Server間で再利用できる人間の安定した本人識別子 | 人間 |
| Room | Knowledge、共有、閲覧権限の境界 | Workspace |
| Session | 会話・作業と実行を関連付ける単位。表示状態とCore記録は分ける | Client / Workspace Core |
| Activity History | 作業の構造化証拠 | Workspace / Room |
| Episode | 関連するActivityのまとまり | Workspace / Room |
| Knowledge | 再利用する事実、判断、説明、経験則 | Workspace / Room |
| Knowledge Wiki | KnowledgeをMarkdownページ、リンク、検索、履歴として扱う主要方式 | Workspace / Room |
| Skill | `SKILL.md`と補助ファイルからなる再利用手順 | Workspace / Room |
| Policy | 認証済みの人間操作で有効化する操作制約 | Workspace / Room |
| PROFILE / SOUL | 人間が明示更新する方針・人格文書 | Workspace |
| Artifact | 文書、コード、表、画像などの成果物 | Workspace |
| Collection | 顧客、案件、タスクなどの構造化データ | Workspace / Room |
| Surface | 必要な時だけ表示する操作・閲覧面 | App側の投影 |
| Agent | チームの一員として役割とRoom権限を持つ参加者。具体的な製品体験は未決定 | Workspaceの認可対象 |
| Backend | Runtimeから利用する交換可能な実行エンジン | 実行環境 |
| Runtime | 実行受付、Backend接続、Event、取消、再開、復旧を扱う内部基盤 | Samurai Core側 |
| Knowledge Host | ActivityとEpisodeを整理し学習ループを動かす内部責務 | Workspace Core側 |
| Curator | 根拠を保ったまま整理・統合候補を作る処理 | Workspace Core側 |
| Gateway | 外部アプリ、Automation、CLIの接続境界 | Workspace Core側 |

### Knowledgeの種類

Knowledgeは次の4種類に分ける。

- `fact`：確認可能な事実
- `decision`：採用した判断と理由
- `explanation`：理解や説明
- `experience_rule`：経験から得た再利用可能なルール

Memoryは独立した公開Resource種類として使わない。従来Memoryと呼んでいた内容は、経験のまとまりをEpisode、再利用する知識をKnowledgeとして表現する。Activityはその根拠、Skillは再利用手順である。RuntimeやBackendが持つ短期ContextやCacheは派生データであり、Workspaceの正本ではない。

Knowledge WikiはKnowledgeと競合する別概念ではない。Knowledgeを人間が読めるMarkdownページとして蓄積し、リンク、検索、編集、Version、Evidenceとともに長期利用するための方式である。

---

## 5. 学習と教え込み

### 5.1 自動処理

Knowledge Hostは、重要なActivityの後に同じRoom内のActivityとEpisodeを整理できる。

対象にできるもの。

- 確認済みの完了
- 検証済みの結果
- 原因を確認した失敗と復旧
- 人間による訂正
- 明示的な保存・教え込み
- 正式な成果物の完了
- 既存Knowledgeを利用した後の評価

自動学習しないもの。

- 未解決の失敗
- キャンセルや途中処理
- 推測だけの内容
- 単発の中間Tool call
- 根拠のない会話

AIが作るKnowledge、Knowledge Wikiの変更、Skillは、Evidence、Confidence、Job、Attempt、Versionを持つ`provisional`として同じRoomへ保存する。自動処理は、他Roomへの共有やWorkspace全体への昇格を行わない。

### 5.2 明示的な教え込み

利用者は、操作、成果物、訂正、判断理由を示して、KnowledgeやSkillとして保存させられる。

例。

- 「この成果物から次回の手順を作る」
- 「この修正を今後の判断基準として保存する」
- 「この操作を再利用可能なSkillにする」

これはBackendや内部処理が勝手にMemoryを所有する機能ではない。利用者がWorkspaceを育てるための入力方法である。

### 5.3 更新と固定

- 人間が編集したことだけでは、将来の更新を禁止しない。
- AI更新を禁止するのは、利用者が明示した`fixed`だけである。UIでは固定やPinとして表現できる。
- 新しい根拠が既存Knowledgeと矛盾する場合、既存内容を消さずConflictとして両方を残す。
- Workspace全体への昇格、Room間共有、削除・統合、権限変更、機密情報の採用は明示操作にする。
- PROFILE／SOULは学習結果から自動更新しない。

利用者の行動は観測材料であり、絶対的な正解ではない。推定した好みや判断基準は暫定Knowledgeとして扱い、利用者が明示した方針と区別する。

---

## 6. Native Appの位置づけ

Native Appは、Workspace CoreとRuntimeを利用者へ届けるSamuraiの公式製品面である。ClientとCoreは保守性、安全性、複数接続のために分離するが、利用者には一つの製品として提供する。

主な役割。

- RoomとKnowledgeの管理・可視化
- Activity、Evidence、Conflict、Versionの確認
- 操作や成果物からの教え込み
- Knowledge、Skill、Artifact、Collectionの編集
- Connection、権限、Export、Restoreの管理
- 必要な時のChat、処理実行、Surface表示

Chatは操作入口の一つである。チームAgentの見せ方や実行体験はNative App設計で決めるため、この正本では固定しない。利用者はNative Appを閉じている時でも、許可された外部アプリから同じWorkspaceを利用できる。

具体的な画面構成やVisual Designは`WEB_UI_DESIGN.md`を補助資料として扱い、この文書の責務境界に従う。

---

## 7. 外部アプリと中立性

Codex、Claude Code、Cursor、CLI、その他のClientは、MCP、API、Plugin、Adapterなどの正式入口からWorkspaceを利用する。

- 必要なRoomのKnowledgeを読む
- KnowledgeやSkillを使って外部で実行する
- 結果、変更、検証、失敗をActivityとして戻す
- 成果物や明示変更をWorkspaceへ保存する
- ConnectionやRoom権限が失効したら、次の操作から拒否する

GatewayやAdapterはWorkspaceへ直接書き込まない。認証、委任元、Room上限、入口上限を確認し、Domain Operation、Activity Ingest、Queryへ渡す。

Accountは本人識別だけを担い、WorkspaceやRoomの権限を自動取得しない。Nostr、Relay、署名EventなどのProtocolは将来の接続候補であり、Workspaceの正本や必須形式にしない。

特定のAgentに同等機能が追加されても、その機能を無理に再実装しない。実行結果をWorkspaceへ取り込み、別のAgentでも再利用できることを優先する。

---

## 8. 保存、正本、移転

Knowledge、Skill、Policy、PROFILE／SOULの本文は、人間が読めるファイルを内容の正本とする。Databaseは次を管理する。

- Resource identity
- Roomと権限
- Version、hash、Evidence
- Activity、Episode、Use、Evaluation
- Job、Audit、検索投影

本文をファイルとDatabaseの二重正本にしない。

Workspace Bundleは、Knowledge本文、Skill package、権限、Evidence、Version、Activity、必要な履歴を検証可能な形でExport・Restoreする。Token、private key、credential、raw model output、移転先固有のmaintenance identityは含めない。

Sessionの表示状態、入力途中の内容、NavigationなどのUI状態はClientが所有する。Workspace Coreは、Roomとの関係、実行、Activity、Evidence、再開、取消、復旧、検索に必要なSession記録を所有する。外部アプリ固有の会話全文は必須保存対象にせず、必要なSessionRefだけを残せる。

---

## 9. 公開用語

正式な製品定義は「ユーザー所有のAI-native Workspace」を使う。Knowledgeの所有、学習、移植性が中心価値であることを併記する。

推奨する説明。

> Native Appと普段のアプリから届く経験を一つのWorkspaceへ集め、AIが整理し、次の仕事へ再利用できる製品。

避ける表現。

- Roomを「チャットルーム」と呼ぶ
- SessionのUI状態や会話全文までWorkspaceの必須正本と説明する
- Samuraiを単一AgentやAIチーム製品として説明する
- Chatに記憶が残ると説明する
- 特定の参照OSS名をUI、API、route、package、DB、設定キーへ持ち込む

Hermes Agent、Buzz、OpenClaw、Claude Code、Codexなどの固有名は、比較、設計、出典の文脈だけで使用する。

---

## 10. 作らないもの

- Codex、Claude Code、Cursorと同じBackend機能を一から再実装すること
- ChatだけでKnowledgeが完結する製品
- Workspace内でAIチームが自律活動することを主目的にした製品
- Agentごとに独立したKnowledge正本を持つ設計
- 会話全文をWorkspaceへ強制保存する仕組み
- Room間のKnowledgeや権限を暗黙に共有する仕組み
- 根拠なしに通常Knowledgeを確定・上書きする学習
- SurfaceやUI状態をWorkspaceの正本にする設計
- 特定のモデル、Agent、プロバイダーへKnowledgeを閉じ込める設計

---

## 11. 完成を判断する基準

主要な縦切りは、次の流れで確認する。

> Native Appまたは外部アプリで作業 → Activityと証拠を回収 → Episodeとして整理 → Room内でKnowledge化 → 人間が修正 → 別の処理やアプリが再利用 → 結果を再評価

最低限確認すること。

- 許可されたRoomのKnowledgeだけを取得できる
- 他Room、親Room、兄弟RoomのKnowledgeが暗黙に混ざらない
- 失敗、推測、未検証結果が確定Knowledgeへ昇格しない
- 人間の訂正がVersionとEvidence付きで残る
- `fixed`のKnowledgeをAIが上書きしない
- Connection失効後の再利用が拒否される
- Agentやプロバイダーを変えても同じKnowledgeを利用できる
- Export・Restore後も本文、権限、Version、Evidenceが一致する
- 途中失敗、再試行、競合、復旧でも部分成功を残さない

Sourceが存在すること、静的・Focused Testが通ること、実Client・実Database・実OSで確認したこと、完成判定を通ったことは分けて報告する。未検証を完了扱いしない。

---

## 12. 未決定事項

- Native Appの具体的な画面構成とVisual Design
- チームAgentの役割、表示、操作方法、自律性、実行範囲
- 操作録画など、教え込み入力の具体方式
- 外部アプリごとの取得可能なActivity範囲
- Workspace全体へ昇格する詳細条件とUI
- 会話全文保存を許可する設定
- Computeの提供方式

未決定事項は、本文の所有権、Room境界、Backendと外部アプリへの中立性を崩さない範囲で決める。
