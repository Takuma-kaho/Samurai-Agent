# Samurai Agent Web UI Design

## 0. この文書の位置づけ

この文書は、Samurai Agent の固定 Web UI に関する視覚設計、UI shell、CSS再利用ルールをまとめた文書である。

対象は、`design-lab/web-ui-demo/` の静止デモで固まった見た目を、今後の本番実装でも再現できるようにすること。

この文書は以下を上書きしない。

- `PRINCIPLES.md`: 設計思想、判断基準、前提
- `SAMURAI_AGENT_MANUAL.md`: Workspace、Room、Session、Agentなどの概念と関係性
- `ARCHITECTURE.md`: Host、Agent Backend、Gateway、Memory、Skill、Workspace などの責務分解
- `PUBLIC_NAMING.md`: 公開面の命名ルール

この文書で決めるのは、画面の構成、見た目のトーン、CSSとして再利用すべき部品の考え方である。

この文書で決めないもの。

- Agent Runtime の仕様
- Surface Protocol の型
- DB / API / queue / backend event の仕様
- React / shadcn/ui への実装方法
- 本番コンポーネントのファイル構成

---

## 1. 基本方針

Samurai Agent の Web UI は、以下を基本にする。

- Dark-only
- Chat-first
- Workspace on demand
- Low text
- Calm operational UI

最初に見える画面は、複雑なダッシュボードではなく、静かなチャット作業面にする。

Roomは活動・共有範囲、ChatはRoom内の主要インターフェースとして扱う。現在の静止デモが単一Roomを明示していない場合は、暗黙の個人Roomを表示しているものとして解釈し、概念モデルをSession直下へ戻さない。

Chat-first は、初期表示だけではなくUI全体の主軸である。
Backend進行状況、失敗、Memory/Skill候補、自律実行の見える化も、別のダッシュボードに逃がさず、Chat Shellに付随する補助表示として扱う。

Generative UIは独立アプリを増やす機能ではない。会話の文脈に応じて、文章、Artifact、一時的な操作UI、追加表示なしのいずれを選ぶかという返答形式である。
Workspace CanvasはWorkspace状態の正本ではなく、必要な時だけ開く一時的な投影面として扱う。

ただし、以下の面や導線を消す意味ではない。

- Memory View
- Run History
- Artifact Card
- Settings
- Workspace Peek

Backend event は、独立したUI surfaceではない。
Chat Shell 内の inline status、Context Drawer、Run History への導線として使う。

Memory や Run History は、必要な時に確認できる専用面を持つ。
Context Drawer はそれらの代替ではなく、作業中に軽く見る補助面である。

---

## 2. 画面モード

`design-lab/web-ui-demo/` の静止デモでは、以下の4状態を基準にする。

| 状態 | 役割 |
| --- | --- |
| `Chat Empty` | 初期チャット画面。短い見出しと入力欄だけを中心にする |
| `With Artifact` | 会話の中に成果物カードが出る状態 |
| `Workspace Peek` | 成果物を軽い作業空間として開く状態 |
| `Context Drawer` | Backend event、Memory suggestion、Skill candidate、Tool log などの補助情報を見る状態 |

本番実装でも、いきなり固定2グリッドを主役にしない。

基本はチャット中心で、必要になった時だけ Artifact、Workspace、Context を開く。

---

## 3. レイアウト

### 3.1 App Shell

基本構成は以下。

- 左: 軽いサイドバー
- 中央: メインのチャット作業面
- 右: 必要時だけ開く Context Drawer

App Shell は viewport 全体を使う。
外側を中央寄せのカードとして見せない。
fullscreen shell では内部の scroll owner を明示し、prompt bar と sidebar footer を画面外へ押し出さない。
ただし chat rail 自体は横いっぱいに広げない。
会話本文と prompt bar は中央寄せの max-width を持たせ、ChatGPT / Codex に近い読みやすい幅にする。

左サイドバーは、機能一覧にしすぎない。

常時置くものは以下程度に抑える。

- New chat
- Search
- Automations
- Plugins
- Session list
- Settings

Memory、Skills、Run History、Backend settings などを左サイドバーに常時羅列しない。
これらは専用画面、検索、コマンド、Context Drawer から到達できるようにする。
Session list のタイトルは1行固定にする。
長い session title は `...` で省略し、sidebar 自体を横に広げない。
左ナビの選択状態に緑 dot は使わない。
New Chat、Search、Session item、Settings は、すべて同じグレー系の hover / active highlight に統一する。
hover / active highlight は角丸長方形のグレー背景で表現し、選択中はその背景を保持する。
hover / active で文字の太さ、letter spacing、padding を変えない。選択中も太字化しない。
左ナビ内の icon は hover で白く変化させず、グレーの円形/角丸背景面で反応を見せる。
左サイドバーは desktop で icon rail へ collapse できる。
collapse 時も New Chat、Search、Settings の主要導線はアイコンとして残す。
左サイドバーは desktop でユーザーが幅を調整できる。
幅は UI preference として `localStorage` に保存し、server 設定や DB schema には入れない。
左サイドバーの背景は、固定背景画像の上に半透明 tint と blur を重ねた glass rail として扱ってよい。
ただし背景切り替えUIは作らず、中央のチャット作業面は静かな黒基調を保つ。

### 3.2 Main Stage

中央面は、常に最も静かに保つ。

- 初期画面は短い一文と prompt bar を中心にする
- New Chat は未保存の draft state として扱い、空の session は作成・保存・一覧表示しない
- session は初回送信や実アクションが発生した時だけ作成し、Session list に入れる
- Session list は閲覧クリックだけで並び替えない。送信成功時だけ対象 session をトップへ移動する
- 未保存の新規チャットでは prompt bar を画面中央寄りに置き、送信後は通常の下部 prompt layout に戻す
- 会話中も入力欄が主役から外れすぎないようにする
- fullscreen shell の中でも chat rail は約860px前後を上限にする
- Workspace Canvas 表示時は、chat rail + canvas を中央カード幅に閉じ込めず、desktop では画面を `1fr 1fr` で左右半分に分割する
- Workspace Canvas 表示時は、desktop の中央 divider をドラッグして chat / workspace の比率を調整できる
- workspace split 比率は UI preference として `localStorage` に保存し、server 設定や DB schema には入れない
- Workspace Canvas と Context Drawer は closed / open で grid の列数を変えず、0幅 track から開くことで transition を保つ
- chat shell は固定shell + 左chat scroll + 右workspace independent scroll で構成する
- chat feed は左chat列だけを scroll surface にし、prompt bar は scroll surface の外側で下部に残す
- prompt bar は prompt dock で包み、上部gradientでfeed内容が背面に透けないようにする
- scroll state に応じて上下の薄い fade を出す
- internal scroll surface は native scrollbar を見せず、scroll affordance は fade で補う
- main header は約52pxの薄いtoolbarとして扱い、半透明blurのみで軽く分離する
- chat view の main header には `Chat` / `チャット` title を出さず、補助画面では title を残す
- icon-only button は枠線で囲まず、円形グレー hover surface で反応を出す
- 左サイドバーの collapsed icon-only nav は、丸い button + 丸い hover / active surface に統一する
- Settings は専用画面として扱うが、直前の画面へ戻る導線を header に置く
- Settings は保存方針の管理場所として扱う
- Artifact や Workspace は、会話の流れから自然に出す
- 説明文を増やして機能を説明しない

Settings に置く保存方針。

Learning Coreの標準は自動保存であり、Memory / Skill変更の確認画面や承認待ちqueueは追加しない。Context Drawerに出す場合も、変更履歴・根拠・復元導線として扱い、保存前の必須確認にはしない。

| ブロック | 役割 |
| --- | --- |
| Memory | 毎回効かせる短い個人理解の保存方針 |
| Knowledge Wiki | 調査、設計、プロジェクト知識など濃い知識の保存方針 |
| Skill | 再利用できる作業手順の候補化方針 |
| External memory assist | 外部Providerを参照元付き提案の補助に使うか |

各ブロックは短い説明と segmented control に留める。
API key入力欄は作らない。
Memoryの一覧・詳細はMemory Viewを使い、Settingsに管理一覧を増やさない。
Wiki proposalのaccept / reject / edit / archive は、Context DrawerまたはWorkspace side panel側に置く。

### 3.3 Context Drawer

Context Drawer は、作業中に必要な補助情報を置く場所である。

置いてよいもの。

- Memory suggestion
- Wiki proposal
- Skill candidate
- Backend event
- Tool log
- agent要確認イベント

置きすぎないもの。

- 長文の説明
- 常時必要ではない設定項目
- 専用画面で見るべき履歴全体

---

## 4. Visual Language

### 4.1 Dark Mode

Samurai Agent は Dark mode 固定である。
明るい表示モードと表示切替は持たない。
OSS公開面でも、表示変更の管理導線を出さない。

基本は以下。

- 面はほぼ黒に近い色で揃える
- 上辺中央だけに控えめな light rim を置く
- 発光は広げすぎない
- グローはカード内部に広げない
- chat feed 内の小さい Artifact / Memory preview card だけは、濃いグレー面と 1px border で分けてよい
- 情報密度が高い部分でも、border と typography で整理する

### 4.2 Frame Lighting

Frame lighting は、面全体を光らせる表現ではない。

正しい方向。

- 上辺中央だけに細い rim を置く
- rim は dark surface 上の white rim として扱う
- glow は狭く、薄く、背景に溶かす

避ける方向。

- 面の内側をgradientにする
- 白背景で白ハイライトを使う
- 広い帯のように光らせる
- 高級感を出すために影や光を増やす

---

## 5. CSS Recipe

`design-lab/web-ui-demo/styles.css` をそのまま本番へコピーする前提にはしない。

本番実装では、以下の意味単位として再利用する。

### 5.1 Visual Tokens

最低限、以下の token を持つ。

- background: page / stage / rail / panel / subtle panel
- text: ink / muted / soft
- border: line / line strong
- status: focus / warning / success
- radius: compact / card / pill
- surface: subtle depth / shadow
- edge: light / shade / glow / width / height / opacity / top

Dark-only の基準。

```css
--bg: #000000;
--stage: #050505;
--stage-soft: #080909;
--rail: #070808;
--panel: #050505;
--panel-subtle: #080808;
--ink: #f0f0ed;
--muted: #a4a7a3;
--soft: #737874;
--line: #292d30;
--line-strong: #3a3f42;
```

### 5.2 Lit Surface

`lit-surface` は、再利用可能な「薄い境界面」として扱う。

構成。

- background: panel
- border: 1px solid line
- `::before`: 上辺中央の細い rim
- `::after`: rim の周辺に置く薄い glow

rim は白を使うが、幅と明るさを絞る。

### 5.3 Prompt Pill

入力欄は `prompt-card` の pill 形状を基準にする。

ルール。

- border-radius は pill
- 影は使わない、または最小
- min-height は約48pxから52px
- attach / voice / send はアイコンボタン
- attach は左側の plus icon を使い、初期実装では画像選択と選択中previewまでを扱う
- voice はghost、send はink塗り
- send は紙飛行機ではなく上矢印 icon を使う
- placeholder はsoft color
- 文字ボタンで `Voice` / `Send` を見せない
- icon button は約36pxを基準にして、prompt 全体を重くしない

### 5.3.1 Header Bar

メインヘッダーは、ページの主役ではなく軽いtoolbarとして扱う。

ルール。

- height は約52px
- background は半透明
- backdrop-filter blur を使う
- main header は下線を使わず、shadow も使わない
- Context Drawer の header までは巻き込まない

### 5.4 Message

会話表示は、user message と agent message の役割を分ける。

ルール。

- user message は右寄せ、ink塗り
- agent message は左寄せ、吹き出しなしの通常文章として表示する
- max-width は desktop で約74%
- mobile では約92%
- agent message に frame lighting や panel border を付けない
- user message の角丸は大きくしすぎず、card radius を使う
- message padding は 8px / 12px 程度を基準にし、縦にボテっと見せない
- body text は 14px / 1.5 前後を基本にする
- feed がスクロール可能な時だけ、上下に薄いfadeを出して続きがあることを示す

### 5.5 Artifact Card

Artifact は、会話の成果物として自然に出す。

ルール。

- chat 内に置けるカードにする
- chat feed 内の compact preview card だけ、Dark mode で濃いグレー背景にしてよい
- app 背景、stage、sidebar、prompt、workspace canvas まではグレー化しない
- chat feed では「何が作られたか」だけを出す
- `Artifact`、保存状態、Backend run、Draft などの内部メタ情報は chat feed に出しすぎない
- 表示は作成通知 + title + 最大2行previewに留める
- action button は置かず、card全体クリックでWorkspaceを開く

### 5.6 Workspace Peek

Workspace Peek は、常時2グリッドではなく、必要時に開く作業面である。

ルール。

- desktop では Artifact card や Memory view / Context Drawer の項目をクリックした時だけ chat と workspace canvas を横に並べる
- desktop の workspace open 状態では、Claude の document pane のように右半分全体を workspace として扱う
- desktop の workspace open 状態では、中央の細い divider + handle をドラッグして `32%〜68%` の範囲で chat 幅を調整できる
- divider handle は視覚的には `6px x 22px` 程度の小さい grip にし、透明な hit area だけ最小限残す
- divider handle は keyboard でも調整可能にし、mobile / narrow width では表示しない
- chat 側を完全に消さない
- workspace 側は document surface を中心にする
- workspace canvas 外枠はカード化せず、右ペインとして左境界線だけで分離する
- workspace canvas は chat feed の scroll owner に含めない
- workspace canvas 内の document surface は独立してスクロールする
- feed 内には Artifact の compact preview だけを置き、Session Memory は chat feed に直接出さない
- Artifact の backend run / change metadata は workspace canvas で常時表示せず、Run History / Context Drawer 側に残す
- workspace canvas は DOM から出し入れせず、常設trackを class で開閉する
- 開閉は grid column width、opacity、translate を約180msから220msで transition する
- `prefers-reduced-motion: reduce` では transition を無効化する
- Focus 操作は用意するが、初期状態では主張しすぎない
- mobile / narrow width では1カラムに落とす

### 5.7 Context Drawer

Context Drawer は、補助情報を軽く見る場所である。

ルール。

- 右側に出す
- Memory suggestion / Skill candidate / Tool log のような短いブロックを置く
- close button は枠線なしのghost
- 専門家向けログに寄せすぎない
- mobile / narrow width では下に落とす

### 5.8 Responsive Rules

最低限、以下のbreakpointを持つ。

`980px` 以下。

- app shell を1カラムにする
- sidebar は上部または横並びの軽いnavigationにする
- session list は隠す
- workspace layout は1カラムにする
- context drawer は右ではなく下に落とす

`640px` 以下。

- page padding を小さくする
- screen padding を小さくする
- prompt bar の高さを少し詰める
- message max-width を広げる
- document surface の余白と見出しサイズを下げる

---

## 6. Text And Controls

UI内の文字は増やしすぎない。

避けるもの。

- 機能説明文
- 思想説明
- 長い空状態コピー
- 左サイドバーの機能羅列

優先するもの。

- 短いラベル
- 状態を示すpill
- aria-label付きのアイコンボタン
- 必要時だけ開くDrawer内の短い説明

ボタンは、明確な命令だけ文字でよい。
ツール、入力補助、送信、開閉、状態切替はアイコン中心にする。

---

## 7. Implementation Guardrails

実装時に守ること。

- UIは chat-first を基準にする
- Workspace は常時主役にしない
- Context Drawer は補助情報であり、主画面を奪わない
- Artifact は会話の成果物として自然に出す
- Memory / Run History 専用画面の必要性は維持する
- Runtime / DB / API の仕様を UI 文書に混ぜない
- 公開面に参照元固有名を出さない
- `design-lab/web-ui-demo/styles.css` の見た目を丸ごとコピーせず、recipe単位で再構成する

まだやらないこと。

- React化
- shadcn/ui への落とし込み
- Runtime接続
- DB/API前提の画面化
- Codexグローバルスキル化

---

## 8. 実装へ進む時のチェックリスト

- `PRINCIPLES.md` の Chat-first / Workspace-backed, UI on demand と矛盾していないか
- `ARCHITECTURE.md` の責務分解を UI 側で混ぜていないか
- `PUBLIC_NAMING.md` に反していないか
- `Chat Empty` / `With Artifact` / `Workspace Peek` / `Context Drawer` の4状態を説明できるか
- Dark-only 方針と表示変更なしの前提が崩れていないか
- `lit-surface` / prompt pill / Artifact / Workspace / Drawer のrecipeが保たれているか
- responsive rule が `980px` / `640px` で破綻しないか
- UI文言が増えすぎていないか
