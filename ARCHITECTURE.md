# Samurai Agent Architecture v0.8

## Chat-first Personal Agent Interface

### Workspace-backed, UI on demand

### MulmoClaude型Host、Agent Backend cassette、Hermes的Memory/Skill改善ループ、OpenClaw中心のGatewayを参照して再構成する

---

## 0. この文書の位置づけ

この文書は、Samurai Agent の **最終アーキテクチャ構造の正本** である。

文書の役割は以下。

- `PRINCIPLES.md`: 設計思想、判断基準、前提。
- `ARCHITECTURE.md`: システム構造、責務、境界、データ流れ。
- `PUBLIC_NAMING.md`: 公開面の命名ルール。
- `plans/`: 実装順、レビュー、作業計画。

この文書では、実装順や短期計画ではなく、最終的にどういう構造であるべきかを記述する。

---

## 1. Reference Sources

この設計で参照するOSSと補助資料は以下。

| 参照対象 | 正式参照元 | この設計での扱い |
| --- | --- | --- |
| OpenClaw | `https://github.com/openclaw/openclaw.git` | Gateway / Session / Pairing / Sandbox / External boundary の参照元 |
| Hermes Agent | `https://github.com/NousResearch/hermes-agent.git` | Memory / Skill / Reflection / Self-improvement loop の参照元 |
| MulmoClaude | `https://github.com/receptron/mulmoclaude.git` | Host / Workspace state / Artifact / Collection / Renderer / Plugin composition の参照元 |
| Hermes Agent 解説 | `Hermes_Agent_解説.md` | Hermes Agent理解のローカル補助資料 |
| MulmoClaude記事 | `https://singularitysociety.org/articles/blog/2026-04-10-mulmoclaude/` | MulmoClaude理解の補助資料 |
| OpenClaw記事 | `https://unicornee.ai/articles/openclaw-ai-agent/` | OpenClaw理解の補助資料 |
| OpenClaw architecture guide | `https://eastondev.com/blog/ja/posts/ai/20260205-openclaw-architecture-guide/` | OpenClaw architecture理解の補助資料 |

| 参照元 | 役割 | Samurai Agentでの位置づけ |
| --- | --- | --- |
| MulmoClaude | Host / Workspace / Artifact / Collection / Plugin composition | 仕組みと状態構造の参照元。アプリ中心UXは完成形にしない |
| Hermes Agent | Memory / Skills / Reflection / Self-improvement loop | 育つAgent体験の中心 |
| OpenClaw | Gateway / Session routing / Pairing / Sandbox / External entry | 外部連携と運用境界の中心 |
| Claude Code / Codex | Agent Backend cassette | 実行部を固定しないための差し替え候補 |

---

## 2. Final Concept

Samurai Agent は、以下を目指す。

> **会話を中心に、外部Agentや自前Agentを差し替えながら、個人のWorkspace、Memory、Skill、Artifactを育てるPersonal Agent Interface。**

中核となる構造。

```text
Samurai Agent Host
  Chat / Surface / Workspace / Memory / Skill / Gateway
  AgentBackend cassette
    ClaudeCodeBackend
    CodexBackend
    SamuraiNativeBackend
    future external backends
```

このプロダクトは、単なるチャットAIでも、CLI AgentのGUIラッパーでも、特定Backend専用の管理画面でもない。

主語は、以下である。

> **人間とAIが同じ仕事状態を扱い、必要な操作面だけが会話から現れる個人用Agent Interface。**

---

## 3. Architecture Principles

思想の詳細は `PRINCIPLES.md` を正本にする。
この文書では、アーキテクチャ上の不変条件だけを扱う。

- Chatが継続的な主要インターフェースであり、UIは必要時だけ会話から現れる。
- Workspaceは、人間とAIが共有する永続状態の正本であり、常設の主画面ではない。
- Surface Protocolは、共通操作を受け取り、状態を端末に合う表現へ投影する双方向契約である。
- Agent Backendは固定せず、cassetteとして差し替え可能にする。
- MemoryとSkillは、外部Backendの中ではなくWorkspace側に残す。
- Backend eventは、UIや保存層へ出す前に正規化する。
- Artifact、Collection、Memory、Skillは、Workspaceへ戻る成果物として扱う。
- 外部接続の境界は、BackendまたはGatewayのedgeに置く。

---

## 4. System Overview

全体構造。

```text
[Chat / Gateway / Surface Input]
Web Chat / Desktop / Future Mobile / Slack / LINE / Email / Webhook / Cron / on-demand UI operation

        ↓

[Samurai Agent Host]
Session / Intent / Context / Active Memory / Skill Selection / Backend Routing

        ↓

[AgentBackend Registry + Cassette]
ClaudeCodeBackend / CodexBackend / SamuraiNativeBackend / future external backends

        ↓

[Common Domain Operation]
Human surface operation / Agent tool call / Gateway input / Automation

        ↓

[Workspace-backed State]
Artifact / Collection / Memory / Skill / Session / Workspace change / History

        ↓

[Presentation Selection + Surface Protocol]
text / markdown / artifact / form / table / chart / custom view / no additional UI

        ↓

[On-demand Surface]
Chat inline result / Artifact Card / Workspace Peek / Context Drawer / device fallback
```

主要なデータ流れ。

```text
User asks through Chat / Gateway
↓
Host builds intent and session context
↓
Active Memory retrieval + Skill selection
↓
AgentBackendRegistry selects backend
↓
Backend cassette runs and events are normalized
↓
Common Domain Operation updates Workspace state
↓
Presentation Selection chooses text / Artifact / on-demand UI / no additional UI
↓
Reflection and Curator improve future runs
```

境界表。

| 境界 | 役割 | 混ぜないもの |
| --- | --- | --- |
| Interaction Shell | 会話を中心に、人間が見る、直す、理解する場所 | Backend固有の実行詳細 |
| Surface Protocol | 人間・AIの共通操作と、状態を端末別Surfaceへ投影する契約 | Agentの自由な思考、Workspace正本 |
| Host | Workspace文脈を組み、Backendへ渡し、結果を戻す | 個別モデル呼び出し |
| AgentBackendRegistry | Backend選択とBackend実行handleのlifecycleを扱う | Samurai側の永続Run状態、MemoryやSkillの正本 |
| AgentBackend Cassette | Claude Code / Codex / Nativeなどの実行部 | Workspace正本、公開命名 |
| BackendEventBridge | Backend固有eventを正規化する | UI layout、Memory本文 |
| Workspace Store | filesystemとSQLiteの責務分離、index、履歴を扱う | Agentの判断ロジック |
| Gateway | 外部入口とsession routingを扱う | Workspace更新の正本 |

---

## 5. Core Components

### 5.1 Interaction Shell

Chatを中心に、人間が必要な時だけ操作面を開くUI surface。

| UI surface | 役割 |
| --- | --- |
| Chat Shell | AIへの依頼、Backend進行状況、結果表示を継続する主要面 |
| Artifact Card | 文書、表、グラフ、画像、PDFなどの成果物を見る |
| Workspace Peek | 成果物や業務データを必要時だけ開く一時的な投影面 |
| Context Drawer | Backend event、Tool log、Memory suggestion、Skill candidate を作業中に見る |
| Memory View | AIが覚えていること、provisional/active/sensitiveの管理 |
| Run History | Backend run、event、エラー、再開に必要な履歴を見る |

Interaction Shellは、Agentの行動を説明文で飾る場所ではない。
作業状態、成果物、記憶候補、Skill候補を、人間が理解できる粒度で見せる場所である。
常設のアプリ一覧としてWorkspaceを見せるのではなく、会話から必要なSurfaceを選んで出す。

### 5.2 Samurai Agent Host

Hostは、Chat、Surface、Workspace、Memory、Skill、Gateway、Backendを束ねる中核である。

Hostの責務。

- sessionを作る。
- Workspace contextを集める。
- Active Memoryを取り出す。
- Skill候補を選ぶ。
- Backend cassetteを選択する。
- Backend eventを正規化層へ渡す。
- `BackendRunRecord`の永続状態遷移をRun lifecycleとして調整する。
- 結果をWorkspaceへ戻す。

Hostが持たない責務。

- 個別モデルのAPI実装。
- 外部Backend固有のtool実行。
- Memory本文やSkill本文の正本化。
- Gatewayの外部入口処理。

### 5.3 AgentBackendRegistry

`AgentBackendRegistry` は、利用可能なBackend cassetteを管理する。

責務。

- backend id と backend kind を管理する。
- sessionやworkspaceに応じてBackendを選ぶ。
- Backend configを解決する。
- Backend session、実行handle、capabilityなどBackend実行側のlifecycleを作る。
- Backendの有効/無効、失敗状態、接続状態をHostへ返す。

`AgentBackendRegistry`が所有するlifecycleは、Backendを開始・再開・取消するための実行handleである。`BackendRunRecord`の`queued / running / waiting_for_backend_input / completed / failed / cancelled`など、Samurai Agentが永続化する状態遷移はHost・Runtime側のRun lifecycleが所有する。両者は同じ状態の正本を持たない。

Backend候補。

| Backend | 役割 |
| --- | --- |
| ClaudeCodeBackend | MulmoClaudeに近い外部Agent利用の第一候補 |
| CodexBackend | Codex CLI/API系の実行部候補 |
| SamuraiNativeBackend | 自前Runtime。ProviderAdapter、PromptBuilder、ToolLoopを内部に持つ |
| Future external backend | OpenRouter系、Gemini系、専用Agentなど |

`ProviderAdapter` は、Agent Backend全体の差し替え口ではない。
`SamuraiNativeBackend` の内部でモデルを差し替えるための口である。

### 5.4 Agent Backend Cassette

Agent Backend cassetteは、Hostから渡された作業を実行する実行部である。

共通の差し替え口。

```text
AgentBackend
  startSession
  runTurn
  resumeRun
  cancelRun
  streamEvents
```

Backend cassetteの責務。

- Hostから渡された作業を実行する。
- 進行状況や結果をeventとして返す。
- Backend固有の確認待ちや制限を、Hostへ状態として返す。
- Backend固有のtoolやprompt構成を内部に閉じる。

Backend cassetteが持たない責務。

- Workspace正本の直接更新。
- MemoryやSkillの正本管理。
- GUI layoutの決定。
- 公開命名の決定。

### 5.5 BackendEventBridge

`BackendEventBridge` は、Backend固有のstreamやeventをSamurai Agent内部の正準eventへ変換する。

代表的なevent。

```text
run_started
text_delta
tool_call_started
tool_call_output
artifact_created
workspace_change_suggested
memory_suggested
skill_candidate_created
backend_waiting_for_native_input
run_completed
run_failed
```

`backend_waiting_for_native_input` は、外部Backendが自前の入力待ちになったことを表示するeventである。
Hostは可否判定をせず、状態表示または中継だけを行う。

BackendEventBridgeの責務。

- eventの順序を保つ。
- event typeを正規化する。
- resource referenceを付与する。
- UIへ流すeventと保存するeventを分ける。
- run完了、失敗、停止をHostへ返す。

### 5.6 Workspace Store

Workspace Storeは、ユーザーとAIが共有する作業状態を持つ。

扱うもの。

- Artifact。
- Collection。
- Memory。
- Skill。
- Session。
- Backend run。
- Backend event。
- Workspace change。
- Index。
- Queue。

Workspace Storeの責務。

- filesystemとSQLiteの正本境界を守る。
- 人間が読みたい本文はfileとして残す。
- 検索、状態、履歴、queueはSQLiteで扱う。
- read modelとsource dataを混ぜない。

### 5.7 Memory / Skill / Reflection

MemoryとSkillは、Samurai Agentの育つ体験の中心である。

役割。

| 要素 | 役割 |
| --- | --- |
| Memory | 長期的に残す事実、好み、作業手順、文脈 |
| Active Memory | Backend実行前に取り出される現在有効な記憶 |
| Skill | 繰り返し使える作業手順 |
| Skill index | 必要なSkillを選ぶための索引 |
| Reflection | 実行後にMemory/Skill候補を見つける処理 |
| Curator | 増えすぎたMemory/Skillを整理する処理 |

基本の流れ。

```text
Backend run completes
↓
Background Review reads transcript + artifacts + backend events + actual learning-resource use
↓
Memory / Skill changes are saved automatically with provenance
↓
Evaluation measures the effect from existing run evidence
↓
Curator maintains lifecycle after a restorable snapshot
```

MemoryやSkillは、外部Backendの中に閉じ込めない。
Workspace側に、人間が読める形で残す。

### 5.8 Gateway

Gatewayは、Web UI以外の入口を扱うcontrol planeである。

責務。

- 外部入口をsessionへ対応づける。
- source identityを保存する。
- pairingやallowlistを扱う。
- Hostへ渡す入力を整える。
- 外部チャネル固有の認証や配送を隠蔽する。

Gatewayがやらないこと。

- Workspace正本を直接更新する。
- Agent Backendを直接実装する。
- MemoryやSkillの正本を持つ。

---

## 6. Agent Backend Cassette

Samurai Agentは、Claude Code CLIに固定依存しない。

ただし、Claude Codeを使わないという意味でも、Native実装だけを中核にするという意味でもない。

実行部は、以下のようにcassetteとして差し替える。

```text
AgentBackend cassette
  ClaudeCodeBackend
    external CLI / SDK / stream-json adapter
    backend-specific prompts
    backend-native tool permissions

  CodexBackend
    Codex CLI / API adapter
    task session mapping
    event stream adapter

  SamuraiNativeBackend
    ProviderAdapter
    PromptBuilder
    ContextBuilder
    ToolLoop
    ToolExecutor

  FutureBackend
    external agent service
    local runner
    provider-specific agent runtime
```

Backendごとの違いは、cassette内部へ閉じ込める。
Hostは、共通の `AgentBackend` interface と `BackendEventRecord` だけを見る。

### 6.1 BackendRunRecord

`BackendRunRecord` は、どのsessionで、どのbackendを、どのconfigで動かしたかを表す。

最小項目。

```text
id
session_id
backend_id
backend_kind
status
started_at
completed_at
error_code
input_summary
output_summary
```

### 6.2 BackendEventRecord

`BackendEventRecord` は、backendから返ったstream/eventを正規化したもの。

最小項目。

```text
id
run_id
event_type
created_at
sequence
payload
resource_refs
```

### 6.3 WorkspaceChangeRecord

`WorkspaceChangeRecord` は、Artifact、Collection、Memory、SkillなどWorkspaceに起きた変更を表す。

最小項目。

```text
id
run_id
resource_ref
change_type
summary
created_at
```

`WorkspaceChangeRecord` は「何が変わったかを見る履歴」である。
復元機能や自動巻き戻しの中核ではない。

---

## 7. Workspace / Data Boundary

Workspaceは、AIと人間が共有する作業机である。

```text
workspace/
  profile/
  prompts/
  memory/
  skills/
  collections/
  artifacts/
  sessions/
  backend-runs/
  backend-events/
  workspace-changes/
  files/
  indexes/
  system/
```

ただし、すべてをファイルだけで管理しない。

```text
filesystem:
  artifacts
  uploads
  exports
  user-visible markdown/json
  SOUL.md
  MEMORY.md
  SKILL.md
  collection schema
  custom views

sqlite:
  sessions
  backend runs
  backend events
  workspace changes
  indexes
  queue
  artifact metadata
  collection index
```

正本ルール。

| 対象 | 正本 | 補助側 | 理由 |
| --- | --- | --- | --- |
| Artifact本文 | filesystem | SQLite metadata | 人間が直接開いて読める成果物だから |
| Artifactの検索状態 | SQLite | filesystem path | 一覧、検索、参照関係に使うから |
| Memory本文 | filesystem | SQLite index / status | 人間が編集できる個人記憶だから |
| Memoryの検索index | SQLite | filesystem source | Active Memory retrievalで高速に探すため |
| Knowledge Wiki本文 | filesystem | SQLite index / status / graph | 濃い知識を人間がMarkdownで読める必要があるから |
| Knowledge Wiki active index | SQLite | filesystem source | AI根拠、検索注入、reindex対象をactiveに限定するため |
| Skill本文 | filesystem | SQLite index / status | 手順書として人間もAIも読める必要があるから |
| Skill index | SQLite | filesystem source | 必要なSkillだけ選ぶため |
| Collection schema | filesystem | SQLite schema metadata | データ構造を人間が確認できるようにするため |
| Collection record index | SQLite | filesystem export | 一覧、検索、patch適用に使うため |
| Session transcript | SQLite | export file | 履歴、検索、再開で一貫性が必要だから |
| Backend run | SQLite | export file | どのBackendを動かしたか確認するため |
| Backend event | SQLite | export file | 進行状況、エラー、tool出力を表示するため |
| Workspace change | SQLite | export file | 何が変わったかを後から確認するため |
| Queue / scheduled task | SQLite | なし | 実行状態の整合性が最優先だから |

同じ情報をfilesystemとSQLiteの両方に置く場合、片方は必ずread modelまたはindexとして扱う。
正本がどちらか不明なデータは追加しない。

### Workspace Bundle / Restore

WorkspaceのBackupは、単なるDB file copyではなく、復元できるdirectory Bundleである。

- Bundleのpayloadは`workspace.sqlite`と`artifacts`、`profile`、`memory`、`skills`、`wiki`、`rollback`、`collections`、`surfaces`だけに固定する。`backups`、cache、派生学習データ、未知fileは含めない。
- SQLiteはOnline Backup APIでSnapshotを作り、WAL内の確定内容も含める。Snapshotのintegrity checkに失敗したBundleは公開しない。
- 作成中は隠しStageへ置き、全payloadのSHA-256確認後にManifestを最後に書く。完成時だけatomic renameするため、一覧へ未完成Bundleは出ない。
- Manifest v2は相対POSIX path、`source_root: "."`、DB migration番号、固定root一覧、file hashを持つ。復元前にpath escape、重複、未知root、file集合差、hash不一致、special file、未来format、未来schemaを拒否する。v1は読込時に正規化し、欠けた管理rootを空として扱う。
- Restoreは候補をStageで通常起動し、migration・未完了file transaction回収・default settings・managed resource同期・Session検索初期化を完了してから行う。現在状態の自動Backupを成功させてからjournalを記録し、DB/WAL/SHMと管理rootを入れ替える。
- journalが`committed`前で中断した場合は次回起動時に元へ戻す。`committed`後は復元状態を保持して残骸だけを片付ける。古いWAL/SHMを復元DBへ流用しない。
- 同一Store instanceではBackup、Import、Export、Restore、Repair、Retentionを同時実行しない。前提は単一Runtimeであり、待機queue、retry framework、プロセス間・分散lockは持たない。

### 7.1 Canonical Core Schemas

構造上の中心schema。

```text
ResourceRef
SupportedLocale
TranslationStatus
LocalizedText
MessageEnvelope
AgentBackendConfig
BackendRunRecord
BackendEventRecord
WorkspaceChangeRecord
ActionCatalogEntry
MemoryFrontmatter
WikiFrontmatter
SkillFrontmatter
ArtifactRecord
CollectionSchema
CollectionRecord
CollectionPatch
GrantRecord
```

read model。

```text
SkillIndexEntry
ChangeHistoryEntry
RunHistoryEntry
```

read modelは、表示や検索のための派生データであり、source of truthにしない。

---

## 8. Memory / Skill Improvement Loop

Memory / Skill / Reflection / Curator は、Hermes Agentから強く参照する領域である。

この領域は、次の5つを混ぜない。

| 領域 | 役割 | 正本 |
| --- | --- | --- |
| Memory | 毎回効かせる短い個人理解。好み、作業スタイル、重要ルール、短い教訓 | `workspace/memory/**/*.md` |
| Knowledge Wiki | 記事、調査、設計、プロジェクト知識、技術、意思決定などの濃い知識 | `workspace/wiki/pages/<slug>.md` |
| Skill | 記憶ではなく、再利用できる作業手順 | `workspace/skills/**/*.md` |
| Session Search | SQLite FTS系の過去会話検索 | SQLite read model |
| External Provider | 検索、関連付け、抽出の補助 | 正本なし |

External Provider由来の内容は、acceptedされるまでMemory、Knowledge Wiki、Skillの正本にしない。
参照元不明のProvider情報は保存せず、`unverified external hint` として診断表示に留める。

### 8.1 Memory

Memoryは、AI秘書の長期的な理解を支える。

分類。

| 種類 | 内容 |
| --- | --- |
| session memory | 今の会話や作業でだけ有効な文脈 |
| provisional memory | 保存候補だが、まだ確定していない記憶 |
| topic memory | ユーザーの好み、事実、作業手順などの長期記憶 |
| sensitive memory | 個人情報、secret、強い自己理解に関わる記憶 |

Knowledge WikiはMemoryの一種ではなく、独立したWorkspaceリソースとして扱う。

`WikiFrontmatter`。

```text
id
slug
title
state: proposed | active | archived | rejected
content_locale
tags
source_refs
provenance
created_at
updated_at
```

`state=active` のページだけをAIの根拠、検索注入、外部Provider補助index、Wiki graph/reindexの有効対象にする。
`proposed / rejected / archived` は管理UIと履歴には出せるが、返答根拠としては使わない。
archive/rejectは物理削除せず、state更新にする。

Wiki APIはStore直書きではなくRuntime operation経由にする。

```text
GET /api/wiki
GET /api/wiki/:id
POST /api/wiki/proposals
POST /api/wiki/:id/accept
POST /api/wiki/:id/reject
PATCH /api/wiki/:id
POST /api/wiki/:id/archive
POST /api/wiki/reindex
```

Memory flow。

```text
Backend run completes
↓
Background Review reads transcript + artifacts + backend events
↓
Reusable Memory changes are saved automatically with provenance
↓
Active Memory retrieval uses the updated Memory
```

### 8.2 Skill

Skillは、繰り返し使える作業手順である。

分類。

| 種類 | 内容 |
| --- | --- |
| skill candidate | 会話や作業から見つかったSkill候補 |
| project skill | 特定Workspaceで使えるSkill |
| active skill | 実行時に選択されるSkill |
| shared skill | 他ユーザーやmarketplace向け |

Skill flow。

```text
Backend run produces repeated pattern
↓
Background Review detects a reusable class-level procedure
↓
Skill is created or patched automatically with provenance
↓
Skill index makes it searchable
↓
Host selects relevant skill for future backend runs
```

### 8.3 Reflection / Curator

Reflectionは、作業結果から改善候補を見つける。

Curatorは、増えすぎたMemoryやSkillを整理する。

扱うこと。

- Memory suggestionの生成。
- Skill candidateの生成。
- 似たSkillの統合候補。
- 使われないSkillの整理候補。
- 古いMemoryの見直し候補。

Background ReviewやCuratorは、外部Backendの内部状態として閉じない。
自動変更はWorkspace上へ保存し、source run、version、根拠、snapshotから後で理解・復元できるようにする。

---

## 9. Collection / Artifact Boundary

### 9.1 Artifact

Artifactは、会話やBackend実行から生まれる成果物である。

扱うもの。

- 文書。
- 表。
- グラフ。
- 画像。
- PDF。
- structured draft。
- generated report。

Artifact本文はfilesystemを正本にする。
検索、一覧、参照関係、生成元runはSQLite metadataで扱う。

### 9.2 Collection

Collectionは、AIと人間が共有する小さな業務データを扱う仕組みである。独立アプリそのものではない。

扱うもの。

- schema。
- records。
- refs。
- embeds。
- derived fields。
- triggers。
- actions。
- notes。

Collectionの目的は、Agentの出力を業務データとしてWorkspaceに戻すことである。

Collectionの正本。

```text
collection/
  schema.json
  records/
  SKILL.md
  notes/
```

`notes/` はAIが読む補助文脈である。
schema field、patch API、validator対象にはしない。

### 9.3 ActionCatalog / Plugin Layer

`ActionCatalogEntry` は、Hostが呼べる操作を見つけるためのカタログである。

持つもの。

- action id。
- display name。
- input schema。
- implementation target。
- UI display category。

持たないもの。

- risk。
- approval。
- policy。
- default decision。
- reversibility。
- strong confirmation。
- audit policy。

Plugin分類。

| 種類 | 例 |
| --- | --- |
| UI plugin | custom view / artifact renderer |
| Tool plugin | external API / local tool |
| Collection action | record作成 / patch / derived field |
| Backend connector | external Agent接続 |
| Marketplace plugin | 配布・課金 |

---

## 10. Gateway / External Boundary

Gatewayは、Web UI以外の入口を扱うcontrol planeである。

扱う入口。

- Web。
- Cron。
- Future Telegram。
- Slack。
- LINE。
- Email。
- Webhook。
- Local bridge。

Gatewayの責務。

- 外部入口をsessionへ対応づける。
- source identityを保存する。
- pairingやallowlistを扱う。
- Hostへ渡す入力を整える。
- 外部チャネル固有の認証や配送を隠蔽する。

外部境界で扱うもの。

- sandbox。
- allowed tools。
- MCP config。
- SecretRef。
- path normalization。
- pairing。
- allowlist。
- timeout。
- concurrency lock。

これはSamurai Agentの独自性ではない。
外部Agentや外部サービスと接続するための運用境界である。

外部Backendが自前で入力待ちになった場合、Hostは `backend_waiting_for_native_input` eventとして表示する。
Hostはその可否を独自に判定しない。

---

## 11. Localization

多言語対応は、Workspace、Memory、Artifact、Agent出力の初期設計に含める。

初期seed locale。

```text
en
ja
zh
ko
es
pt-BR
fr
de
```

基本ルール。

- `ja` を設計・文案のcanonicalにする。
- `en` をfirst-class localeにする。
- key欠落は許可しない。
- UI文言はlocale fileから取得する。
- 原文は必ず保持し、翻訳は派生データとして扱う。
- `SamuraiNativeBackend` のPromptBuilderは必ず `output_locale` を受け取る。

混ぜないlocale。

| Locale | 役割 |
| --- | --- |
| `ui_locale` | UI表示言語 |
| `output_locale` | Agent返答とArtifact出力言語 |
| `input_locale` | ユーザー入力または外部入力の言語 |
| `source_locale` | 取り込み元の原文言語 |
| `content_locale` | 保存データの主言語 |
| `fallback_locale` | 欠落時のfallback言語 |

---

## 12. Final Direction

このプロダクトは、

```text
Chat-firstに意図を伝えられる
必要なSurfaceだけが会話から現れる
Workspace-backedに状態と学習が育つ
Hermes的に自律的に改善する
OpenClaw的に外部入口と運用境界を持てる
Agent Backendをcassetteとして差し替えられる
```

である。

より正確には、

> **MulmoClaude型のHost、Artifact、Collection、Rendererの仕組みを参照しつつ、アプリ中心のWorkspace UXを完成形にしない。**
> **Agent BackendはClaudeCodeBackend / CodexBackend / SamuraiNativeBackendとして差し替え可能にする。**
> **HermesのMemory / Skill / Reflection / Curator / Automationを、Chatと必要時のSurfaceで理解できる形に変換して採用する。**
> **OpenClawのGateway / Session / Pairing / Sandbox / SecretRef思想は、外部入口と運用境界として取り込む。**

借りるのは、実装そのものよりも以下の勝ち筋である。

- MulmoClaude: Host、Workspace状態、Artifact、Collection、Rendererの仕組みを参照すること。
- Hermes: Memory / Skill / Reflection / CuratorでAgentが育つこと。
- OpenClaw: GatewayとSessionで外部入口を束ねること。
- Claude Code / Codex: Agent Backendとして差し替え可能に扱うこと。

最初に作るべきものは、独自安全制御ではない。

最終的に作るべきものは、

> **外部Agentや自前Agentの力をWorkspace、Memory、Skill、Artifactへ戻し、会話から必要な操作面だけを現せるPersonal Agent Interface**

である。
