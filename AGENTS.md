# AGENTS.md

## 回答

- 日本語で、フランクかつ簡潔に答える。
- 非エンジニアでも追える言葉を使う。
- 推測と、ファイル・実行結果で確認した事実を分ける。

## 正本

設計正本は2つだけ。

1. `PRODUCT.md`：製品定義、判断基準、概念、公開用語
2. `ARCHITECTURE.md`：責務境界、データ所有、接続、検証不変条件

設計・実装・UI・命名を変更する前に、この2つを読む。`plans/`、`reports/`、UI資料、参照OSS資料は補助資料であり、正本と矛盾する場合は正本を優先する。

## 守る境界

- Workspaceはユーザー所有のKnowledge正本。
- RoomはKnowledgeと権限の境界。親子Roomでも自動共有しない。
- Sessionはアプリ側の任意参照。
- Activityは証拠、KnowledgeとSkillは再利用物。
- Native Appと外部アプリは同じCoreを使う。
- Gateway、Adapter、BackendはWorkspaceへ直接書き込まない。
- 自動学習は同じRoomの根拠付き処理に限定する。
- 未検証を完了扱いしない。

## 作業

- 既存差分を勝手に戻さず、依頼範囲外へ広げない。
- 複数ファイルの変更前に、対象と検証範囲を短く示す。
- secret、API key、token、`.env`を表示・コミットしない。
- ユーザーが求めない限り、branch作成、commit、pushをしない。
- 文書変更では、用語、リンク、Mermaid、`git diff --check`を確認する。
- コード変更では、関係するlint、typecheck、testを実行する。
- 検証できなかった範囲は明記する。
