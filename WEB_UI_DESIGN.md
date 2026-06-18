# Samurai Agent Web UI Design

## 0. この文書の位置づけ

この文書は、Samurai Agent の固定 Web UI に関する視覚設計、UI shell、CSS再利用ルールをまとめた文書である。

対象は、`design-lab/web-ui-demo/` の静止デモで固まった見た目を、今後の本番実装でも再現できるようにすること。

この文書は以下を上書きしない。

- `PRINCIPLES.md`: 設計思想、判断基準、前提
- `ARCHITECTURE.md`: Runtime、Gateway、Memory、Policy、Audit などの責務分解
- `PUBLIC_NAMING.md`: 公開面の命名ルール

この文書で決めるのは、画面の構成、見た目のトーン、CSSとして再利用すべき部品の考え方である。

この文書で決めないもの。

- Agent Runtime の仕様
- Surface Protocol の型
- DB / API / queue / policy evaluation の仕様
- React / shadcn/ui への実装方法
- 本番コンポーネントのファイル構成

---

## 1. 基本方針

Samurai Agent の Web UI は、以下を基本にする。

- Light-first
- Chat-first
- Workspace on demand
- Low text
- Calm operational UI

最初に見える画面は、複雑なダッシュボードではなく、静かなチャット作業面にする。

Chat-first は、初期表示だけではなくUI全体の主軸である。
承認待ち、失敗、rollback候補、自律実行の見える化も、別のダッシュボードに逃がさず、Chat Shellに付随する補助表示として扱う。

ただし、以下の面や導線を消す意味ではない。

- Memory View
- Audit View
- Artifact Card
- Settings
- Workspace Peek

Activity Inbox は、独立したUI surfaceではない。
`ActivityInboxItem` read model を Chat Shell 内の badge、inline banner、Context Drawer、Audit View への導線として使う。

Memory や Audit は、必要な時に確認できる専用面を持つ。
Context Drawer はそれらの代替ではなく、作業中に軽く見る補助面である。

---

## 2. 画面モード

`design-lab/web-ui-demo/` の静止デモでは、以下の4状態を基準にする。

| 状態 | 役割 |
| --- | --- |
| `Chat Empty` | 初期チャット画面。短い見出しと入力欄だけを中心にする |
| `With Artifact` | 会話の中に成果物カードが出る状態 |
| `Workspace Peek` | 成果物を軽い作業空間として開く状態 |
| `Context Drawer` | Memory candidate、Approval、Tool log などの補助情報を見る状態 |

本番実装でも、いきなり固定2グリッドを主役にしない。

基本はチャット中心で、必要になった時だけ Artifact、Workspace、Context を開く。

---

## 3. レイアウト

### 3.1 App Shell

基本構成は以下。

- 左: 軽いサイドバー
- 中央: メインのチャット作業面
- 右: 必要時だけ開く Context Drawer

左サイドバーは、機能一覧にしすぎない。

常時置くものは以下程度に抑える。

- New chat
- Search
- Automations
- Plugins
- Session list
- Settings

Memory、Skills、Audit、Policy などを左サイドバーに常時羅列しない。
これらは専用画面、検索、コマンド、Context Drawer から到達できるようにする。

### 3.2 Main Stage

中央面は、常に最も静かに保つ。

- 初期画面は短い一文と prompt bar を中心にする
- 会話中も入力欄が主役から外れすぎないようにする
- Artifact や Workspace は、会話の流れから自然に出す
- 説明文を増やして機能を説明しない

### 3.3 Context Drawer

Context Drawer は、作業中に必要な補助情報を置く場所である。

置いてよいもの。

- Memory candidate
- Approval
- Tool log
- ActivityInboxItem
- agent要確認イベント
- Policy / Audit の軽い要約

置きすぎないもの。

- 長文の説明
- 常時必要ではない設定項目
- 専用画面で見るべき履歴全体

---

## 4. Visual Language

### 4.1 Light Mode

Light mode は主役である。

基本は以下。

- white / black / neutral gray を中心にする
- 背景を cream / beige / tan に寄せない
- 影を強くしない
- 面のgradientで高級感を出そうとしない
- 境界線と余白で構造を見せる
- 上辺中央に細い silver rim を置き、金属感を最小限だけ出す

Light mode の rim は、白く発光させない。
白い背景と同化して線が切れて見えるため、薄い銀グレーを中心にする。

### 4.2 Dark Mode

Dark mode は、黒背景と hairline border を中心にする。

基本は以下。

- 面はほぼ黒に近い色で揃える
- 上辺中央だけに控えめな light rim を置く
- 発光は広げすぎない
- グローはカード内部に広げない
- 情報密度が高い部分でも、border と typography で整理する

### 4.3 Frame Lighting

Frame lighting は、面全体を光らせる表現ではない。

正しい方向。

- 上辺中央だけに細い rim を置く
- Light mode は silver rim
- Dark mode は white rim
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

### 5.1 Theme Tokens

最低限、以下の token を持つ。

- background: page / stage / rail / panel / subtle panel
- text: ink / muted / soft
- border: line / line strong
- status: focus / warning / success
- radius: compact / card / pill
- surface: subtle depth / shadow
- edge: light / shade / glow / width / height / opacity / top

Light mode の基準。

```css
--bg: #ffffff;
--stage: #ffffff;
--stage-soft: #f7f7f8;
--rail: #f7f7f8;
--panel: #ffffff;
--panel-subtle: #f8f8f9;
--ink: #101110;
--muted: #62646a;
--soft: #9a9ca3;
--line: #e5e7eb;
--line-strong: #d1d5db;
```

Dark mode の基準。

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
- optional depth: Light mode だけごく薄く使う
- `::before`: 上辺中央の細い rim
- `::after`: rim の周辺に置く薄い glow

Light mode は、中央を白にしない。
薄い銀グレーで、背景から少しだけ分離させる。

Dark mode は、白い rim を使うが、幅と明るさを絞る。

### 5.3 Prompt Pill

入力欄は `prompt-card` の pill 形状を基準にする。

ルール。

- border-radius は pill
- 影は使わない、または最小
- min-height は約56pxから60px
- attach / voice / send はアイコンボタン
- voice はghost、send はink塗り
- placeholder はsoft color
- 文字ボタンで `Voice` / `Send` を見せない

### 5.4 Message Bubble

会話の吹き出しは、情報量を抑える。

ルール。

- user message は右寄せ、ink塗り
- agent message は左寄せ、panel surface
- max-width は desktop で約74%
- mobile では約92%
- 角丸は大きくしすぎず、card radius を使う

### 5.5 Artifact Card

Artifact は、会話の成果物として自然に出す。

ルール。

- chat 内に置けるカードにする
- header / preview / action に分ける
- status は pill + small dot
- 説明文は最大2行程度に抑える
- action button は控えめにする

### 5.6 Workspace Peek

Workspace Peek は、常時2グリッドではなく、必要時に開く作業面である。

ルール。

- desktop では chat と workspace を横に並べる
- chat 側を完全に消さない
- workspace 側は document surface を中心にする
- Focus 操作は用意するが、初期状態では主張しすぎない
- mobile / narrow width では1カラムに落とす

### 5.7 Context Drawer

Context Drawer は、補助情報を軽く見る場所である。

ルール。

- 右側に出す
- Memory / Approval / Tool log のような短いブロックを置く
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
- Memory / Audit 専用画面の必要性は維持する
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

- `PRINCIPLES.md` の GUI-first / Workspace-first と矛盾していないか
- `ARCHITECTURE.md` の責務分解を UI 側で混ぜていないか
- `PUBLIC_NAMING.md` に反していないか
- `Chat Empty` / `With Artifact` / `Workspace Peek` / `Context Drawer` の4状態を説明できるか
- Light mode と Dark mode の役割が崩れていないか
- `lit-surface` / prompt pill / Artifact / Workspace / Drawer のrecipeが保たれているか
- responsive rule が `980px` / `640px` で破綻しないか
- UI文言が増えすぎていないか
