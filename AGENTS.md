# AGENTS.md

## 回答スタイル

- 日本語で回答する。
- フランクな口調で話す。
- 非エンジニアでも追えるよう、短い箇条書きを基本にする。
- 推測だけで断定せず、ファイル、実行結果、設計書を確認してから話す。

## このリポジトリの位置づけ

このリポジトリは、Samurai Agentの設計・検討・実装準備を置く場所である。

Samuraiの中心テーマは、次のとおり。

> **AI-native Knowledge Workspace：人間の知識を一か所に集め、外部アプリから届く経験をAIが整理・成長させる基盤。**

- WorkspaceはKnowledgeの正本
- RoomはKnowledge、共有、閲覧権限の境界
- SessionはNative Appや外部アプリ側の会話単位
- Activity Historyは構造化された作業証拠
- Knowledge Hostは整理・学習のバックエンド役
- Agent Backendは交換可能な実行エンジン
- Native AppはWorkspaceを利用する、互換性の高い外部アプリ

Workspace、Room、Session、Agent、Backend、Chat、Surface、Gateway、Memory、Skill、Artifact、Collectionの責務を混ぜない。

## Source of truth

1. PRINCIPLES.md：設計思想、判断基準、前提
2. SAMURAI_AGENT_MANUAL.md：プロダクト全体像、概念、用語、関係性
3. ARCHITECTURE.md：構造、責務、境界、データの流れ
4. PUBLIC_NAMING.md：公開面の命名ルール
5. WEB_UI_DESIGN.md：Native AppのWeb UI
6. plans/：レビュー、改訂方針、作業計画
7. Hermes_Agent_解説.md：参照資料

## 作業開始時に読むファイル

設計、実装、UI、命名に関わる作業を始める前に、必ず次を読む。

1. PRINCIPLES.md
2. SAMURAI_AGENT_MANUAL.md
3. ARCHITECTURE.md
4. PUBLIC_NAMING.md
5. WEB_UI_DESIGN.md

## 設計方針

- Workspace-firstのCoreと、Chat-firstのNative Appを分ける。
- WorkspaceはChatやNative Appの所有物ではない。
- RoomはKnowledgeと権限の境界であり、会話ルームではない。
- SessionはWorkspaceの必須親にせず、Activityの参照情報として扱う。
- Activityは指示、結果、変更、検証、失敗、出所を構造化して保存する。
- 会話全文をWorkspaceへ強制保存しない。
- Knowledge Hostは同じRoom内へ、根拠付きの暫定Knowledgeだけ自動保存できる。
- Workspace全体への昇格、削除・統合、権限変更、機密情報の採用は明示操作で行う。
- Domain Operationは明確な保存・変更を扱う。
- Workspace JobはAI処理、学習、Curator、長時間処理に限定する。
- Claude Code、Codex、Samurai Native Backendなどは、Hostから差し替えられる一つのBackend cassette境界で扱う。
- Gatewayは接続境界であり、Workspaceへ直接書き込ませない。
- ArtifactとCollectionはWorkspaceの成果物・構造化データ、SurfaceはNative Appの表示投影である。
- Native AppをWorkspace側で特別扱いしない。
- Nostr、Relay、署名EventはCoreではなく、将来のGateway接続候補として扱う。

## 公開命名

- 公開定義は「AI-native Knowledge Workspace」を使う。
- Chat-firstはNative AppのUI方針として使う。
- Roomを「チャットルーム」、Sessionを「Workspaceの構成要素」と説明しない。
- 参照元固有名は設計・比較・出典の文脈だけで使う。
- README、UI、API、route、package、DB、env/config keyへ参照元固有名を持ち込まない。
- Memory、Skill、Runtime、Gatewayなど一般的な技術語は無理に日本語化しない。

## 作業ルール

- 既存の設計意図とユーザーの変更を勝手に戻さない。
- 目的外のリファクタや仕様追加をしない。
- 実装前に、対象ファイル、責務境界、検証範囲を固定する。
- Runtime、Backend、Workspaceの責務を迂回して、見かけだけ成功する処理を入れない。
- 複数ファイルにまたがる変更や仕様判断では、先に短く方針を説明する。
- 設計資料を変更したら、正本間の用語と図の矛盾を確認する。
- 現在のコードに存在することと、検証済みで完了していることを混同しない。
- 完了レポートにsource差分や証拠不足がある場合は、未検証として明記する。

## Git

- コミットメッセージは日本語で簡潔に書く。
- secret、API key、個人トークン、.envはコミットしない。
- ユーザーが求めない限り、コミット、push、branch操作を行わない。

## 検証

- 設計資料の変更では、差分、Markdownリンク、Mermaid図、用語の整合性を確認する。
- 最低限 git diff --check を実行する。
- 実装コードを変更した場合は、技術スタックに合うlint、typecheck、testを優先する。
- 検証できなかった範囲は、完了扱いせず明記する。
