# ARCHITECTURE.md（旧 DESIGN.md） v0.5 レビュー報告

## Context

`ARCHITECTURE.md`（レビュー当時の `DESIGN.md`、v0.5「GUI-first Personal Agent Workspace / Policy-Bounded Agent Loop」）のレビュー依頼。
初回作成時のユーザー指示は「レビューして報告だけ完了したら終了」だったため、
本ファイルは当初レビュー報告として作成された。
今回の追記では、レビュー結果をどう `ARCHITECTURE.md` v0.6 に反映するかの改訂プランまで含める。
ただし、このファイル更新時点では `ARCHITECTURE.md` 本体の改訂はまだ行わない。

2026-06-17追記:
`DESIGN.md` は `ARCHITECTURE.md` に改名された。
本ファイル内の過去文脈としての `DESIGN.md` は、現在の `ARCHITECTURE.md` を指す。

2026-06-18追記:
現行方針では旧Home表現はChat Shell内のActivity Inbox / Context Drawer / badge / Audit Viewへ読み替える。
本ファイルのレビュー本文は履歴として残すが、今後の実装判断ではダッシュボード型の初期画面やActivity Inbox専用画面を作らない。

前提として、同じ `plans/dazzling-wondering-flask.md` は **v0.4 へのレビュー + v0.5改訂プラン**。
今回の v0.5 は、その改訂プラン（Policy Specification / Instruction Provenance / Rollback具体化 /
Core Schemas / Home可観測性 / 縦切りMVP / secret masking / skill trust / safety eval / paired scope /
正直さ注記）を **ほぼ全項目反映済み**。つまり v0.4 レビューの P1〜P3 は大半が解消されている。

本レビューは、その上で **v0.5 時点でまだ残っている穴** を対象にする。

同日追加確認:
ユーザーとの追加確認を踏まえ、本ファイルはレビュー報告に加えて、
**v0.6へ反映するための改訂プラン**も含める。

---

## 総評

完成度はかなり高い。v0.4 で「思想止まり」だった Policy / Provenance / Rollback / Schema が
v0.5 で節として起こされ、実装着手の一歩手前まで来ている。

残る弱点は2系統に集約される。

1. **文書内の自己整合性** — 同じスキーマ／ポリシーが複数箇所で微妙に違う定義で重複しており、
   そのまま実装するとドリフトする（v0.4で「単一の正準へ統合せよ」と言った宿題が半分残っている）。
2. **ポリシー評価の実行可能性** — 「正準ポリシー行列」と「PolicyEvaluationInput」は置かれたが、
   入力から Decision を一意に導く **評価ロジック（競合解決・優先順位）** がまだ無い。

追加判断:

- このレビューは、v0.5を否定するものではない。むしろ **設計思想が実装仕様へ近づいたから出てきた締めの指摘**。
- P1は基本的に採用する。特に schema一本化 / policy関数化 / grant永続化 / approval待ち中のLoop挙動は、
  v1コード着手前に潰す。
- ただし `external_content -> Memory` は「外部由来Memoryを完全禁止」ではなく、
  **外部由来の情報が命令権限を持たない** という不変条件として直す。
- P2-3のpush通知は重要だが、local-first v1では外部push必須ではない。
  まずはHome badge / in-app notification / anomaly inboxで成立させ、OS通知や外部チャネル通知は後続でよい。
- このレビューは安全性・仕様整合性レビューとして優秀だが、UXの勝ち筋までは見ていない。
  v0.6では「硬い安全仕様」だけでなく、GUI秘書として毎日触りたくなる体験を削らないようにする。

---

## Priority 1（v1着手前に潰す）

### P1-1. コアスキーマが2箇所で別定義（ドリフトの種）
5.x の各節と 5.14 Core Schemas で、同名スキーマのフィールドが食い違う。

- `MemoryFrontmatter`: 5.6（924-939）は `created_by / last_used_at / related_memories` を持つが、
  5.14（1656-1669）では消え、代わりに `updated_at` が増えている。
- `SkillFrontmatter`: 5.7（1040-1054）は `title / description / last_reviewed_at / owner_pinned` を持つが、
  5.14（1672-1683）には無い。
- `CapabilityManifest`: 5.9（1255-1270）と 5.14（1608-1625）で `version` の有無などが違う。

→ 5.14 を唯一の source of truth と宣言し、各節は「詳細は 5.14 参照」に寄せるべき。
   今のままだと実装者がどちらを正にするか割れる。

### P1-2. ポリシー評価の競合解決ロジックが無い
5.4 に正準ポリシー行列（768-777）と `PolicyEvaluationInput`（749-764）はあるが、
**複数条件が同時に当てはまった時にどの Decision が勝つか** のルールが無い。
例：「trusted source の Collection 可逆小変更（→allow_with_audit）」だが、その intent が
`external_content` 由来だったら？ 5.5 は外部由来を降格しろと言う。両者の優先順位＝
「最も制限的な Decision を採る（deny > strong > approval > first_time > audit > auto）」のような
**結合規則**を1つ明記しないと、operation が一意の Decision に落ちない。
v0.4 で求めた「単一の評価関数」はまだ表のままで、関数化されていない。

### P1-3. external 由来 → Memory が「命令」として混入する経路が塞がれていない
5.6 で Active Memory は `provisional memory 作成` が allow_auto（974-976）。
5.5 で外部コンテンツの「workspace内の小さな取り込み」は allow_with_audit（856）。
5.6 の昇格条件は「non-sensitive topic memory は allow_with_audit で active 化可」（945, 918）。
→ つまり **external_content 由来の情報が provisional memory になり、後で active へ昇格**し得る。
active memory は retrieval で Context に入る＝実質プロンプト注入。
「source不明は provisional止まり」（948）はあるが、source が `external_content` と
**明示されている** ケースをどう扱うかの不変条件が無い。ここは穴。

修正方針:

- 外部由来Memoryを全面禁止しない。メール・Web・資料から得た事実を覚えられないと秘書として弱い。
- 代わりに、Memoryに `source_kind` / `instruction_authority` / `quoted_from` のような属性を持たせる。
- `external_content` 由来のMemoryは、active化しても **事実・参照データとしてのみContext投入**する。
- `external_content` 由来Memoryから tool intent / external send / public / payment / delete を直接発火させない。
- 外部由来の文中にある「命令文」は、Memory本文に保存できても、Agentへの命令としては扱わない。

### P1-4. first_time_confirm 後の grant 永続化が未定義
`requires_first_time_confirm` は「初回だけ確認、以後 scope内で自動」（701, 772）。
この "以後" を判定する `prior_grants`（759）の **粒度（capability単位か scope単位か schedule単位か）/
有効期限 / 失効・取り消し方法** が無い。一度許可した外部 tool の scope が後から広がる経路になり得る。
P1-2 の競合解決とセットで、grant のデータモデルを 5.14 に1つ足すべき。

### P1-5. 対話セッション中の requires_approval で Agent Loop がどう振る舞うか未定義
非対話（cron）は「approval request 作って skip/defer」（1537-1543）と明確。
だが **対話セッションで承認待ちになった瞬間、Loop が完全停止するのか、他 tool を続けるのか** が無い。
ここを書かないと、v0.3 で否定した「承認が Loop を殺す」問題に静かに回帰する。
設計の中核思想（Loopを止めない）の生命線なので明記が要る。

---

## Priority 2

### P2-1. 「正準ポリシー行列」と個別ポリシー表の関係が宣言されていない
5.4 で正準行列を作った（766）と言いつつ、5.6 / 5.7 / 5.8 / 5.10 / 5.11 / 5.12 に
依然ドメイン別の個別表が散在。意図的な詳細化なら良いが、「正準」を名乗る以上、
**個別表は正準行列から導出される（矛盾したら正準が勝つ）** という関係を1行で宣言すべき。

### P2-2. memory削除 と ファイル削除 の衝突が未解消（v0.4 P2-2 の積み残し）
5.6「memory削除 = requires_approval」（921）と 5.10「ファイル削除 = requires_strong_approval」（1317）。
memory は filesystem 上の Markdown ファイルなので、**memoryファイル削除はどっち**か曖昧なまま。
外部送信も 5.5「deny or requires_approval」（857）/ 5.10「requires_approval」（1316）/
正準行列「requires_approval」（773）で揺れている。用語を1つに確定すべき。

### P2-3. 異常時の能動通知が無い（Home は pull型）
Home に Autonomous Activity / Daily Digest / Anomaly Flags を置いたのは良い改善。
ただ全部 **ユーザーが Home を開かないと気づけない pull型**。
「境界を越える時だけ人間を呼ぶ」（64）と言うが、その "呼ぶ"＝push通知の手段が設計に無い。
Human On The Loop は「事後に気づける」だけでなく「危険時に呼び出される」必要がある。

修正方針:

- v1では外部push通知を必須にしない。
- ただし Home に閉じたpull型だけでは弱いので、Web UI内の `Notification Inbox` / badge / blocking banner を追加する。
- OS通知、メール、外部チャネル通知は `Gateway notification surface` として後続拡張にする。
- 強承認待ち・異常検知・失敗した自律実行だけは、Home以外でも目に入る導線を作る。

### P2-4. `trust_level` という語が2つの別物に使われている
- 5.5 の信頼境界は `InstructionSource`（8値: owner_instruction … system_policy）。
- Skill trust matrix は `trust_level`（generated_local / user_authored / bundled / imported / shared）。
- `PolicyEvaluationInput` にも `trust_level`（758）。
同名 `trust_level` が異なる値空間を指している。実装で型衝突する前に名前を分離すべき
（例: `instruction_source` / `skill_trust` / `actor_trust`）。

### P2-5. 並行性・ロック戦略が本文に無い
10.1 で OpenClaw 由来の concurrency / lock / timeout を「採用」（2295）としているが、
本文（3.2 / 5.3 / 6章）に **WebSocket event stream と SQLite queue の同時更新・ロック方針** が無い。
local-first で filesystem と SQLite index の整合（9.7 で言及）を守るなら、書き込み直列化の
基本方針は v1 設計に要る。

---

## Priority 3（軽微・確認事項）

- **P3-1.** secret masking（5.10, 1341-1347）の **マスク対象パターン定義**が無い。SecretRef 登録値だけか、
  汎用トークン正規表現も見るか、false negative 時の扱いは。1行でも方針が要る。
- **P3-2.** `RollbackPoint.expires_at`（1391, 1714）の **期限切れ後の扱い**（GC / Batch Undo との関係）が未定義。
  Home の Recent Rollback Points / Batch Undo（538-539）と寿命の整合を。
- **P3-3.** v1 vertical slice の **縦切りフロー（2037-2059）は1本で良い**が、その横の
  「v1に入れるもの」表（2061-2074）が依然広め（GUI7画面+Runtime+Policy+DSL3種+Memory+Skill+Capability+
  Safety4種+Gateway+Automation3種）。MVPの cut line を「縦切りを通すのに最低限必要なもの」に
  もう一段絞れる余地あり。
- **P3-4.** 正直さの注記（greenfield 再構築 / license / provider依存の caching）は
  0章・11章に入った（v0.4 P3 解消済み）。維持で良い。

---

## v0.6 改訂プラン

対象ファイル: `ARCHITECTURE.md`（レビュー当時の `DESIGN.md`）

v0.6は大きな方向転換ではなく、v0.5を **実装者が迷わない仕様書** に寄せる改訂にする。

### 1. Core Schemasを唯一の正準にする

- 5.14を `Canonical Core Schemas` として明示する。
- 5.6 / 5.7 / 5.9 の重複スキーマは、詳細定義ではなく「5.14参照」に寄せる。
- `MemoryFrontmatter` / `SkillFrontmatter` / `CapabilityManifest` のフィールド差分を統合する。
- `PolicyGrant` を5.14へ追加する。

### 2. Policy Engineを関数として固定する

- `PolicyEvaluationInput -> PolicyDecision` の評価順序を書く。
- 複数条件が当たる場合は、原則として最も制限的なDecisionを採用する。
- ただし `deny` と `requires_approval` のようにUX上の例外が必要な場合は、例外を明示的に列挙する。
- 正準ポリシー行列と各ドメイン別表の関係を「正準が勝つ」と宣言する。

### 3. Grant永続化を定義する

- `requires_first_time_confirm` 後に保存されるgrantの粒度を決める。
- 最小単位は `actor_identity + capability_id + operation + scope + schedule_context` にする。
- grantには `created_at` / `expires_at` / `revoked_at` / `granted_by` / `reason` を持たせる。
- capability manifestのrisk/scopeが変わったら既存grantは再確認に戻す。

### 4. external由来Memoryを「事実」と「命令」で分ける

- `external_content` 由来のMemoryは、保存・検索・active化を許可する。
- ただし `instruction_authority: none` を持たせ、Agentへの命令として扱わない。
- Active MemoryがContextへ入れる時は、外部由来Memoryを「引用された情報」「参照データ」として注入する。
- 外部由来Memoryから高リスクtool intentが出た場合は、owner instructionが別途ない限りdenyまたはapproval requestにする。

### 5. Approval待ち中のAgent Loop挙動を決める

- 対話セッションで承認が必要になった場合、Loop全体は停止しない。
- 承認対象operationだけを `pending approval` にし、独立したread / draft / preview / explainは継続可能にする。
- 承認待ちoperationに依存する後続toolはdeferする。
- UIには「承認待ち」「継続中」「停止中」を分けて表示する。

### 6. Human On The Loopの通知面を最小実装に落とす

- v1は外部push通知なしでよい。
- 代わりに、Chat Shell内の `Activity Inbox` / badge / inline banner / Context Drawer に置く。
- 強承認待ち、異常検知、自律実行失敗、rollback期限切れ前だけを最初の通知対象にする。

### 7. v1 cut lineをもう一段絞る

- v1のUI surfaceは `Chat Shell / Artifact Card / Workspace Peek / Context Drawer / Memory View / Audit View` を必須にする。
- `Activity Inbox` は専用画面ではなく、`ActivityInboxItem` read modelとChat Shell内の補助表示にする。
- `Skill / Collection` は裏側の最小機能から始め、専用画面はbeta後でもよい。
- Capabilityは `proposal capability` 1本を代表例にして、policy / audit / rollback / memory更新まで縦に通す。
- cronは `memory review` だけを最初の非対話Loopにして、skill curator / collection check は後続に回す。

### 8. UX観点の追記を入れる

- 安全仕様を増やしても、ユーザーから見ると「止まらず、何をしたか見えて、必要な時だけ呼ぶ」体験にする。
- Chat Shellは監査台帳ではなく、秘書の活動が自然に見える作業面にする。
- Approval UIは恐怖訴求ではなく、差分・理由・取り消し可否を短く見せる。

---

## v0.4 レビューからの解消状況（参考）

| v0.4 指摘 | v0.5 での対応 | 状態 |
| --- | --- | --- |
| P1-1 Policy が表止まり | 5.4 に正準行列・PolicyEvaluationInput・「LLMは申告不可」明記 | 概ね解消（評価関数化は残=本P1-2） |
| P1-2 injection 未設計 | 5.5 Instruction Provenance 新設 | 解消（昇格経路の穴は残=本P1-3） |
| P1-3 rollback 万能視 | 5.10 で不可逆集合を明示・「承認でしか守れない」明記 | 解消 |
| P1-4 スキーマ未定義 | 5.14 Core Schemas 新設 | 解消（二重定義のドリフトは残=本P1-1） |
| P1-5 可観測性が薄い | 5.1 Home に Autonomous Activity/Digest/Anomaly/Batch Undo | 概ね解消（push通知は残=本P2-3） |
| P2-1 v1過大 | 8.2 を縦切り1本に組替 | 概ね解消（cut line もう一段=本P3-3） |
| P2-2 重複表/audit曖昧 | allow_with_audit を定義（706-717） | 部分解消（削除衝突は残=本P2-2） |
| P2-3 paired権限境界 | 5.11 Gateway identity scope 新設 | 解消 |
| P2-4 出力masking/skill trust | 5.10 masking・5.7 trust matrix | 解消 |
| P2-5 安全eval | 5.10 Safety boundary eval（5種）追加 | 解消 |
| P3 正直さ | 0章/11章に注記 | 解消 |

---

## 結論

v0.5 は v0.4 レビューを誠実に取り込んだ良い改訂。**「思想 → 仕様」への移行はほぼ完了**している。
残りは新規の大穴ではなく、**(a) 二重定義の一本化、(b) ポリシー評価の関数化（競合解決＋grant永続化）、
(c) external由来Memoryの命令化防止、(d) 承認時の Loop 挙動**という、実装直前に効く「締め」。
特に (b)(c) は中核思想（安全に自動実行を広げる）の正否を分けるので、v1 コード着手前に潰すのが望ましい。

※ 本ファイルはレビュー報告 + v0.6改訂プラン。`ARCHITECTURE.md`（レビュー当時の `DESIGN.md`）本体の改訂・実装はまだ行わない。
