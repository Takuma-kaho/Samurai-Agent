# v1 MVP Implementation Plan

## 0. この文書の位置づけ

この文書は、Samurai Agent v1 MVPの実装順を固定するための作業計画である。

source of truthの優先順位は以下。

1. `PRINCIPLES.md`: 設計思想・判断基準・前提
2. `ARCHITECTURE.md`: 実装前アーキテクチャ仕様
3. `PUBLIC_NAMING.md`: 公開面の命名ルール
4. `plans/`: 作業計画、レビュー、改訂方針

この計画は `ARCHITECTURE.md v0.7` を前提にする。

---

## 1. v1 MVPの完成条件

完成条件は、以下の縦切りが実際に動くこと。

```text
Chat Shell
↓
Surface Protocol
↓
Host Orchestrator
↓
MessageEnvelope / Session context
↓
Active Memory retrieval
↓
Skill selection
↓
AgentBackendRegistry
↓
mockable Backend cassette
↓
BackendEventBridge
↓
normalized AgentEvent
↓
Artifact draft / Workspace change
↓
Workspace Store
↓
Memory suggestion / Skill candidate
↓
Reflection job
↓
Chat Shell + Context Drawer
```

この縦切りは、MulmoClaude由来のGUI / Workspace操作をAgent Backend cassetteへ流し、結果をWorkspace / Memory / Skillへ戻せるかを確認するためのものである。

v1では、画面だけを先に作る状態にしない。

GUIから出た操作が、Host、Backend cassette、Backend event、Workspace更新まで通ることを完成条件に含める。

ユーザーから見た完成条件。

- Chatから依頼できる。
- 選ばれたBackendが見える。
- Backendの進行状況がContext Drawerに出る。
- 生成されたArtifactを画面で見られる。
- Workspaceに何が変わったか確認できる。
- Memory suggestionを確認できる。
- Skill candidateを確認できる。
- UI、Agent出力、Memory、Artifactがlocale前提で壊れない。

---

## 2. v1対象

v1に入れるもの。

| 領域 | 対象 |
| --- | --- |
| GUI | Chat Shell / Artifact Card / Workspace Peek / Context Drawer / Memory View / Run History |
| Surface Protocol | GUI operation / artifact update / backend event の最小表現 |
| Agent Backend | AgentBackend interface / Backend registry / Event stream / Session store |
| Backend Event | normalized AgentEvent / BackendRunRecord / BackendEventRecord |
| Workspace History | WorkspaceChangeRecord / ChangeHistoryEntry read model |
| Localization / i18n | 8 locale seed、locale file、output_locale付きPromptBuilder、locale-aware schema |
| Workspace store | filesystem + SQLite |
| Memory | session / provisional / topic / Active Memory minimal |
| Artifact | draft作成、保存、参照 |
| Skill | candidate生成、project保存、skill index生成 |
| Collection | schema定義、record作成、小さなpatch適用、任意のnotes読み取り |
| ActionCatalog | Hostが呼べる操作の名前、schema、実装先 |
| Gateway | web source、cron sourceの入口だけ |
| Automation | memory review / skill candidate review の小さなcron |

---

## 3. v1対象外

v1ではやらないもの。

- Skill専用管理画面。
- Collection専用管理画面。
- 外部チャネル本実装。
- marketplace。
- 支払い自動化。
- 自由HTML全面解禁。
- MoA / GEPA。
- shared skill ecosystem。
- OS通知、メール通知、外部push通知。
- ClaudeCodeBackend完成版。
- CodexBackend完成版。
- SamuraiNativeBackend完成版。
- Generated UI全面解禁。
- Workspace復元機能。

これらは、v1後続、UI詳細、公開前polishに分類する。

---

## 4. 推奨ディレクトリ構成

```text
apps/
  web/
  server/

packages/
  core-schemas/
  agent-backends/
  runtime/
  workspace-store/
  localization/
  memory/
  artifacts/
  skills/
  collections/
  gateway/
  ui-protocol/
```

責務を混ぜない。

- GUIは、人間が見る、直す、理解する場所。
- Hostは、Workspace文脈を集め、Backend cassetteに作業を渡し、結果を戻す場所。
- Agent Backendは、Hostから渡された作業を実行する差し替え可能な実行部。
- `ProviderAdapter` は、Agent Backend全体ではなく `SamuraiNativeBackend` 内部のモデル差し替え口。
- Gatewayは、入口とsession routingを扱う場所。
- Memoryは、長期的に残す事実、好み、手順、文脈。
- Skillは、繰り返し使える作業手順。
- Run Historyは、表示、デバッグ、セッション再開のための履歴。

---

## 5. 実装順序

この順で進める。

1. Core Schemas
2. Localization / i18n scaffold
3. Surface Protocol minimal
4. Workspace store
5. AgentBackend interface
6. Backend registry
7. BackendEventBridge
8. Mock Backend cassette
9. Chat session
10. GUI to Backend cassette connection spike
11. Artifact draft
12. Run History / Backend event surfacing
13. Memory minimal
14. Memory suggestion
15. Skill candidate
16. Reflection job
17. Skill / Collection minimal backend

最初の成功条件は、Claude Code本体を完全に動かすことではない。

まずは、mockable Backend cassetteで以下を通す。

- cassette選択。
- run作成。
- event stream。
- Artifact draft保存。
- Workspace change保存。
- Memory suggestion表示。
- Skill candidate表示。

---

## 6. Core Schemas

最初に `ARCHITECTURE.md v0.7` の `Canonical Core Schemas` を型として固定する。

必須。

- `ResourceRef`
- `SupportedLocale`
- `TranslationStatus`
- `LocalizedText`
- `MessageEnvelope`
- `AgentBackendConfig`
- `BackendRunRecord`
- `BackendEventRecord`
- `WorkspaceChangeRecord`
- `ActionCatalogEntry`
- `MemoryFrontmatter`
- `SkillFrontmatter`
- `ArtifactRecord`
- `CollectionSchema`
- `CollectionRecord`
- `CollectionPatch`
- `GrantRecord`

`SkillIndexEntry` と `ChangeHistoryEntry` は保存モデルではなくread model。

`ChangeHistoryEntry` は、WorkspaceやArtifactで「何が変わったか」を見るための表示用read model。
復元期限や自動復元機能はv1中核に入れない。

locale関連の必須フィールド。

- `MessageEnvelope`: `input_locale` / `output_locale`
- `MemoryFrontmatter`: `source_locale` / `content_locale`
- `ArtifactRecord`: `locale` / `source_locales`
- `CollectionSchema`: `labels` / `descriptions` をlocale mapとして扱う

Collectionの補助文脈。

- v1のCollection minimal backendは `schema.json`、`records/*.json`、`SKILL.md` を主対象にする。
- 任意の `notes/*.md` は保存・読み取り対象に含める。
- `notes/*.md` は、AIが読む補助文脈であり、v1ではpatch/API/validator対象にしない。

---

## 7. Agent Backend MVP

v1の中核は、Agent Backend cassetteを差し替えられること。

最初に作るもの。

- `AgentBackend` interface。
- `AgentBackendRegistry`。
- `BackendRunRecord`。
- `BackendEventRecord`。
- `BackendEventBridge`。
- `MockBackend`。

Backend eventの代表例。

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

`backend_waiting_for_native_input` は、外部Backendが自前で入力待ちになったことを表示するためのevent。
Hostは可否判定せず、状態表示または中継だけを行う。

Backend候補。

| Backend | v1での扱い |
| --- | --- |
| MockBackend | 最初に通す |
| ClaudeCodeBackend | MulmoClaude寄せの第一候補。後続で実装 |
| CodexBackend | 互換候補。後続で実装 |
| SamuraiNativeBackend | 自前Runtime候補。ProviderAdapterを内部に持つ |

---

## 8. Localization / i18n 初期実装

多言語対応は、v1後続のpolishではなく初期scaffoldに含める。

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

追加するもの。

- `locales/en.json`
- `locales/ja.json`
- `locales/zh.json`
- `locales/ko.json`
- `locales/es.json`
- `locales/pt-BR.json`
- `locales/fr.json`
- `locales/de.json`

基本ルール。

- `ja` を設計・文案のcanonicalにする。
- `en` をfirst-class localeにする。
- `zh`、`ko`、`es`、`pt-BR`、`fr`、`de` は初期 `draft` 翻訳でもよい。
- key欠落は許可しない。
- UI文言はlocale fileから取得する。
- 原文は必ず保持し、翻訳は派生データとして扱う。
- `SamuraiNativeBackend` のPromptBuilderは必ず `output_locale` を受け取る。

実装時に混ぜないlocale。

| Locale | 役割 |
| --- | --- |
| `ui_locale` | UI表示言語 |
| `output_locale` | Agent返答とArtifact出力言語 |
| `input_locale` | ユーザー入力または外部入力の言語 |
| `source_locale` | 取り込み元の原文言語 |
| `content_locale` | 保存データの主言語 |
| `fallback_locale` | 欠落時のfallback言語 |

---

## 9. GUI最小要件

v1必須画面。

- Chat: 依頼、Backend進行状況、結果表示。
- Context Drawer: Backend event、Tool log、Memory suggestion、Skill candidate。
- Artifact: draft表示、保存状態、参照元。
- Memory: provisional / topic の確認、無効化。
- Run History: Backend run、event、エラー、再開に必要な履歴。

専用画面なしでよいもの。

- Skill: index生成とproject保存まで。
- Collection: schema、record、patch適用まで。
- Change History: Artifact / Workspace 詳細から辿る補助履歴にする。

Run Historyに持たせるもの。

- Backend run。
- Backend event。
- tool output要約。
- error。
- Artifact / Memory / Skillへの導線。

Run Historyに持たせないもの。

- judgement。
- host-side approval。
- policy decision。
- accountability。
- audit。
- rollback eligibility。

---

## 10. 後続コード置換の棚卸し

今回のMarkdown更新では、実装コードは削除しない。

ただし、後続で置換が必要な実装面は明示する。

棚卸し対象。

- `packages/core-schemas`
- `packages/runtime`
- `packages/policy-engine`
- `packages/audit`
- `packages/capability-registry`
- `packages/workspace-store`
- `packages/ui-protocol`
- `apps/server`
- `apps/web`

後続実装の完了条件。

- 旧安全ループ用パッケージを削除または履歴系パッケージへ改名する。
- 旧manifest系schemaを `ActionCatalogEntry` 系へ置換する。
- `/api/audit`、`/api/activity` を `/api/runs`、`/api/run-events` などへ置換する。
- socket eventを `backend.run.*`、`backend.event.*`、`workspace.change.*`、`memory.suggestion.*`、`skill.candidate.*` へ寄せる。
- UI locale keyから旧中核語彙を削除または履歴語彙へ置換する。
- `runtime.runChatTurn()` 直結を、後続で `AgentBackendRegistry` 経由に置換する。

---

## 11. Test Plan

最低限通すもの。

- `git diff --check`
- `git diff -- PRINCIPLES.md ARCHITECTURE.md plans/v1-mvp-implementation.md AGENTS.md WEB_UI_DESIGN.md PUBLIC_NAMING.md`

旧中核語彙検索は、対象6ファイルでゼロを目標にする。
検索語は、v0.6以前の安全中核、decision系schema、manifest系schema、activity系read model、強制確認系enumを対象にする。

単体語としての `Policy`、`Audit`、`Rollback`、`Approval` は、公開命名や過去コード棚卸しの文脈で残る可能性がある。
ただし、中核概念としては残さない。

新方針語彙の検索。

```sh
rg -n "Agent Backend cassette|ClaudeCodeBackend|CodexBackend|SamuraiNativeBackend|BackendEventRecord|BackendRunRecord|Memory suggestion|Skill candidate|Reflection|Curator|Workspace|Artifact|Collection" PRINCIPLES.md ARCHITECTURE.md plans/v1-mvp-implementation.md AGENTS.md WEB_UI_DESIGN.md PUBLIC_NAMING.md
```

参照元固有名の検索。

```sh
rg -n "MulmoClaude|Hermes Agent|OpenClaw|MulmoScript|gui-chat-protocol|Claude Code SDK" .
```

許可。

- `ARCHITECTURE.md`
- `PRINCIPLES.md`
- `AGENTS.md`
- `PUBLIC_NAMING.md`
- `plans/`
- `Hermes_Agent_解説.md`

違反。

- README
- UI
- API
- route
- package
- database
- env / config
- public docs
- example code

---

## 12. 未確定事項の扱い

実装を止める未確定事項は残さない。

残る項目は以下に分類する。

- v1後続。
- UI詳細。
- 公開前polish。

v1実装中に迷った場合は、`ARCHITECTURE.md v0.7` の `10. v1 MVP Cut Line` を優先する。
