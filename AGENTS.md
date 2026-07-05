# AGENTS.md

## 回答スタイル

- 日本語で回答する。
- フランクな口調で話す。
- 説明は、非エンジニアでも追えるように、短い箇条書きを基本にする。
- 推測だけで断定せず、できるだけファイル・実行結果・設計書を確認してから話す。

## このリポジトリの位置づけ

- このリポジトリは、Samurai Agent の設計・検討・実装準備を置く場所。
- 中核テーマは `GUI-first Personal Agent Workspace`。
- `PRINCIPLES.md` を設計思想・判断基準の最重要 source of truth として扱う。
- `ARCHITECTURE.md` を実装前アーキテクチャ仕様の source of truth として扱う。
- `PUBLIC_NAMING.md` を公開面の命名ルールとして扱う。
- `plans/` はレビュー、改訂方針、作業計画の置き場として扱う。
- `Hermes_Agent_解説.md` は Hermes Agent 理解の補助資料として扱う。

### Source of truth の優先順位

1. `PRINCIPLES.md`: 設計思想・判断基準・前提
2. `ARCHITECTURE.md`: 実装前アーキテクチャ仕様
3. `PUBLIC_NAMING.md`: 公開面の命名ルール
4. `plans/`: レビュー・改訂方針・作業計画
5. `Hermes_Agent_解説.md`: Hermes Agent 理解の補助資料

### 作業開始時に必ず読むファイル

Samurai Agentで設計、実装、UI、命名に関わる作業を始める前に、必ず以下を読む。

1. `ARCHITECTURE.md`
2. `PRINCIPLES.md`
3. `PUBLIC_NAMING.md`
4. `WEB_UI_DESIGN.md`

変更内容が小さくても、命名や責務に触れる場合は `PUBLIC_NAMING.md` を必ず確認する。

## 設計方針

- 基本方針は `MulmoClaude型Host + Agent Backend cassette + Hermes的Memory/Skill改善ループ`。
- Claude Code / Codex / SamuraiNativeBackend などの実行部は、Hostから差し替えられるBackend cassetteとして扱う。
- 独自性は安全制御ではなく、Memory、Skill、Artifact、Collection、Workspace UX、外部連携の拡張で出す。
- 実装を考える時は、GUI / Host / Agent Backend / Gateway / Memory / Skill / Workspace / Artifact / Collection の責務を混ぜない。

## 公開命名ルール

- 参照元固有名は、`ARCHITECTURE.md` / `plans/` / 調査メモでは残してよい。
- README、UI文言、API名、route名、package名、DB名、env/config key には参照元固有名を出さない。
- 公開面に出る名前を決める時は、先に `PUBLIC_NAMING.md` を確認する。
- `Memory` / `Skill` / `Runtime` / `Gateway` などの一般的な技術語は、無理に日本語化しない。

## 作業ルール

- 既存の設計意図を壊さない。
- バグ修正では、一時的な回避策や場当たり的なショートカットを実装しない。根本原因、正本ドキュメント、責務境界を確認し、設計通りの修正を行う。
- 暫定対応が必要に見える場合でも、勝手に実装せず、なぜ暫定になるのか・恒久対応は何かを先にユーザーへ説明して合意を取る。
- LLM / Backend / Runtime / Workspace の責務を迂回して、見かけ上だけ成功したように見せる処理を入れない。
- 大きな変更をする前に、関連する設計箇所を読む。
- 設計、実装、UI、命名に関わる作業では、作業前に `ARCHITECTURE.md`、`PRINCIPLES.md`、`PUBLIC_NAMING.md`、`WEB_UI_DESIGN.md` を読む。
- 複数ファイルにまたがる変更や仕様判断がある場合は、先に短く方針を説明する。
- ユーザーが作った変更は勝手に戻さない。
- 不要なリファクタや、目的外の整理はしない。
- コードや設計を追加する時は、後から読んだ人が迷わない粒度で残す。

## Git / コミット

- コミットメッセージは必ず日本語で簡潔に書く。
- 例: `初期設計資料を追加`
- 設計資料だけの変更でも、何を変えたかがわかる単位でコミットする。
- secret、API key、個人トークン、`.env` はコミットしない。

## 検証

- 設計資料の変更では、少なくとも差分を確認する。
- 実装コードが入った後は、その技術スタックに合う lint / typecheck / test を優先する。
- 検証できなかった場合は、何を未確認のまま残したかを明記する。
