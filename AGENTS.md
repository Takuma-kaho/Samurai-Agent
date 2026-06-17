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

## 設計方針

- MulmoClaude / Hermes Agent / OpenClaw は、そのまま結合する対象ではなく、参照元として扱う。
- 基本方針は `Policy-Bounded Agent Loop`。
- 人間は毎回承認する人ではなく、Agent が動ける境界を決める人として扱う。
- Agent は境界内で自律的に動き、境界を越える時だけ人間を呼ぶ設計を優先する。
- 実装を考える時は、GUI / Runtime / Gateway / Memory / Policy / Audit の責務を混ぜない。

## 公開命名ルール

- 参照元固有名は、`ARCHITECTURE.md` / `plans/` / 調査メモでは残してよい。
- README、UI文言、API名、route名、package名、DB名、env/config key には参照元固有名を出さない。
- 公開面に出る名前を決める時は、先に `PUBLIC_NAMING.md` を確認する。
- `Memory` / `Skill` / `Runtime` / `Gateway` などの一般的な技術語は、無理に日本語化しない。

## 作業ルール

- 既存の設計意図を壊さない。
- 大きな変更をする前に、関連する設計箇所を読む。
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
