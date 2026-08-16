# Workspace Server 04 参照OSS調査

確認日: 2026-08-15

この調査はSamuraiの製品設計を参照OSSへ寄せるためのものではない。採用するのは、更新経路を狭くすること、状態を永続化すること、失敗・競合・権限不足を隠さないこと、否定テストを置くことだけである。Room、Workspace、Knowledgeの意味はSamuraiの正本に従う。

## Buzz

- Repository: <https://github.com/block/buzz/tree/5bf78671f45178f8de02ba18d3d321cbbf19cd1f>
- 参照する作り方: 操作ごとの認可再確認、transaction、重複実行の抑止、拒否テスト。
- 今回の適用: Resource更新、固定、アーカイブ、Copy、Move、Promote、Job claimを操作ID・版番号・RLSの同じ境界で処理する。
- 採用しないもの: Relay、Nostr、参加モデル。

## Hermes Agent

- Repository: <https://github.com/NousResearch/hermes-agent/tree/2446c8bb6755ff5e6feff4d26e425661edd4019b>
- 参照する作り方: Background Reviewを通常実行から分け、候補入力を絞り、Job lease・retry・失敗証跡・固定Resourceを持つ。
- 今回の適用: Activityから決定的に候補を選び、Knowledge Hostにはsnapshotと狭いmutation planだけを渡す。固定KnowledgeはAI更新を拒否し、競合は別candidateとして残す。
- 採用しないもの: Agent-firstのMemory/Skill中心設計、Sessionを学習の親にする構造。

## MulmoClaude

- Repository: <https://github.com/receptron/mulmoclaude/tree/d9fbd9bbdfa9e78e81dfb69ec628193bc21c5a9e>
- 参照する作り方: Hostと実行Backendの境界、永続成果物、入力を限定したPort、利用者が確認できる履歴。
- 今回の適用: Knowledge HostはDB/ファイルをBackendへ渡さず、Roomに限定したreview snapshotと結果だけを交換する。Resourceの版・Evidence・Link・Job attemptを保存する。
- 採用しないもの: ChatやPluginがWorkspaceを所有する製品構造。

## OpenClaw

- Repository: <https://github.com/openclaw/openclaw/tree/46e6f93a86ae21b66a09f01910cb7c6b544af982>
- 参照する作り方: 外部境界の入力正規化、SecretRef、状態診断、失敗時fail closed。
- 今回の適用: Native Appは用途別IPCだけを使い、URL・署名・秘密値・任意payloadを送れない。設定はSecretRefだけを保存し、HTTP応答にはSecretRefすら返さない。
- 採用しないもの: Personal Assistant、Channel、Gateway、Session routingの設計。

## 今回守る不変条件

- Workspaceを偽のroot Roomにしない。
- 親・子・兄弟RoomのKnowledgeを自動で共有、検索、Context注入しない。
- 自動学習は同一Roomの候補だけを作成・更新できる。Room間Copy/Move/Promoteは人の明示操作だけにする。
- 実際の秘密値、会話全文、Session必須参照を保存しない。
- Artifact/CollectionはEvidenceとして参照できても、自動変更しない。
