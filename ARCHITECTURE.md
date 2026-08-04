# Samurai Agent Architecture v0.9

## Chat-first Personal Agent Interface

### Workspace-backed, UI on demand

### 参照OSSと参照プロダクトの強みをWorkspace-firstに再構成する

---

## 0. この文書の位置づけ

この文書は、`PRINCIPLES.md`と`SAMURAI_AGENT_MANUAL.md`の下で、Samurai Agentの**最終アーキテクチャ構造、責務、境界、データ流れの正本**となる。

文書の役割は以下。

- `PRINCIPLES.md`: 設計思想、判断基準、前提。
- `SAMURAI_AGENT_MANUAL.md`: プロダクト全体像、概念、用語、関係性。
- `ARCHITECTURE.md`: システム構造、責務、境界、データ流れ。
- `PUBLIC_NAMING.md`: 公開面の命名ルール。
- `WEB_UI_DESIGN.md`: 固定Web UIの視覚設計、UI shell、CSS再利用ルール。
- `plans/`: 実装順、レビュー、作業計画。

この文書では、実装順や短期計画ではなく、最終的にどういう構造であるべきかを記述する。

---

## 1. Reference Sources

この設計で参照するOSS、参照プロダクト、補助資料は以下。

| 参照対象 | 正式参照元 | この設計での扱い |
| --- | --- | --- |
| OpenClaw | `https://github.com/openclaw/openclaw.git` | Gateway / Session / Pairing / Sandbox / External boundary の参照元 |
| Hermes Agent | `https://github.com/NousResearch/hermes-agent.git` | Memory / Skill / Reflection / Self-improvement loop の参照元 |
| MulmoClaude | `https://github.com/receptron/mulmoclaude.git` | Host / Workspace state / Artifact / Collection / Renderer / Plugin composition の参照元 |
| Buzz | `https://github.com/block/buzz.git` | Room / Human-Agent collaboration / signed Event / Relay / Identity boundary の参照OSS |
| Type.com | `https://type.com/` | Shared Space / Knowledge / Skill / Integration / external Agent work import の参照プロダクト。OSSではない |
| Hermes Agent 解説 | `Hermes_Agent_解説.md` | Hermes Agent理解のローカル補助資料 |
| MulmoClaude記事 | `https://singularitysociety.org/articles/blog/2026-04-10-mulmoclaude/` | MulmoClaude理解の補助資料 |
| OpenClaw記事 | `https://unicornee.ai/articles/openclaw-ai-agent/` | OpenClaw理解の補助資料 |
| OpenClaw architecture guide | `https://eastondev.com/blog/ja/posts/ai/20260205-openclaw-architecture-guide/` | OpenClaw architecture理解の補助資料 |

| 参照元 | 役割 | Samurai Agentでの位置づけ |
| --- | --- | --- |
| MulmoClaude | Host / Workspace / Artifact / Collection / Plugin composition | 仕組みと状態構造の参照元。アプリ中心UXは完成形にしない |
| Hermes Agent | Memory / Skills / Reflection / Self-improvement loop | 育つAgent体験の中心 |
| OpenClaw | Gateway / Session routing / Pairing / Sandbox / External entry | 外部連携と運用境界の中心 |
| Buzz | Room / signed Event log / Relay / Identity / Human-Agent collaboration | Roomを活動範囲、共通Eventを外部との共通言語として設計する参照元。RelayをWorkspace正本にはしない |
| Type.com | Shared Space / Knowledge / Skills / Integrations / work import | 既存Agentの仕事を共有Spaceへ持ち込み、KnowledgeやSkillを共有する製品体験の参照元。内部実装は推測しない |
| Claude Code / Codex | Agent Backend cassette | 実行部を固定しないための差し替え候補 |

---

## 2. Final Concept

Samurai Agent は、以下を目指す。

> **会話を中心に、人とAgentがRoomで活動し、Backendを差し替えてもKnowledge、Skill、Artifactがユーザー所有のWorkspaceへ残るWorkspace-first Personal Agent Interface。**

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

> **個人利用を起点に、人間とAIが同じ仕事状態を扱い、必要な相手へ選択的に共有でき、必要な操作面だけが会話から現れるAgent Interface。**

---

## 3. Architecture Principles

思想の詳細は`PRINCIPLES.md`、プロダクト全体の概念と関係性は`SAMURAI_AGENT_MANUAL.md`を正本にする。
この文書では、アーキテクチャ上の不変条件だけを扱う。

- Chatが継続的な主要インターフェースであり、UIは必要時だけ会話から現れる。
- Workspaceは、人間とAIが共有する永続状態の正本であり、常設の主画面ではない。
- RoomはWorkspace内の活動・共有範囲、SessionはRoom内の一回の会話・作業として扱う。
- Agentは継続する役割・Identity・利用範囲を持ち、交換可能なAgent Backendとは分離する。
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
Host resolves the Session Room and selected Agent
↓
Active Memory retrieval + Skill selection
↓
Host resolves the Agent Backend binding
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
- SessionのRoomと、実行する有効なAgentを解決する。
- Workspace contextを集める。
- Active Memoryを取り出す。
- Skill候補を選ぶ。
- Backend cassetteを選択する。
- Backend eventを正規化層へ渡す。
- `BackendRunRecord`の永続状態遷移をRun lifecycleとして調整する。
- 結果をWorkspaceへ戻す。

Core 05着手前の基盤では、HostがAgentの名前・役割・指示を低優先度の型付きContextとしてBackendへ渡す。`Room + Session + Agent + Backend`をBackend Session keyに使い、Backendを交換してもAgent IDとWorkspace側の情報を保持する。

Hostが持たない責務。

- 個別モデルのAPI実装。
- 外部Backend固有のtool実行。
- Memory本文やSkill本文の正本化。
- Gatewayの外部入口処理。

### 5.3 AgentBackendRegistry

`AgentBackendRegistry` は、利用可能なBackend cassetteを管理する。

責務。

- backend id と backend kind を管理する。
- Hostが解決したAgentのBackend bindingを実行可能なcassetteへ解決する。
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

### 5.3.1 Room / Agent foundation

RoomとAgentはBackendではなく、Workspace SQLiteが所有する軽い永続Recordである。

| Record | 保存項目 | 実行時の役割 |
| --- | --- | --- |
| RoomRecord | ID、名前、作成／更新日時 | Sessionの活動範囲 |
| AgentRecord | ID、名前、役割、指示、Backend ID、有効状態 | Backendを選ぶ継続する役割 |
| UsageScopeRef | workspace / room / agent / session のいずれか | Memory・Wiki・Skillの利用範囲 |
| ActivityContextRef | room_id / session_id / agent_id | Runと学習記録の出所 |

Settingsの既定Room／既定Agentを省略時に使い、`settings.patch`で既存Roomと有効なAgentだけを選べる。永続的なBackend変更は`agent.backend.bind`だけが行い、`chat.turn.run`の`backend_id`は一回限りの互換入力である。Room membership、ACL、招待、削除、UIはCore 05 foundationの責務には含めない。

既定AgentもBackend未指定の旧呼び出しだけは、Settingsに既定Backendがなく、そのAgentの初期bindingが未登録の場合に限り、従来どおり利用可能な既定Backendへ一回だけ解決する。この互換経路はAgent Recordを書き換えない。

この基盤は新しいWorkspace形式から開始する。旧Session／RunのRoom・Agent出所をbackfillせず、旧Bundle復元の互換も追加しない。

### 5.3.2 Core 06 Room participants and access boundaries

Core 06は、Workspaceの管理役割とRoom内容への参加を分離する。人の役割は`Owner > Admin > Member > Guest`で、Agentはこの階層に入れず、Roomごとの`view / edit / execute`許可だけを持つ。

```text
Workspace membership ── 管理・Room作成の権限
Room membership      ── Room内容の閲覧・編集・実行・共有の権限
Resource boundary    ── 元Roomと明示共有先の利用範囲
```

- `workspace_members`、`room_members`、`room_agents`、`agent_workspace_permissions`を現在の参加状態の正本として保存する。解除済み行は履歴として残し、判定には使わない。
- `resource_access_boundaries`と`room_resource_shares`は元Room、作成者、共有・共有解除の履歴を保存する。共有はデータ複製や`UsageScope`変更を行わない。
- Room作成とOwner登録、Owner移譲はSQLite transactionで保存する。active Ownerの部分一意制約により、外部からOwner 0人・2人の状態は観測できない。
- `ActorIdentity`は経路情報のまま残す。Domain Contextには安定した参加者ID、種別、Agent実行を依頼した人、Sessionから導出したRoomを持たせ、公開payloadで偽装できないようにする。
- Chat、Backend Run、Tool、検索、Context assembly、Resource read/write、Room操作は共通`RoomAuthorizationService`を通す。検索とContextはRoom境界で候補を絞り、返却・読み込み直前にもう一度確認する。
- 参加解除後の過去履歴は残すが、新しい読み込み、検索、Tool、書き込み、Backend継続処理は拒否する。

Core 06はRoom管理UI、外部招待・認証、Gateway変更、学習判断、Room削除・アーカイブ、旧Bundle互換を追加しない。

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
agent_id
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
  learning-history/
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
  rooms
  agents
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
| Learning Resourceの過去Version本文 | filesystem | SQLite version metadata | 現行本文をSQLiteへ複製せず、変更理由と復元元だけを追跡するため |
| Learning Resource Version履歴 | SQLite metadata | filesystem history path | Resource ID、Version、親Version、hash、根拠、変更主体を検索するため |
| Collection schema | filesystem | SQLite schema metadata | データ構造を人間が確認できるようにするため |
| Collection record index | SQLite | filesystem export | 一覧、検索、patch適用に使うため |
| Room / Agent | SQLite | なし | Workspace内の活動範囲とBackendから独立した役割を持つため |
| Session transcript | SQLite | export file | 履歴、検索、再開で一貫性が必要だから |
| Backend run | SQLite | export file | RoomのSessionで、どのAgentがどのBackendを動かしたか確認するため |
| Backend event | SQLite | export file | 進行状況、エラー、tool出力を表示するため |
| Workspace change | SQLite | export file | 何が変わったかを後から確認するため |
| Queue / scheduled task | SQLite | なし | 実行状態の整合性が最優先だから |

同じ情報をfilesystemとSQLiteの両方に置く場合、片方は必ずread modelまたはindexとして扱う。
正本がどちらか不明なデータは追加しない。

### Workspace Bundle / Restore

WorkspaceのBackupは、単なるDB file copyではなく、復元できるdirectory Bundleである。

- Bundleのpayloadは`workspace.sqlite`と`artifacts`、`profile`、`memory`、`skills`、`wiki`、`rollback`、`learning-history`、`collections`、`surfaces`だけに固定する。`backups`、cache、未知fileは含めない。
- RoomとAgentはSQLite snapshotへ含める。Room／Agent専用の保存rootやBackup Manifest項目は増やさない。
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

Core 05では、Activity HistoryをMemoryへ複製せず、根拠のある経験だけをMemory、経験則（Knowledge Wiki）、Skill候補へ整理する。外部Backendは候補信号と型付きMutation Planを返せるが、Workspaceファイルを直接変更しない。

| 領域 | 役割 | 正本 |
| --- | --- | --- |
| Activity History | 会話、Run、Event、Tool、Change、Artifactの生履歴 | Session / Run / Eventなどの既存正本 |
| Memory | 単独で想起・訂正できる経験 | `workspace/memory/**/*.md` |
| Knowledge Wiki | 設計・資料・意思決定と、`experience_rule`としての経験則 | `workspace/wiki/pages/<slug>.md` |
| Skill | 反復可能な手順 | `workspace/skills/**/*.md` |
| Version history | 過去Versionの本文と復元根拠 | `workspace/learning-history/` |
| Session Search | 過去会話の検索read model | SQLite |

Memory、Knowledge Wiki、Skillの新しい学習Resourceは、次をfrontmatterとSQLite indexへ持つ。

```text
evidence_state: direct_confirmed | inferred | supported | conflict
usage_state: normal | limited | dormant
usage_scope
origin_activity_context
source_run_ids
version
content_hash
pinned
created_at
updated_at
```

既存Resourceはbackfillしない。既存Resourceを更新した時に新形式のVersionを作る。現行本文をSQLiteへ複製せず、SQLiteにはResource ID、種類、Version、親Version、history path、hash、変更理由、根拠Run、変更主体、復元元を保存する。

### 8.1 Run完了とBackground Review

Run完了時は追加LLMを呼ばない。HostはTrusted Run ContextからActivity Contextを解決し、次の事実だけから型付き`candidate_signals`を登録する。

- 明示的なMemory保存または経験則化の指示
- ユーザー訂正・否定
- Tool失敗後の修正と成功、テストなどの客観結果
- 実際に`applied`になったResource、意味のあるWorkspace Change、反復手順、Backend Learning Signal

信号がないRun、またはActivity Contextを解決できないRunは候補を作らない。会話自体は成功させる。同じsource Runの候補は1件だけで、既存`reflection_runs`を`queued`、`deferred`、`started`、`completed`、`failed`で使う。新しいQueueやSchedulerは増やさない。

Roomがidleで候補がある時だけ、既存AutomationがBackground Reviewを実行する。Reviewの入力は、確定RunのLearning Evidence、同じRoomの候補とResource、適用履歴、ユーザー修正、客観結果に限定する。別Roomの本文は渡さない。

```text
completed Run
  -> typed candidate signal
  -> Room-scoped Background Review
  -> validated Domain Operation
  -> Workspace Store
  -> human-readable Workspace file + version metadata
```

Reviewが許可するMutationは、Memory作成、明示経験則または`inferred / limited / Room`の経験則作成、Skill候補、既存Resourceへの根拠追加Version、条件分割・置き換え・Skill修正候補だけである。Runtimeは型と許可表で検証する。

Reviewは削除、Archive、自動統合、自動Scope拡張、複数Room本文の混在、Activity History変更、外部サービス操作、学習効果判定、危険操作の権限学習を行えない。ユーザーの沈黙は成功の根拠ではない。

### 8.2 検索、実利用、Evaluation

検索はUsage Scopeに一致するindex行だけから選ぶ。`conflict`と`dormant`は通常Contextから除外し、`limited`は参考情報として明示する。ScopeはSession、Room、Agent、Workspaceを区別し、新規学習の標準はRoomである。複数Roomの根拠があってもWorkspaceへ自動昇格しない。

Resourceの利用記録は次の段階を分ける。

```text
selected -> body_loaded -> support_loaded (Skillのみ) -> applied
```

`applied`はBackendが実際の判断・行動に使った時だけ、Provider Tool Bridgeから共通Domain Operationで記録する。Operationは同じRunでの本文読込、Resource ID、Version、内容hash、Usage Scope、通常利用可能状態を検証する。保存できなければBackendは利用済みとして返せない。Skillの利用回数は本文を同じRunで初めて読んだ時だけ増やし、`applied`や補助ファイルでは増やさない。

Evaluationは`applied`がある正確なResource Versionだけを対象にする。予測結果と因果効果を分け、客観結果、明確なユーザー確認・訂正、独立Runを根拠に`supported`、`refuted`、`indeterminate`を保存する。旧Task Fingerprint、一般品質score、無関係Runのbefore/after比較は完成経路に含めない。`refuted`では、そのVersionが現行なら`conflict / limited`の新Versionを作り、次Runの通常利用から外す。

### 8.3 Version、Curator、コスト制御

編集、訂正、Scope変更、復元はResource単位の新Versionとして記録する。復元は古いVersionへ巻き戻さず、過去本文を元にした新Versionを作る。通常の1件復元はResource Version履歴を使い、複数Resourceの変更を戻す時だけWorkspace Snapshotを使う。

Curatorは、置き換え、反証、環境変化、ユーザーによる整理・復元・Archive指示という理由がある時だけ起動する。固定4時間、日次、週次、30日、90日を状態変更の根拠にしない。時間経過は確認候補のきっかけにしかならず、pinned Resourceを自動Archiveしない。Archive前にはWorkspace Snapshotを作り、hard deleteはしない。

候補がなければ追加AIコストはゼロである。ReviewはRoom単位で候補を処理し、通常は補助モデル、矛盾時だけ設定された高性能モデルを選べる。Settingsの`learning_enabled`で完全停止でき、過去7日間の通常Run使用量に対する予算比率を設定する。金額があれば金額、なければToken数を使い、単位を混ぜない。予算超過は候補を`deferred`にするだけで、通常会話を止めない。

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
> **BuzzのRoom / signed Event / Relay / Identity思想は、Human・Agent・External・Systemが活動する共通Event境界として参照する。**
> **Type.comのShared Space / Knowledge / Skill / Integration / work import体験は、既存Agentの仕事をWorkspaceへ持ち帰る見せ方として参照する。**

借りるのは、実装そのものよりも以下の勝ち筋である。

- MulmoClaude: Host、Workspace状態、Artifact、Collection、Rendererの仕組みを参照すること。
- Hermes: Memory / Skill / Reflection / CuratorでAgentが育つこと。
- OpenClaw: GatewayとSessionで外部入口を束ねること。
- Buzz: 人とAgentがRoomで活動し、署名EventとIdentityを同じ履歴へ残すこと。
- Type.com: Knowledge・Skill・Integrationと既存Agentの仕事を共有Spaceへ持ち込む製品体験。
- Claude Code / Codex: Agent Backendとして差し替え可能に扱うこと。

最初に作るべきものは、独自安全制御ではない。

最終的に作るべきものは、

> **外部Agentや自前Agentの力をWorkspace、Memory、Skill、Artifactへ戻し、会話から必要な操作面だけを現せるPersonal Agent Interface**

である。
