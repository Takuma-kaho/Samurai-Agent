# Samurai Agent Public Naming

## 0. 目的

この文書は、README、UI、API、route、package、DB、設定値など、公開面で使う名称を固定する正本である。

参照元の固有名は設計資料では使えるが、公開面の中心には置かない。

---

## 1. 製品の定義

正式な説明は次を使う。

> **Samurai Agentは、AI-native Knowledge Workspaceです。**

日本語では次のように説明する。

> **人間の知識を一か所に集め、普段のアプリから届く経験をAIが整理・成長させるWorkspaceです。**

Samuraiの中心を「単一Agent」「Chatアプリ」「AIチーム」と表現しない。

---

## 2. 基本用語

| 公開用語 | 意味 |
| --- | --- |
| Workspace | 人間のKnowledgeを保管する正本 |
| Workspace Server | Workspaceを提供するPostgreSQLベースのServer |
| Room | Knowledge、共有、閲覧権限を分ける境界。Workspaceの下で同じRoomを階層化できる |
| Account | 公開鍵に結び付いた、Server間で再利用できる本人識別子 |
| Native App | SamuraiのChat、Session、Surfaceを提供する外部アプリ |
| External App | Codex、Claude Codeなど、Workspaceを利用する外部アプリ |
| Session | アプリ側の会話・作業単位 |
| Activity History | 指示、結果、変更、検証、出所をまとめた構造化証拠 |
| Episode | 関連するActivityをまとめる作業単位 |
| Knowledge Host | Activityを整理し、Knowledge・Skillを育てるバックエンド役 |
| Agent | 継続する役割と権限を持つ参加者 |
| Agent Backend | Agentが作業を実行する交換可能なBackend cassette |
| Knowledge | `fact`、`decision`、`explanation`、`experience_rule`に分ける再利用知識 |
| Skill | `SKILL.md`を入口に必要な補助ファイルを読む再利用手順 |
| Policy | 認証済みの人間操作でだけ有効化する操作制約 |
| PROFILE / SOUL | 人間が明示更新するWorkspace文書 |
| Curator | 根拠を保ったまま整理候補を出すバックグラウンド処理 |
| Artifact | 文書、コード、表、画像などの成果物 |
| Collection | 顧客、案件、タスクなどの構造化データ |
| Surface | 必要な時だけ表示する操作・閲覧面 |
| Gateway | 外部アプリやAutomationの接続境界 |

---

## 3. 用語の責務

### Workspace

「作業画面」ではなく「知識の保管庫」と説明する。

### Workspace Server

HostedとSelf-hostで同じWorkspace仕様を提供するServerと説明する。Hostedの共有DBとSelf-hostの専用DBは、提供形態の違いであり、Workspaceの責務を変えない。

### Account

AccountはRoom権限そのものではない。公開鍵で本人を確認する識別子であり、Owner・Admin・Member・Guestの権限はWorkspaceとRoomで別に決まる。

### Room

「チャットルーム」「AIチームの活動場所」と説明しない。「Knowledgeとアクセス範囲を分ける場所」と説明する。RoomはWorkspace直下または別Roomの下に置けるが、親子間でKnowledgeや閲覧権限を自動共有しない。

### Session

Workspaceの構成要素ではなく、Native AppやExternal Appが持つ会話・作業履歴として説明する。

### Episode

Sessionと同一視しない。関連するActivityのまとまりとして説明し、Sessionは必要なら出所参照として残す。

### Policy

Knowledgeの検索結果やAIの学習候補ではない。「認証済みの人間操作でだけ有効化する操作制約」と説明する。AIや外部接続が任意の署名文字列で有効化できるものとは説明しない。

### PROFILE / SOUL

AIが自動で書き換えるものとは呼ばない。「人間が明示操作で更新するWorkspace文書」と説明する。

### Chat-first

Samurai全体のCore原則ではない。Native AppのUI方針として使う。

### Native App

Workspaceの所有者や特別な内部Agentではない。「Workspaceと最も互換性の高い外部アプリ」と説明する。

### AgentとAgent Backend

Agentは「誰として、どのKnowledgeにアクセスするか」。Backendは「どの実行エンジンで処理するか」。

### Workspace Job

内部設計用語。公開面では、必要に応じて「AI処理」「Knowledge整理」「バックグラウンド処理」と言い換える。

---

## 4. 推奨表現と避ける表現

| 推奨 | 避ける |
| --- | --- |
| AI-native Knowledge Workspace | Personal Agent Interfaceを製品全体の主定義にする |
| WorkspaceにKnowledgeが残る | Chatに記憶が残る |
| Roomで共有範囲を分ける | RoomでAIチームが常時活動する |
| Activityを整理してKnowledgeにする | 全会話をそのまま学習する |
| Native AppからWorkspaceを使う | Workspace内にNative Appを埋め込む |
| Backendを交換できる | ClaudeやCodexがWorkspaceの正本になる |
| 必要な時だけSurfaceを表示する | Workspaceが固定ダッシュボードになる |

---

## 5. 参照元固有名

次の名前は、設計・比較・出典の文脈では使用してよい。

- MulmoClaude
- Hermes Agent
- Buzz
- Type.com
- Claude Code
- Codex
- Nostr

次の公開面では、参照元固有名を製品の機能名・API名・DB名・設定キーとして使わない。

- README
- UI文言
- APIとroute
- package名
- database table / column
- env / config key

Nostr、Relay、署名Eventは、将来のGateway接続候補として説明する。Samuraiの正本や必須イベント形式として説明しない。

---

## 6. 命名チェック

公開面を変更する前に確認する。

- WorkspaceがKnowledgeの正本になっているか
- Memoryを現行のKnowledge種類やUI機能名として出していないか
- Roomを会話場所として説明していないか
- SessionをWorkspaceの必須要素として説明していないか
- Chat-firstの範囲がNative Appに限定されているか
- Native Appを特別なWorkspace領域として扱っていないか
- AgentとBackendを混同していないか
- 参照元固有名が公開面へ漏れていないか
