# Workspace Server 03: Room無限階層化 実装台帳

## 目的

`Workspace Server 02`のPostgreSQL経路に、Roomの無制限階層を追加する。

- Workspaceは最上位の所有単位であり、Roomとして保存しない
- RoomはWorkspace直下または一つの親Roomの下に置ける
- 親Roomと子Roomは同じ種類のRoomであり、階層数の製品上限は設けない
- HostedとSelf-hostは同じAPI、PostgreSQL schema、Bundle仕様を使う
- SQLiteは旧Workspaceをread-onlyでBundle化する経路だけに残す

## 確定仕様

### Knowledge、検索、AI Context

- 各Roomは独立したKnowledge境界である
- 親・子・兄弟RoomのKnowledgeを検索やAI Contextへ自動で混ぜない
- Workspace Serverの通常Knowledge一覧と検索はRoom IDを必須にする
- 現行Native AppのChatはWorkspace Serverへ自動接続しない。したがってChatへ別RoomのKnowledgeを暗黙に渡す経路を追加しない
- 将来のWorkspace全体検索やRoom間共有は、別の明示操作として扱う

### 参加者と移動

- 子Roomの直接メンバーは、すべての親Roomの直接メンバーでなければならない
- 親Roomへの参加だけで子Roomを見せない
- 親Roomからの解除は、対象Accountを子孫Roomからも一つのDB更新で解除する
- 子孫Roomの最後の直接Ownerを失う解除は拒否する
- Room移動は`parent_room_id`だけを変え、Knowledgeと直接メンバーを変えない
- 移動先の親Roomと全上位Roomへ、移動対象Roomと子孫Roomの全直接メンバーが参加していなければ拒否する
- 自分自身・子孫の下への移動、別Workspaceの親、古い版、同じ操作の二重実行を拒否または再実行結果として扱う

## 参照OSSの調査記録

| OSS | 参考にする作り方 | Samuraiで使う場所 | 採用しない製品設計 |
| --- | --- | --- | --- |
| [Buzz](https://github.com/block/buzz/tree/5bf78671f45178f8de02ba18d3d321cbbf19cd1f) | 更新直前の認可確認、DB transaction、操作の重複防止、拒否テスト | Room参加・移動・Realtime | Channel、Relay、Nostr設計 |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/961f7481a7a75456e5e13b71e5343c70ea2ec74b) | 小さな責務、状態とテストの分離 | Room型、Bundle、Focused test | Agent-firstのKnowledge設計 |
| [MulmoClaude](https://github.com/receptron/mulmoclaude/tree/e0241304061137f492c877b1489351fc8fa92770) | 保存まで通る実行経路と隔離した統合確認 | Room作成・移動のCommand経路 | ChatがWorkspaceを所有する設計 |
| [OpenClaw](https://github.com/openclaw/openclaw/tree/dba99b355b4e75cc97fddaf78bbf9c5a3058ca34) | 信頼境界を狭くし、失敗時に閉じる | Desktop署名、RLS、Room ID検証 | Session中心のGateway設計 |

調査では各リポジトリの開発指示、責務分離、更新経路、認可再確認、競合・再試行、拒否テストを確認した。SamuraiのRoom設計そのものは参照OSSへ寄せない。

## 実装対応

| 層 | 実装 | 主なファイル |
| --- | --- | --- |
| PostgreSQL | `rooms.parent_room_id`、同一Workspace FK、親子索引、循環・親メンバー・最後のOwnerを守る正式関数。再参加時に古い直接Room参加を復活させない | `packages/workspace-server/src/schema.ts` |
| 権限 | runtime roleから`workspace_members`、`rooms`、`room_members`の直接変更権限を外し、Room直接権限とWorkspace membershipを両方確認 | `packages/workspace-server/src/schema.ts` |
| Command / Store | 子Room作成、移動、影響確認、子孫解除、Room ID必須の一覧・検索 | `packages/workspace-server/src/workspace-server-store.ts`、`workspace-server-commands.ts` |
| HTTP / Realtime | 作成・移動・メンバー影響API、Room直接読取を通知直前に再確認するイベント、解除後の購読再確認 | `apps/server/src/workspace-server/http-server.ts`、`realtime.ts` |
| Desktop | URLや秘密鍵をWebへ渡さない用途別IPC、操作IDと版番号を含む署名済み要求 | `apps/desktop/src/main.ts`、`preload.cts`、`workspace-room-requests.ts` |
| Native App | 権限のある平坦なRoom一覧からツリーを作成。明示的な作成・移動・影響確認・メンバー変更 | `apps/web/src/components/WorkspaceRoomTree.vue`、`WorkspaceCanvas.vue` |
| Bundle / 旧データ | parent Room IDのExport、Restore前の親欠落・循環・親メンバー検査、旧Bundle/SQLiteはWorkspace直下として扱う | `packages/workspace-server/src/workspace-bundle-v3.ts`、`sqlite-migration.ts` |

## 更新経路

```text
Native App
→ Desktopの用途別署名IPC
→ Workspace Server API
→ Command / Store
→ PostgreSQLの正式関数
→ RLS・版番号・親子メンバー制約
→ Room scoped Realtime
→ 権限のある画面だけを再取得
```

- WebからDBや任意URL署名へ直接入る経路は作らない
- Room作成、移動、Room member変更、招待受諾、Restoreは旧の平坦な更新関数や直接DMLをruntime roleへ公開しない
- Restoreはread-only import session内で検査し、失敗時はactive化しない

## 検証

実行入口は`pnpm server:03:verify`とする。

- Workspace Server、HTTP Server、Desktopのtypecheck
- Native Appのbuild
- schema、Bundle互換、SQLite migration、Realtime、Desktop署名境界、Room treeのFocused test
- architecture boundary確認と`git diff --check`
- Hosted / Self-hostの検証用PostgreSQLが両方設定され、明示確認値がある場合はその実DBで、未設定時はローカルDockerの使い捨てPostgreSQLで、階層・RLS・検索境界・Realtime解除・Bundle往復・再試行をprobeする。Dockerを使えない環境では失敗として終了し、静的検証だけを成功扱いにしない

実DB probeに必要な値。

```text
SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_URL
SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_ADMIN_URL
SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_RUNTIME_ROLE
SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_URL
SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_ADMIN_URL
SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_RUNTIME_ROLE
SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE=yes
```

このprobeは一時WorkspaceとAccountを作成・削除する。検証専用PostgreSQLだけに設定する。

### 今回の実行結果（2026-08-14）

`pnpm server:03:verify`を最終実行した。

- 通過: architecture boundary、Workspace Server / HTTP Server / Desktop / Native Appの型検査、実DB probe本体の型検査、Native App build、Focused test **9 files / 25 tests**、`git diff --check`
- 実PostgreSQL probe: 未実行。Hosted / Self-hostの検証用DBは未設定で、使い捨てPostgreSQLを起動しようとしたが、この環境にDockerが無い（`spawnSync docker ENOENT`）ため、コマンドは失敗終了した
- したがって、実PostgreSQLでのMigration、RLS、Realtime、Bundle往復の確認は**未検証**であり、3番を完了とは扱わない

`pnpm desktop:verify`は既存のGateway、Client Event Queue、AppShotに関する未充足の全体監査で失敗する。Room階層差分で削除・変更した項目ではないため、Server 03の一括検証からは外し、代わりにDesktop型検査と、実際の署名バイト・用途別Room IPC入力を実行するFocused testを含めている。この全体監査を成功扱いに変えたり、削除したりはしていない。

## セルフレビュー

確認したこと。

- WorkspaceをRoomとして保存していない。親と子で別のRoom型も作っていない
- Room移動ではKnowledge、記録、直接メンバーを更新しない
- 親子間の検索・AI Context・閲覧を自動継承していない。通常一覧と検索はRoom ID必須
- 親Roomだけのメンバーには子Room一覧、名前、Realtime eventを送らない
- runtime roleはRoomとRoom memberを直接変更できず、PostgreSQL関数が循環・親参加・版番号を確認する
- 招待受諾とBundle Restoreも、直接DMLを使わず、親Room参加・Account状態・操作IDを検査する正式関数を通る
- メンバー解除は子孫まで同じtransactionで反映し、最後のOwnerを失う場合は止める
- 旧Server 02で残り得た「Workspaceから外れた後もactiveの直接Room参加」は、Workspace再参加または招待受諾の前にまとめて無効化する。古い権限が後から自動復活しない
- Bundleは親子関係を保存し、旧Bundleの親なしRoomはWorkspace直下として読める
- 複数親、階層専用サービス、Redis、Knowledge自動共有、Room種別分割は追加していない

見つけて修正したこと。

- Roomの最後のOwnerを`member`へ役割変更する経路も、解除と同じく拒否するようにした
- Workspace member更新もRoom階層と同じ短時間lockに入れ、親Room解除と子Room追加・移動が途中で交差しないようにした
- 親Room未参加を理由にRoom member更新が失敗した時、HTTPが一般的な500ではなく固定エラーコードを返すようにした

今回意図的に実装しないもの。

- Room間のKnowledge自動共有、コピー、Workspace全体への昇格
- 複数親Room、Roomの種類分け、階層数上限
- Room完全削除・アーカイブの新仕様
- 既存Chat / SessionをWorkspace Serverへ自動接続する変更

実PostgreSQLの結果は、実行した環境でのみこの台帳へ追記する。静的・Focused testの成功だけで実DB確認済みとは扱わない。
