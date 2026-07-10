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
Samurai Agentは、
> 会話を中心に、人間とAIが同じ仕事状態を育てる Personal Agent Interface。

その上に「自分専用に育つAI秘書」という体験を載せる。

重視すること。

- 個人の記憶、好み、作業手順、成果物を長期的に扱う。
- Agent の実行部は固定せず、外部Agentや自前Agentを差し替えられる。
- 実行結果は Workspace、Artifact、Memory、Skill に戻ってくる。
- 使うほど、Memory と Skill が育つ。

---

## 2. 作らないもの

Samurai Agent は、以下を目指さない。

- 単なるチャットボット。
- CLI Agent の薄いGUIラッパー。
- 従来アプリ固有の複雑なUIを、Workspace内へ再現して並べ直す仕組み。
- 独自の安全制御を主役にしたAgent基盤。
- すべての会話、文章生成、思考をDSL化する仕組み。
- 最初から多チャネルGateway、音声秘書、plugin marketplaceを全部載せた大きなシステム。

特に重要な前提。

- 独自性は、安全制御ではなく、できることの拡張で出す。
- 外部Agentが持つ確認や制限は尊重するが、Samurai Agent 側で独自の承認中核を作らない。
- 記憶、スキル、成果物、Workspace体験を育てることを優先する。

---

## 3. Chat-first / UI on demand

Chatは、初回命令だけを送る入口ではない。ユーザーとAIが意図をすり合わせ、作業を継続する主要インターフェースである。

Generative UIは独立アプリではなく、会話の文脈に応じて選ばれる返答・確認・操作の表現形式である。

- 文章やMarkdownで十分なら、UIを増やさない。
- 成果物を確認したい時はArtifactを見せる。
- 比較、選択、直接修正が速い時だけ、表、フォーム、グラフ、プレビューなどのUIを出す。
- 必要がなくなったUIは閉じてよい。仕事状態はWorkspaceに残る。

実装判断。

- 話した方が速ければ会話を使う。
- 見た方が速ければUIを出す。
- 触った方が速ければ操作可能にする。
- 不要ならUIを出さない。
- Artifact、Memory、Skill、Collection、Run History、Backend eventは、必要時に理解・確認できる導線を持つ。
- UIをログやプロンプト内だけに閉じ込めないが、常設ダッシュボードの主役にも置かない。

---

## 4. Workspace-backed state

Workspace は、Samurai Agent の永続状態の正本である。表示上の主画面やアプリ一覧を意味しない。

AIも人間も同じWorkspace状態を読み書きする。

Workspaceに置くもの。

- profile
- prompt
- memory
- skills
- collections
- artifacts
- sessions
- backend runs
- backend events
- workspace changes
- files
- indexes
- system

基本方針。

- ユーザーが直接見たいものは filesystem に置く。
- 整合性、検索、履歴、queue が必要なものは SQLite に置く。
- Agent の価値は、Workspace に記憶、スキル、成果物、履歴が蓄積されることで育つ。
- Collectionは、AIと人間が共有する構造化データであり、独立アプリではない。
- Artifactは、会話やBackend実行から生まれる成果物であり、独立アプリではない。

---

## 5. Agent Backend Cassette

Samurai Agent の中核は、実行部を固定しない Host 構造である。

```text
Samurai Agent Host
  Chat / Surface / Workspace / Memory / Skill / Gateway
  AgentBackend cassette
    ClaudeCodeBackend
    CodexBackend
    SamuraiNativeBackend
    future external backends
```

考え方。

- Host は、Workspace、Memory、Skill、Artifact、Gateway を束ねる。
- Backend cassette は、実際に作業するAgent実行部である。
- Claude Code、Codex、自前実装は、同じ差し替え口の候補として扱う。
- `ProviderAdapter` は中核の差し替え口ではなく、`SamuraiNativeBackend` 内部のモデル差し替え口である。

実装判断。

- v1では、まず差し替え口とイベント正規化を作る。
- 最初から全Backendを完成させない。
- 外部Agentを使う場合、そのAgentが持つ確認、tool制限、sandboxをSamurai側の状態表示として扱う。
- Samurai Host側に独自の承認中核を再導入しない。

---

## 6. Memory / Skill Improvement Loop

Samurai Agent の独自性は、使うほど育つことにある。

育てるもの。

- Memory: 毎回効かせる短い個人理解。好み、作業スタイル、重要ルール、短い教訓。
- Knowledge Wiki: 濃い知識。記事、調査、設計、プロジェクト知識、技術、意思決定。
- Skill: 記憶ではなく、よくやる作業を再利用可能にした手順。
- Session Search: SQLiteで過去会話を探すための検索面。長期Memoryの正本ではない。
- External Provider: 検索、関連付け、抽出の補助。正本ではない。
- Reflection: 実行後に、何を覚えるべきか、何をSkill化すべきかを見つける処理。
- Curator: 増えすぎたMemoryやSkillを整理する処理。

基本フロー。

```text
User asks
Host builds context
Backend cassette runs
Backend events return
Workspace / Artifact updates
Memory suggestion / Skill candidate appears
Reflection improves future runs
```

実装判断。

- MemoryやSkillは、外部Agentの中だけに閉じ込めない。
- Workspace側に、後から見える形で残す。
- Memory、Knowledge Wiki、Skillの正本はWorkspace内のMarkdownに置く。
- SQLiteは検索、履歴、index、状態管理に限定する。
- External Provider由来の内容は、参照元付きの提案として扱い、acceptedされるまで正本にしない。
- 参照元不明のProvider情報は保存せず、診断上の未検証ヒントに留める。
- 自動改善は、ユーザーが理解できる候補として表示する。
- 初期v1では、候補生成と表示を優先し、高度な自動整理は後回しにする。

---

## 7. Selective Structure

すべてを構造化しない。

構造化すべきもの。

- Agent Backend へ渡す作業単位。
- Workspace、Artifact、Memory、Skill、Collection に戻す結果。
- Plugin や tool へ渡す入力。
- 後から検索、再開、表示したいイベント。

構造化しすぎないもの。

- 通常の会話。
- 自由な文章生成。
- まだ構造が固まっていない思考や探索。

実装判断。

- 構造化は安全制御のためではなく、Workspaceに戻せる形にするために使う。
- 何でも型に押し込んで、秘書体験を硬くしない。

---

## 8. External Boundary

外部Agentや外部サービスと接続する以上、境界は必要である。

ただし、この境界はSamurai Agentの独自性ではない。

扱う境界。

- sandbox
- allowed tools
- MCP config
- SecretRef
- path normalization
- pairing
- allowlist
- external backend native confirmation

実装判断。

- 外部Backendが自前で確認待ちになった場合、Samurai Hostは状態を表示、または中継するだけ。
- Host側で独自の可否判定レイヤーを作らない。
- secretや外部接続は、BackendやGatewayの運用境界として扱う。
- 外部由来コンテンツはデータとして扱い、ユーザーやHostの命令として扱わない。

---

## 9. Multilingual by Default

Samurai Agent は、多言語対応を後から足す翻訳作業として扱わない。

多言語対応は、Workspace、Memory、Artifact、Agent出力の初期設計の一部である。

理由。

- ユーザーは日本語UIで、英語資料を読み、英語Artifactを作ることがある。
- 外部コンテンツ、Memory、Artifactは、それぞれ別の言語を持つことがある。
- 後から多言語化すると、保存データ、検索、Agent出力の境界が混ざりやすい。

実装判断。

- `ui_locale`、`output_locale`、`source_locale`、`content_locale` を混ぜない。
- 原文は必ず保持し、翻訳は派生データとして扱う。
- 内部enumやschema keyは翻訳しない。
- 表示文言、Agent出力、Artifact本文は、必要なlocaleに合わせる。
- v1から `en`、`ja`、`zh`、`ko`、`es`、`pt-BR`、`fr`、`de` をseed localeとして扱う。
- 設計・文案のcanonicalは `ja`、first-class localeは `en` とする。

---

## 10. OSS参照元の扱い

MulmoClaude / Hermes Agent / OpenClaw は、そのまま結合する対象ではない。

それぞれの勝ち筋を参照し、Samurai Agent として greenfield に再構成する。

正式な参照元は、`ARCHITECTURE.md` の `Reference Sources` を正本とする。

ここでの参照元固有名は、内部設計上の索引である。

- 実装中は、どの判断がどの参照元に由来するか追えるように残す。
- 公開名、製品名、README、UI文言、API名、package名には使わない。
- 公開面の命名は `PUBLIC_NAMING.md` に従う。
- Memory / Skill / Runtime / Gateway などの一般的な技術語は、無理に日本語化しない。

役割分担。

- MulmoClaude: Host、Workspace状態、Artifact、Collection、Renderer、Plugin composition の参照元。アプリ中心UXは完成形にしない。
- Hermes Agent: Memory、Skill、Reflection、Self-improvement loop の参照元。
- OpenClaw: Gateway、Session routing、Pairing、Sandbox、External boundary の参照元。
- Claude Code / Codex: 差し替え可能な Agent Backend cassette の候補。

---

## 11. 責務分離

Chat / Surface / Host / Agent Backend / Gateway / Memory / Skill / Workspace / Artifact / Collection の責務を混ぜない。

基本の役割。

- Chat: ユーザーとAIが意図をすり合わせ、作業を継続する主要インターフェース。
- Surface: 必要時だけ現れ、状態を見せたり直接操作したりする表現面。
- Host: Chat、Surface、Workspace、Memory、Skill、Gatewayを束ね、どのAgent Backendに流すかを決める場所。
- Agent Backend: Hostから渡された作業を実行する、差し替え可能な実行部。
- Gateway: Web UI以外の入口や外部チャネルを受ける境界。
- Memory: 長期的に残す事実、好み、作業手順、文脈。
- Skill: 繰り返し使える作業手順。
- Workspace: Artifact、Collection、Memory、Skill、履歴が集まる作業机。
- Artifact: 文書、表、グラフ、画像、PDFなどの成果物。
- Collection: 顧客、案件、タスクなどの構造化された業務データ。

実装判断。

- GUIだけでBackend実行を抱え込まない。
- Agent BackendだけにMemoryやSkillの正本を閉じ込めない。
- GatewayにWorkspace更新の責務を持たせない。
- Hostを太らせすぎず、WorkspaceとBackendの接続役にする。

---

## 12. 判断に迷った時の優先順位

迷ったら、以下の順に優先する。

1. ユーザーが会話の流れで作業を理解・修正できる。
2. Workspace、Memory、Skillに価値が戻る。
3. UIは必要な時だけ現れ、状態そのものを正本にしない。
4. Agent Backendを固定しない。
5. MulmoClaude型HostとSurfaceの強みを活かす。
6. Hermes的な改善ループを殺さない。
7. 外部接続の境界は守るが、独自安全設計を主役にしない。
8. 一気に広げず、縦切りで価値を通す。
9. 仕様を増やす時は、後から読む人が迷わない粒度で残す。

この優先順位に反する変更は、先に設計意図を確認する。
