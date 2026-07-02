# Samurai Agent Web UI Demo

Samurai Agent の本実装前に、固定 Web UI の見た目だけを確認するための静止デモです。

このデモは、`WEB_UI_DESIGN.md` の元になった視覚参照です。
実装へ進む時は `WEB_UI_DESIGN.md` を正として読み、このデモは見た目確認用のサンプルとして扱います。

## 目的

- ChatGPT 的な軽さを保つ。
- Resend 的な hairline border、低彩度、精密な金属感をライトモードへ翻訳する。
- `Chat-first + workspace on demand` の画面感を確認する。
- 文字情報を増やしすぎない UI ルールを検討する。
- `WEB_UI_DESIGN.md` にまとめた token / surface / prompt / drawer / workspace の再利用ルールを確認する。

## 画面状態

- `Chat Empty`: 初期チャット画面。
- `With Artifact`: 会話内に生成物カードが出る状態。
- `Workspace Peek`: 生成物を軽いワークスペースとして開く状態。
- `Context Drawer`: Memory / Approval / Tool log を右パネルに逃がす状態。

## 確認方法

`index.html` をブラウザで開いて確認します。

```text
design-lab/web-ui-demo/index.html
```

デモ内のボタンは見た目確認用です。Agent Runtime、DB、API、Surface Protocol には接続していません。

`index.html` と `styles.css` は参照用の静止デモとして残します。
本番コードへそのまま流用する前提ではありません。

## レビュー観点

- ライトモードで重く見えないか。
- ダークモードが Resend 寄りの精密さを持つか。
- 左サイドバーが機能一覧になりすぎていないか。
- Workspace 表示時もチャット中心の軽さが壊れていないか。
- 右 Drawer が専門家向けになりすぎていないか。
- モバイル幅でも破綻しないか。

## 汎用化済みのルール

このデモで固まった見た目は、`WEB_UI_DESIGN.md` に汎用ルールとしてまとめています。

実装へ進む時は、以下の順で確認します。

1. `WEB_UI_DESIGN.md`
2. このデモの `index.html`
3. このデモの `styles.css`

`WEB_UI_DESIGN.md` は、視覚設計、UI shell、CSS再利用ルールの正本です。
Runtime、DB、API、本番コンポーネント構成の正本ではありません。
