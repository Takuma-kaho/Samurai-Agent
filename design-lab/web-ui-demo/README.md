# Samurai Agent Web UI Demo

Samurai Agent の本実装前に、固定 Web UI の見た目だけを確認するための静止デモです。

実装へ進む時は`PRODUCT.md`と`ARCHITECTURE.md`を正本として読み、このデモは見た目確認用の補助資料として扱います。

## 目的

- ChatGPT 的な軽さを保つ。
- Resend 的な hairline border、低彩度、精密な金属感をライトモードへ翻訳する。
- `Chat-first + workspace on demand` の画面感を確認する。
- 文字情報を増やしすぎない UI ルールを検討する。
- token / surface / prompt / drawer / workspace の見た目を確認する。

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

このデモは、実装前後の見た目を確認するための静止画面です。Runtime、DB、API、本番コンポーネント構成の正本ではありません。
