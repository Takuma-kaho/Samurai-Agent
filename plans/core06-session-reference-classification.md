# Core06 Session参照分類

更新日: 2026-08-08

Core06はSession参照の削除数を成果にしない。Native Appの会話は残し、Room権限、Domain入口、Workspace実行だけをSession必須から外す。

## 分類結果

| 分類 | 意味 | Core06での扱い |
|---|---|---|
| A | Native AppのChat・Session・Backend会話継続 | 残す。Legacy Session APIはSessionを読んで、認証済みRoom・Principal・任意`SessionRef`へ一方向に変換する。 |
| B | Room権限・Domain入口・Workspace実行 | `TrustedWorkspaceContext`、Room、Principal、Runを正本にする。SessionRefは任意metadataであり、権限には使わない。 |
| C | Activity・学習・評価・証拠 | Core07まで既存Session互換に閉じる。Curator、Reflection、Evaluation、学習記録の再設計は追加しない。 |
| D | Artifact・Collection・Surface | Core08まで既存Session互換に閉じる。Sessionなし入口では有効Operation一覧に出さず、実行も拒否する。 |
| E | Gateway・外部接続・routing | Core09へ送る。Core06は信頼済みContextの型・委任・監査だけを持ち、実接続やpairingは追加しない。 |

同一ファイルに複数の責務がある場合は、参照単位で分類した。`agent-backends`のBackend会話継続はA、SessionなしRun入力はBである。

## Bで完了した境界

- 公開payloadの`room_id`、Principal、委任元、`app_id`、`session_ref`は拒否する。Transportだけが認証済みContextを作る。
- Room操作、Room Query、有効Operation一覧、Wiki・Skill・Topic Memory・File・Rollbackの対象操作は、SessionなしでRoom Contextから実行できる。
- `BackendRun`、Operation、Backend Event、Tool Run、Workspace ChangeはRunを正本にし、Sessionは任意化した。
- HostはNative App Chat AdapterとSessionなし実行の両方で同じWorkspace Execution RequestとBackend cassetteを使う。
- Run取消・再開・同期・復旧は、現在のRoom/Principalを再確認する。
- Workspace scopeが明示されたMemory・Wiki・Skillは、参加済みRoomで読み取り・利用できる。ただしRoom境界が記録されたResourceは、scope値にかかわらずそのRoomまたは明示共有先だけを候補にする。
- Room不明のlegacy行はRoomへ推測移動せず、従来どおりWorkspace Owner限定にする。

## Session互換の閉鎖

`sessionCompatibleOperationIds`がA/C/D/Eの既存Session操作を閉じた一覧として管理する。

- SessionRefなしの有効Operation一覧には出さない。
- Sessionなしで直接呼ばれても、Handlerへ入る前に`session_compatibility_required:<operation>`で拒否する。
- Backend Tool Bridgeも同じ一覧で隠し、推測したTool名による迂回を拒否する。
- `session.create`だけは明示的な互換Operationであり、ChatやKnowledge保存のための自動作成には使わない。

これにより、旧レビューで見つかった`wiki.proposal.create`、Skill、Curatorなどの`ensureSession`経路は、Sessionなし入口から到達できない。Sessionなしで許可されたCore06操作は、Session行を作らない。

## 共有とKnowledge scope

- 新しいSession共有は公開Schema、Repository、SQLite triggerの三層で拒否する。既存Session共有行は診断・取消のためだけに残し、権限根拠にはしない。
- 新しいSession scopeのMemory・Skill保存は拒否する。既存Session scopeデータは推測でRoomへ移動しない。
- Workspace scopeは明示済みKnowledgeの読み取り候補であり、Room scope・共有・AgentのRoom許可を置き換えない。

## 監査方法と検証

Session参照は、次の検索を起点にA〜Eへ分類した。

```text
rg -l 'session_id|sessionId|SessionRef|session_ref|session scope|Session' packages apps scripts
```

分類されていないCore06対象のSession依存はない。Core07〜09へ送る参照は残したまま、Sessionなし入口からの実行を閉鎖した。

検証は`pnpm core:06:verify`に、Core05のWorkspace/Room Knowledge候補テストを加えて実行する。候補段階と返却直前の両方でRoom権限を確認する。
