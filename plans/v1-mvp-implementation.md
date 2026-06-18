# v1 MVP Implementation Plan

## 0. この文書の位置づけ

この文書は、Samurai Agent v1 MVPの実装順を固定するための作業計画である。

source of truthの優先順位は以下。

1. `PRINCIPLES.md`: 設計思想・判断基準・前提
2. `ARCHITECTURE.md`: 実装前アーキテクチャ仕様
3. `PUBLIC_NAMING.md`: 公開面の命名ルール
4. `plans/`: 作業計画、レビュー、改訂方針

この計画は `ARCHITECTURE.md v0.6` を前提にする。

---

## 1. v1 MVPの完成条件

v1 MVPは、機能を全部そろえることではない。

完成条件は、以下の縦切りが実際に動くこと。

```text
Chat
↓
Surface Protocol
↓
MessageEnvelope
↓
Session routing
↓
Active Memory retrieval
↓
Skill selection
↓
Proposal Capability
↓
OperationRecord
↓
PolicyEvaluationInput
↓
evaluatePolicy(input): PolicyDecisionRecord
↓
Artifact draft
↓
Memory / Collection minimal update
↓
ApprovalRequest if needed
↓
AuditRecord
↓
RollbackPoint
↓
Home activity / Notification Inbox read model
```

この縦切りは、機能一覧を広げるためではなく、MulmoClaude由来のGUI / Workspace操作をClaude Code非依存の自前Runtimeへ接続できるかを確認するためのものでもある。

v1では、画面だけを先に作る状態にしない。

GUIから出た操作が、Surface Protocol、Agent Runtime、Policy、Auditまで通ることを完成条件に含める。

ユーザーから見た完成条件。

- Chatから依頼できる。
- 生成されたArtifactを画面で見られる。
- Agentが何を読んで、何を変えたかAuditで追える。
- 承認が必要なoperationだけ止まり、下書きや説明は続く。
- Memoryに保存された内容を確認・無効化できる。
- Homeで自律実行、承認待ち、失敗、rollback候補に気づける。
- UI、Agent出力、Memory、Artifactがlocale前提で壊れない。

---

## 2. v1対象

v1に入れるもの。

| 領域 | 対象 |
| --- | --- |
| GUI | Home / Chat / Artifact / Memory / Audit |
| Surface Protocol | GUI operation / artifact update / approval request の最小表現 |
| Approval / Notification Inbox | HomeまたはChat内パネル |
| Runtime | ProviderAdapter / Tool loop / Event stream / Session store |
| Policy | Capability manifest / OperationRecord / ApprovalRequest / PolicyDecisionRecord |
| Localization / i18n | 8 locale seed、locale file、output_locale付きPromptBuilder、locale-aware schema |
| Workspace store | filesystem + SQLite |
| Memory | session / provisional / topic / Active Memory minimal |
| Artifact | draft作成、保存、参照 |
| Skill | candidate生成、project保存、skill index生成 |
| Collection | schema定義、record作成、小さなpatch適用 |
| Audit | AuditRecord、RollbackPoint、Home activity |
| Gateway | web source、cron sourceの入口だけ |
| Automation | memory reviewの小さなcron |

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
- skill curator / collection check cron。
- OS通知、メール通知、外部push通知。

これらは、v1後続、UI詳細、公開前polishに分類する。

---

## 4. 推奨ディレクトリ構成

```text
apps/
  web/
  server/

packages/
  core-schemas/
  capability-registry/
  workspace-store/
  localization/
  policy-engine/
  runtime/
  audit/
  memory/
  artifacts/
  skills/
  collections/
  gateway/
  ui-protocol/
```

責務を混ぜない。

- GUIは、人間が見る、直す、承認する場所。
- Runtimeは、Agentが考え、toolを使い、結果を見て続ける場所。
- Gatewayは、入口とsession routingを扱う場所。
- Memoryは、長期的に残す事実、好み、手順、文脈。
- Policyは、何を自動でできるか、何を承認すべきかを決める場所。
- Auditは、何が起きたか、なぜ起きたか、戻せるかを残す場所。

---

## 5. 実装順序

この順で進める。

1. Core Schemas
2. Localization / i18n scaffold
3. Capability registry / manifest seed
4. Surface Protocol minimal
5. Workspace store
6. Policy Engine
7. Audit / OperationRecord / ApprovalRequest
8. Chat session
9. GUI to Runtime connection spike
10. Memory minimal
11. Artifact draft
12. Home activity
13. Notification Inbox read model
14. Skill / Collection minimal backend

---

## 6. Core Schemas

最初に `ARCHITECTURE.md v0.6` の `5.14 Canonical Core Schemas` を型として固定する。

必須。

- `ResourceRef`
- `SupportedLocale`
- `TranslationStatus`
- `LocalizedText`
- `MessageEnvelope`
- `PolicyEvaluationInput`
- `CapabilityManifest`
- `CapabilityOperation`
- `MemoryFrontmatter`
- `SkillFrontmatter`
- `ArtifactRecord`
- `CollectionSchema`
- `CollectionRecord`
- `CollectionPatch`
- `GrantRecord`
- `OperationRecord`
- `ApprovalRequest`
- `PolicyDecisionRecord`
- `AuditRecord`
- `RollbackPoint`

`NotificationInboxItem` と `SkillIndexEntry` は保存モデルではなくread model。

locale関連の必須フィールド。

- `MessageEnvelope`: `input_locale` / `output_locale`
- `MemoryFrontmatter`: `source_locale` / `content_locale`
- `ArtifactRecord`: `locale` / `source_locales`
- `CollectionSchema`: `labels` / `descriptions` をlocale mapとして扱う

---

## 7. Localization / i18n 初期実装

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
- Policy / Audit / Capability の内部値は翻訳しない。
- Agent RuntimeのPromptBuilderは必ず `output_locale` を受け取る。

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

## 8. Policy Engine

正準API。

```text
evaluatePolicy(input): PolicyDecisionRecord
```

評価の基本。

- risk / scope / reversibility / external impact / secret requirement はLLMに決めさせない。
- それらは `CapabilityManifest.operations[]` から読む。
- grant粒度は `capability_id + operation + actor_identity + channel + resource_scope`。
- manifest versionやrisk snapshotが変わったら再確認する。
- 複数条件が当たる場合は、最も制限的なDecisionを採用する。

---

## 9. GUI最小要件

v1必須画面。

- Home: activity、承認待ち、失敗、rollback候補。
- Chat: 依頼、実行状況、承認パネル。
- Artifact: draft表示、保存状態、参照元。
- Memory: provisional / topic の確認、無効化。
- Audit: operation、policy decision、affected resources、rollback point。

専用画面なしでよいもの。

- Skill: index生成とproject保存まで。
- Collection: schema、record、patch適用まで。
- Approval / Notification Inbox: Home/Chat内パネルでよい。

---

## 10. Test Plan

最低限通すもの。

- `git diff --check`
- `git diff -- ARCHITECTURE.md plans/v1-mvp-implementation.md AGENTS.md PRINCIPLES.md PUBLIC_NAMING.md`
- `rg -n "DESIGN.md" .`
- `rg -n "PUBLIC_NAMING.md" AGENTS.md PRINCIPLES.md PUBLIC_NAMING.md`
- `rg -n "locale|i18n|多言語|Localization" PRINCIPLES.md ARCHITECTURE.md plans/v1-mvp-implementation.md`

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

Policy fixture観点。

- 全 decision 分岐。
- grant 有効 / 期限切れ / 失効 / version不一致。
- external content 由来の高リスク intent。
- approval pending 中に安全な作業だけ継続するケース。
- Artifact / Memory / Collection / Skill / Operation が `ResourceRef` で追えるケース。
- 英語以外の外部コンテンツに危険命令が含まれても、owner instructionへ昇格しないケース。
- 8 localeすべてでUI key欠落がないケース。

i18n check観点。

- `locales/{en,ja,zh,ko,es,pt-BR,fr,de}.json` のkeyが一致する。
- `missing` translation statusが残っていない。
- `verified / draft / missing` 以外のtranslation statusを拒否する。
- Runtime promptに `output_locale` が渡っていない場合はテストで落とす。

---

## 11. 未確定事項の扱い

実装を止める未確定事項は残さない。

残る項目は以下に分類する。

- v1後続。
- UI詳細。
- 公開前polish。

v1実装中に迷った場合は、`ARCHITECTURE.md v0.6` の `5.14 Canonical Core Schemas` と `8.2 v1 MVP Cut Line` を優先する。
