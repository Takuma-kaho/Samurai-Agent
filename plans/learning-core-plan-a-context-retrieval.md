# Plan A: Learning Context / Retrieval Foundation

作成日: 2026-07-10

## 0. 目的

この計画は、学習Coreの土台として次の3領域をまとめて実装する。

1. Memory・Skillの候補選択と実利用を区別する。
2. Skill本文と補助ファイルを必要時だけ読む正準経路を完成させる。
3. 過去会話検索を日本語対応の全文検索へ強化する。

ユーザーから見ると、AIが関係しそうな手順を大量に抱え込まず、必要な手順と過去会話だけを正確に参照できる状態を作る計画である。

---

## 1. 現在地

すでにあるもの。

- `WorkspaceStore.searchSkills()`は、Skill名、説明、タグ、本文、capabilityを検索できる。
- Runtimeは候補を採点し、最大5件のSkillを選べる。
- Codex / Claude Codeなどの外部Backendには、Skill本文ではなくID、概要、file refを渡すpointer-first設計がある。
- Backendは`file.read`などを使えばSkill本文を後から読める。
- `skill_usage`にはuse count、last used、last runがある。
- Session、Message、Artifactの横断検索APIがある。

現在の不足。

- Skillを候補に選んだ時点で利用回数が増えるため、実際に本文を読んだか分からない。
- `decideSkillDisclosureLevel()`は常に`catalog`を返す。
- Skill専用の正準read operationがなく、一般的なfile readへ依存する。
- support fileを実際に読んだrunを特定できない。
- BackendごとにSkill読込の実効性を保証する契約テストがない。
- Session SearchはSQLite `LIKE`中心で、日本語、表記揺れ、大量履歴に弱い。

---

## 2. 重要な設計判断

### 2.1 全文を最初から渡さない

現在のpointer-first方針を維持する。

```text
Hostが候補を選ぶ
↓
Backendへ名前・概要・参照先だけ渡す
↓
Backendが必要性を判断する
↓
skill.viewで本文を読む
↓
必要ならsupport fileを読む
```

Skill本文を最初から全量Promptへ入れる実装にはしない。

### 2.2 候補と実利用を分ける

次の状態を区別する。

| 状態 | 意味 |
| --- | --- |
| `selected` | Hostが関連候補としてBackendへ提示した |
| `body_loaded` | BackendがSkill本文を実際に開いた |
| `support_loaded` | Backendが補助ファイルを実際に開いた |

「役に立った」はPlan BのEvaluationが判断するため、Plan Aでは記録しない。

### 2.3 Backend選択とは混ぜない

SkillはCodex / Claude Codeを選ぶための情報ではない。

- Backend selection: どの実行エンジンへ任せるか
- Skill selection: 選ばれた実行エンジンへ、どの手順候補を見せるか

この2つの責務を分離したままにする。

### 2.4 日本語検索を前提にする

HermesのFTS5を概念として参照するが、英語向けtokenizerをそのまま採用しない。

推奨構造。

- 通常のFTS5 index
- FTS5 trigram indexまたは同等の日本語部分検索index
- FTS5非対応環境のLIKE fallback
- index再構築operation

---

## 3. 実装する契約

### 3.1 LearningResourceUseRecord

Core schemaへ、最小限の利用記録を追加する。

候補フィールド。

```text
id
run_id
session_id
resource_kind: memory | wiki | skill | skill_support | session_result
resource_id
resource_version または content_hash
stage: selected | body_loaded | support_loaded
source_operation_id
created_at
metadata
```

入れないもの。

- success / failure
- accepted
- quality score
- user satisfaction
- Outcome

### 3.2 Skill View operation

正準操作を追加する。

```text
skill.view
  input:
    skill_id
    path?          # support fileを読む場合
    run_id
  output:
    skill metadata
    content
    file refs
    disclosure level
```

Provider tool aliasesの候補。

```text
samurai.skill.view
mcp__samurai__skill_view
```

この操作は以下を行う。

- Skillの存在とstateを確認する。
- Workspace外のpathを拒否する。
- 本文または許可されたsupport fileだけを返す。
- `body_loaded`または`support_loaded`を記録する。
- Backend runとの参照を残す。

### 3.3 Session Search index

SQLite migrationで検索indexを追加する。

対象。

- session title
- user / agent message本文
- Artifact titleと検索用本文

原則。

- source tableを正本とする。
- FTS tableはread modelとする。
- insert / update / delete時にindexを同期する。
- migration後に既存データをreindexする。
- index破損時に再構築できる。

---

## 4. 実装ステップ

### A1. SchemaとStore

- `LearningResourceUseRecordSchema`を追加する。
- SQLite tableとindexを追加する。
- save / list / filter APIを追加する。
- 既存`skill_usage`は集計read modelとして残す。
- `selected`からuse countを増やさないよう意味を修正する。
- `body_loaded / support_loaded`から実利用回数を集計する。

### A2. Skill View

- Action Catalogへ`skill.view`を追加する。
- RuntimeのDomain Commandへ接続する。
- MCP / Backend tool bridgeへ公開する。
- Skill本文とsupport fileのpath validationを追加する。
- Codex / Claude Code / Nativeへ同じtool contractを渡す。
- Context handoffのfile refは互換性のため維持する。

### A3. Skill selectionとprompt

- 候補選択時に`selected`を記録する。
- PromptへはID、名前、説明、参照先のみ渡す。
- 「必要ならskill.viewを呼ぶ」ことをBackend promptへ明記する。
- 本文を開かなかったSkillを実利用扱いしない。
- support file一覧は概要だけにし、内容はオンデマンドにする。

### A4. Session Search

- FTS5 capability probeを追加する。
- 通常FTSとtrigram系indexを作る。
- 日本語queryはtrigram系を優先する。
- 英数字queryは通常FTSのrankを優先する。
- Session lineage、日時、sourceをrankingへ利用できる形にする。
- FTS unavailable時は現在のLIKE検索へfallbackする。

### A5. 診断

- Skill候補数、本文読込数、support読込数を診断へ出す。
- Session SearchがFTS / trigram / LIKEのどれで動いたか確認できるようにする。
- index stale / missingをWorkspace healthへ出す。

---

## 5. 主な変更候補

| 場所 | 変更内容 |
| --- | --- |
| `packages/core-schemas/src/index.ts` | 利用記録とskill.view入出力schema |
| `packages/action-catalog/src/index.ts` | `skill.view`の正準command |
| `packages/workspace-store/src/index.ts` | 利用記録、FTS migration、reindex、search |
| `packages/runtime/src/index.ts` | 候補選択、skill.view dispatch、利用イベント発行 |
| `packages/agent-backends/src/index.ts` | pointer-first promptとtool contract |
| `apps/server/src/index.ts` | 必要なAPI / MCP bridge / diagnostics |
| `packages/learning/` | 利用記録とretrievalの純粋ロジック |

Runtimeへ新しい判定関数を増やし続けず、`packages/learning`へ切り出す。

---

## 6. テスト計画

### Schema / Store

- `selected`を保存できる。
- `body_loaded`と`support_loaded`をrun別に取得できる。
- 同一run・resource・stageの重複を防げる。
- FTS migrationが既存DBへ適用できる。
- reindexで既存Sessionが検索できる。

### Skill View

- Skill本文を取得できる。
- support fileを取得できる。
- `../`などWorkspace外pathを拒否する。
- archived / missing Skillを適切に扱う。
- 本文を読んだ時だけ実利用回数が増える。
- Codex / Claude Code / Nativeで同じtool schemaになる。

### Session Search

- 日本語の空白なし文章を検索できる。
- 英数字の検索rankを保てる。
- Session、Message、Artifactを区別できる。
- FTS5非対応時にLIKEへfallbackできる。

---

## 7. 完了条件

- Backendへ渡す初期Skill情報は概要と参照先だけである。
- Backendが本文を必要時だけ`skill.view`で読める。
- support fileも同じ契約で必要時だけ読める。
- Skill候補と実読込をrun単位で区別できる。
- 実読込に基づいてSkill利用回数を集計できる。
- Codex、Claude Code、Nativeで契約テストが通る。
- 日本語の過去会話をFTS/trigram系indexで検索できる。
- LIKEはfallbackとしてのみ残る。
- `pnpm typecheck`と関連testが成功する。

---

## 8. Plan Bへの受け渡し

Plan Bは以下を前提にできる。

- どのrunでどのSkill本文を読んだか分かる。
- どのversion / hashのMemory・Skillを使ったか分かる。
- 過去会話検索結果の参照をrunへ結び付けられる。
- 候補に出ただけのSkillを効果測定から除外できる。
