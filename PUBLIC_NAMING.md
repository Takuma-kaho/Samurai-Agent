# Public Naming Rules

## 0. この文書の目的

この文書は、Samurai Agent を公開・OSS化する時に、参照元プロジェクトの固有名詞や借り物感の強い用語が外向きに出ないようにするための命名ルールである。

重要なのは、参照元を隠すことではない。

実装中は、参照元との対応関係を追えることが大事である。
ただし、ユーザーや外部開発者が見る場所では、Samurai Agent 自身の名前と概念で説明する。

---

## 1. 基本方針

- 内部設計文書では、参照元固有名を残してよい。
- 公開面では、参照元固有名を使わない。
- 一般的な技術語は、無理に日本語化しない。
- 借り物感が強い用語は、公開面に出す前に Samurai Agent 側の正式名を決める。

---

## 2. 固有名を残してよい場所

以下は内部理解・設計履歴のため、参照元固有名を残してよい。

- `ARCHITECTURE.md`
- `PRINCIPLES.md`
- `AGENTS.md`
- `plans/`
- 参照元調査メモ
- 設計レビュー
- 実装前の比較表
- ライセンスや出典を説明する文脈
- 参照元URLを固定する内部設計文脈

理由。

- どの判断がどの参照元に由来するか追えるようにするため。
- 実装中に「これは何を参考にした設計か」が迷子にならないようにするため。

---

## 3. 固有名を出さない場所

以下は公開面または公開面になりやすいので、参照元固有名を使わない。

- README
- 公式サイト
- 本番UI文言
- API名
- route名
- package名
- database table / column名
- env var
- config key
- example code
- generated artifact template
- public docs

理由。

- Samurai Agent が参照元プロジェクトのクローンに見えるのを避けるため。
- 外部のユーザーや開発者に、Samurai Agent 自身のプロダクトとして理解してもらうため。

---

## 4. 公開面で使わない語

| 内部では使ってよい語 | 公開面での扱い | 備考 |
| --- | --- | --- |
| `MulmoClaude` | 使わない | 参照元としては内部文書に残す |
| `Hermes Agent` | 使わない | 参照元としては内部文書に残す |
| `OpenClaw` | 使わない | 参照元としては内部文書に残す |
| `MulmoScript` | 使わない | 固有機能名なので公開面に出さない |
| `gui-chat-protocol` | 使わない | 参照元由来のプロトコル名として扱う |
| `Claude Code SDK` | 使わない | 依存しない方針は内部設計で説明する |

---

## 5. 注意して使う語

以下は一般語として使えるが、参照元文脈と強く結びつく場合は公開面での名前を別途決める。

| 語 | 方針 |
| --- | --- |
| `DSL` | 公開面に出す前に、Samurai Agent 側の正式名を決める |
| `Collection DSL` | 公開面では避ける。データ操作機能の正式名を別途決める |
| `Workspace is the agent` | 公開面ではそのまま使わず、Samurai Agent の説明文に言い換える |
| `Chat summons GUIs` | 公開面ではそのまま使わず、画面が会話から開く体験として説明する |
| `Universal controller` | 公開面では使わない |

---

## 6. そのまま使ってよい一般語

以下は一般的なAI・ソフトウェア用語として使ってよい。

- Memory
- Skill
- Runtime
- Gateway
- Artifact
- Policy
- Audit
- Rollback
- Session
- Workspace
- Provider
- Sandbox
- Capability

ただし、公開面で使う場合は、Samurai Agent 内での意味が伝わるように説明を添える。

---

## 7. 実装時のチェック

公開面に関わる変更をした時は、次を確認する。

```sh
rg -n "MulmoClaude|Hermes Agent|OpenClaw|MulmoScript|gui-chat-protocol|Claude Code SDK" .
```

許可される検出先。

- `ARCHITECTURE.md`
- `PRINCIPLES.md`
- `AGENTS.md`
- `plans/`
- `PUBLIC_NAMING.md`
- `Hermes_Agent_解説.md`
- 参照元調査メモ
- ライセンスや出典を説明する文脈

修正すべき検出先。

- README
- UI
- API
- route
- package
- database
- env / config
- public docs

`DSL` は禁止語ではない。
ただし、公開面で使う場合は、Samurai Agent の正式な公開名を決めてから使う。
