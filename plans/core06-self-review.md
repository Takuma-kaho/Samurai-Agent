# Core06 セルフレビュー

更新日: 2026-08-08

このレビューは、テスト結果を見る前に差分の依存方向と権限境界を読み直し、その後にFocused検証で裏付ける方式で行った。

## 設計境界

- [x] WorkspaceはKnowledgeの正本であり、RoomはKnowledge・共有・閲覧権限の境界である。
- [x] Human、Agent、External App、SystemをPrincipalとして分離した。External AppはRoom参加者ではなく、委任元以上の権限を得ない。
- [x] Native AppとExternal Appは同じRoom/Principal権限計算を通る。Native App固有のCore書き込み経路は追加していない。
- [x] SessionRefは任意の外部参照であり、権限・Resource生存・SQLite外部キーの根拠にしていない。
- [x] SessionなしのRoom Queryと明示Domain Operationは、Room・Principal・任意SessionRefで動く。
- [x] 明示的なWorkspace scope Knowledgeは参加済みRoomで読み取り可能だが、Room境界付きResourceをscopeだけで越境させない。
- [x] 新しいSession共有とSession scope Knowledge保存を拒否する。
- [x] Core07のActivity History/学習再設計、Core08の完全Resource分離、Core09の実Gateway接続は実装していない。

## 偽Sessionと互換境界

- [x] `sessionCompatibleOperationIds`で、Chat、Curator、Reflection、Evaluation、Artifact、Collection、Surface、Gateway/Automation互換操作を閉じた。
- [x] SessionなしのOperation inventoryは上記を隠し、直接実行もHandler前に拒否する。
- [x] `wiki.proposal.create`、Skill、Topic Memory、FileなどCore06対象のSessionなし操作は、Session行を作らずRoom境界を記録する。
- [x] Backend Tool Bridgeは同じ互換一覧を使い、隠れたProvider Tool名からの迂回を拒否する。
- [x] `session.create`は明示的なLegacy互換操作だけに残し、fallbackには使わない。

## 依存方向とセキュリティ

- [x] pure `room-permissions` packageにSQLite、HTTP、Runtime依存を入れていない。
- [x] Server/Runtimeは公開payloadからRoom、Principal、委任元、App ID、Run IDを作らない。
- [x] Resource候補はRoom境界・明示Workspace scopeで絞り、返却直前にも現在の参加状態を再確認する。
- [x] 共有先はread/useのみで、編集・再共有は渡さない。解除後は候補・返却の両方で拒否される。
- [x] Backend、Gateway、UIからWorkspace Storeへの直接書き込み経路を追加していない。
- [x] compatibility AdapterにCore本体が逆依存していない。

## 永続化と失敗処理

- [x] migration `011`は既存SessionからRoomを推測せず、legacy行を保持する。
- [x] SessionなしBackendRun、Event、Tool Run、Workspace ChangeはRun中心で保存・再読込できる。
- [x] Run leaseは内部`lane_key`で管理し、SessionなしRunは`run:<run_id>`を使う。
- [x] Session削除をWorkspace Resourceの生存条件にしていない。
- [x] 取消・再開・同期・復旧はSessionなしRunでも同じHost経路と現在権限再確認を使う。
- [x] terminal settlementはRun単位で一度だけ確定する。

## 今回見つけて修正した問題

1. Curator操作がSession互換一覧から漏れ、Sessionなし入口で`ensureSession`へ到達できた。
   - `curator.*`を閉じた一覧へ追加し、inventoryと直接実行の負例を追加した。
2. 新しいRoom共有SchemaがSessionを受理できた。
   - 新規共有専用Schemaを分離し、Repository/SQLite triggerと合わせて三層拒否にした。
3. Workspace scope Knowledgeの候補判定がなかった。
   - 明示scopeだけを候補化し、Room境界があるResourceはscope値にかかわらず候補から除外した。
4. Core05 fixtureがCore06後のRoom/Session境界とAgent編集権限を表していなかった。
   - 本番Runtimeを迂回するfixtureに必要な境界だけを明示し、権限拒否の期待値を現契約へ更新した。

## 検証結果

- [x] `pnpm core:06:verify`
  - generated operation bindings: 150
  - architecture boundary: pass
  - Focused Vitest: 11 files / 88 tests
  - Core Schemas、Room Permissions、Domain Operations、Workspace Store、Agent Backends、Runtime、Serverのtypecheck: pass
  - `git diff --check`: pass
- [x] Workspace/Room/共有/legacy/Sessionなし/Backend Run/migration/backup-restoreのFocusedテストを含む。

## 判定

**Core06のプラン範囲は完了。**

実外部アプリのOAuth・pairing・routing、Activity History、Artifact/Collection/Surfaceの完全Session分離は、意図どおりCore07〜09の対象であり、この判定に含めない。
