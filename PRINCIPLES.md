# Samurai Agent Principles

## 0. この文書の位置づけ

この文書は、Samurai Agent の設計思想、判断基準、前提を固定するための文書である。

目的は、ユーザーの頭の中の前提と、実装者やAIの前提がズレないようにすること。

文書の優先順位は以下。

1. `PRINCIPLES.md`: なぜそう作るのか、何を優先するのか
2. `ARCHITECTURE.md`: どう分解し、どう実装するのか
3. `PUBLIC_NAMING.md`: 公開面でどの名前を使うか、使わないか
4. `plans/`: レビュー、改訂方針、作業計画
5. `Hermes_Agent_解説.md`: Hermes Agent を理解するための補助資料

---

## 1. Samurai Agent が作るもの

Samurai Agent は、チャットAIでもCLI Agentでもない。

作るものは以下。

> 人間とAIが同じ作業机を触る、GUI-first な Personal Agent Workspace。

その上に「自分専用に育つAI秘書」という体験を載せる。

重視すること。

- 個人の記憶、好み、作業手順、成果物を長期的に扱う。
- 人間が成果物、記憶、スキル、履歴、実行範囲を画面で確認できる。
- Agent は境界内で自律的に観察、判断、実行、記録する。
- 境界を越える時だけ人間を呼ぶ。
- 実行結果は後から追える形で残す。

---

## 2. 作らないもの

Samurai Agent は、以下を目指さない。

- 単なるチャットボット。
- CLI Agent のGUIラッパー。
- MulmoClaude / Hermes Agent / OpenClaw の単純な合体。
- 毎回ユーザー承認を求める承認UI中心のAgent。
- すべての会話、文章生成、思考をDSL化する仕組み。
- 最初から多チャネルGateway、音声秘書、plugin marketplaceを全部載せた大きなシステム。

特に重要な前提。

- 承認を増やすことは、安全性そのものではない。
- 承認が多すぎると、Agent Loop の価値が消える。
- 安全は、承認ではなく、境界、権限、監査、復元可能性で作る。

---

## 3. GUI-first

チャットは入口だが、本体ではない。

本体は Workspace である。

GUI-first である理由。

- 成果物、表、グラフ、顧客情報、記憶、スキルは画面で見えた方が強い。
- 人間が「何が起きたか」「何が保存されたか」「何を承認すべきか」を確認できる必要がある。
- Agent の行動は、見えない裏側ではなく、画面上の活動として理解できるべき。

実装判断。

- 迷ったら、チャット欄だけで完結させない。
- Artifact、Memory、Skill、Policy、Audit が見える導線を優先する。
- 画面で扱うべきものを、ログやプロンプト内だけに閉じ込めない。

---

## 4. Workspace-first

Workspace は、Samurai Agent の土台である。

AIも人間も同じWorkspaceを触る。

Workspaceに置くもの。

- profile
- prompt
- memory
- skills
- collections
- artifacts
- sessions
- audit
- files
- indexes
- system

基本方針。

- ユーザーが直接見たいものは filesystem に置く。
- 整合性、検索、履歴、queue が必要なものは SQLite に置く。
- Agent の価値は、Workspace に記憶、スキル、成果物、履歴が蓄積されることで育つ。

---

## 5. Policy-Bounded Agent Loop

中核思想は **Policy-Bounded Agent Loop**。

つまり以下。

```text
Human sets boundaries
Agent loops inside boundaries
Human intervenes on boundary crossing
```

日本語では以下。

- 人間は毎回承認する人ではない。
- 人間は、Agent が動ける境界を与える人。
- Agent は境界内で自律的に動く。
- 境界を越える時だけ、人間を呼ぶ。

この設計は、Human In The Loop ではなく **Human On The Loop** を基本にする。

実装判断。

- 承認待ちが発生しても、Agent Loop 全体を止めない。
- 承認が必要な operation だけを保留する。
- 読み取り、下書き、説明、プレビューなど安全な処理は継続できるようにする。

---

## 6. Selective DSL

すべてをDSL化しない。

DSL化すべきもの。

- 状態を変更する操作。
- 外部に影響する操作。
- 監査、承認、rollback が必要な操作。
- Capability として再利用したい操作。

DSL化しすぎないもの。

- 通常の会話。
- 自由な文章生成。
- まだ構造が固まっていない思考や探索。

実装判断。

- 構造化するほど安全になる操作だけDSL化する。
- 何でもDSLに押し込んで、秘書体験を硬くしない。

---

## 7. 安全設計

安全は、承認ボタンの数ではなく、境界で作る。

使う境界。

- scope
- toolset
- policy
- sandbox
- SecretRef
- audit
- rollback
- approval

LLMに決めさせないもの。

- risk
- scope
- reversibility
- secret requirement
- external impact

これらは、LLMの自己申告ではなく、Capability / Policy / Runtime 側の静的定義と評価で決める。

外部コンテンツの扱い。

- 外部コンテンツはデータとして扱う。
- 外部コンテンツを命令として扱わない。
- 外部由来Memoryは保存、検索、参照できる。
- ただし、外部由来Memoryから tool intent や外部送信を直接発火させない。

rollback の限界。

- rollback は Workspace 内の可逆変更に効く。
- 送信、公開、支払い、外部削除は rollback できない。
- rollback できない操作は、事前Policyと承認で守る。

---

## 8. Multilingual by Default

Samurai Agent は、多言語対応を後から足す翻訳作業として扱わない。

多言語対応は、Workspace、Memory、Artifact、Agent出力の初期設計の一部である。

理由。

- ユーザーは日本語UIで、英語資料を読み、英語Artifactを作ることがある。
- 外部コンテンツ、Memory、Artifact、Auditは、それぞれ別の言語を持つことがある。
- 後から多言語化すると、保存データ、検索、Agent出力、Policy判断の境界が混ざりやすい。
- 言語が違っても、安全境界と監査可能性は同じように守る必要がある。

実装判断。

- `ui_locale`、`output_locale`、`source_locale`、`content_locale` を混ぜない。
- 原文は必ず保持し、翻訳は派生データとして扱う。
- 内部enum、Policy decision、Capability、Auditの正準値は翻訳しない。
- 表示文言、Agent出力、Artifact本文は、必要なlocaleに合わせる。
- v1から `en`、`ja`、`zh`、`ko`、`es`、`pt-BR`、`fr`、`de` をseed localeとして扱う。
- 設計・文案のcanonicalは `ja`、first-class localeは `en` とする。

---

## 9. OSS参照元の扱い

MulmoClaude / Hermes Agent / OpenClaw は、そのまま結合する対象ではない。

それぞれの勝ち筋を参照し、Samurai Agent として greenfield に再構成する。

正式な参照元は、`ARCHITECTURE.md` の `Reference Sources` を正本とする。

ここでの参照元固有名は、内部設計上の索引である。

- 実装中は、どの判断がどの参照元に由来するか追えるように残す。
- 公開名、製品名、README、UI文言、API名、package名には使わない。
- 公開面の命名は `PUBLIC_NAMING.md` に従う。
- Memory / Skill / Runtime / Gateway などの一般的な技術語は、無理に日本語化しない。
- `DSL` は今すぐ全面置換しない。ただし公開面に出す前に、Samurai Agent 側の正式名を決める。

役割分担。

- MulmoClaude: GUI、Workspace、Artifact、Collection DSL、Plugin UI の参照元。
- Hermes Agent: Runtime、Memory、Skill、Self-improvement、Provider abstraction の参照元。
- OpenClaw: Gateway、Session routing、Pairing、Sandbox、External boundary の参照元。

実装判断。

- MulmoClaude のGUI思想は採用するが、Claude Code SDK 依存を中核にしない。
- Hermes の育つAgent思想は採用するが、CLI/TUI中心にはしない。
- OpenClaw のGateway境界は採用するが、初期から多チャネル全部盛りにしない。

---

## 10. 責務分離

GUI / Runtime / Gateway / Memory / Policy / Audit の責務を混ぜない。

基本の役割。

- GUI: 人間が見る、直す、承認する、理解する場所。
- Runtime: Agent が考え、toolを使い、結果を見て続ける場所。
- Gateway: Web UI以外の入口や外部チャネルを安全に受ける境界。
- Memory: 長期的に残す事実、好み、作業手順、文脈。
- Policy: 何を自動でできるか、何を承認すべきかを決める場所。
- Audit: 何が起きたか、なぜ起きたか、戻せるかを残す場所。

実装判断。

- GUIだけでPolicy判断しない。
- Runtimeだけで権限判断しない。
- Memoryに外部命令を混ぜない。
- Auditは後付けログではなく、Agent Loop の一部として扱う。

---

## 11. 判断に迷った時の優先順位

迷ったら、以下の順に優先する。

1. ユーザーの境界を守る。
2. Agent Loop を不要に止めない。
3. 人間が画面で理解できるようにする。
4. 監査とrollback可能性を残す。
5. OSSの元実装より、Samurai Agent の体験を優先する。
6. 一気に広げず、縦切りで価値を通す。
7. 仕様を増やす時は、後から読む人が迷わない粒度で残す。

この優先順位に反する変更は、先に設計意図を確認する。
