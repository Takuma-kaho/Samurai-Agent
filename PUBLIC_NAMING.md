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
| Room | Knowledge、共有、閲覧権限を分ける境界 |
| Native App | SamuraiのChat、Session、Surfaceを提供する外部アプリ |
| External App | Codex、Claude Codeなど、Workspaceを利用する外部アプリ |
| Session | アプリ側の会話・作業単位 |
| Activity History | 指示、結果、変更、検証、出所をまとめた構造化証拠 |
| Knowledge Host | Activityを整理し、Knowledgeを育てるバックエンド役 |
| Agent | 継続する役割と権限を持つ参加者 |
| Agent Backend | Agentが作業を実行する交換可能なBackend cassette |
| Memory | 再利用する短い個人・Roomの理解 |
| Skill | 再利用する作業手順 |
| Artifact | 文書、コード、表、画像などの成果物 |
| Collection | 顧客、案件、タスクなどの構造化データ |
| Surface | 必要な時だけ表示する操作・閲覧面 |
| Gateway | 外部アプリやAutomationの接続境界 |

---

## 3. 用語の責務

### Workspace

「作業画面」ではなく「知識の保管庫」と説明する。

### Room

「チャットルーム」「AIチームの活動場所」と説明しない。「Knowledgeとアクセス範囲を分ける場所」と説明する。

### Session

Workspaceの構成要素ではなく、Native AppやExternal Appが持つ会話・作業履歴として説明する。

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
- Roomを会話場所として説明していないか
- SessionをWorkspaceの必須要素として説明していないか
- Chat-firstの範囲がNative Appに限定されているか
- Native Appを特別なWorkspace領域として扱っていないか
- AgentとBackendを混同していないか
- 参照元固有名が公開面へ漏れていないか
