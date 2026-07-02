# MulmoClaude型 Handoff Backlog

## 目的

外部Agent Backendに任せる実行体験を、本文詰め込み型ではなく、参照先中心のHandoffへ寄せるための後続メモ。

## 後で実装する項目

- Role別ツール切り替え
  - 依頼の種類や作業モードごとに、外部Backendへ見せるツール群を切り替える。
- MCP / allowed tools の実行ごとの整理
  - Gateway Boundary、利用可能ツール、外部Backend固有の許可ツールを1つの実行単位で整理する。
- prompt / contextサイズ警告
  - Codexへ渡す前に、文脈が大きくなりすぎていないかをRun History / Context Drawerで見えるようにする。
- custom dirs / reference dirs
  - ユーザーが指定した参照ディレクトリやプロジェクト資料フォルダを、本文ではなく参照先として渡す。
- attachments handoff
  - 添付ファイルを外部Backendへ渡す時に、本文化せず、ファイル参照として扱う。
- journal / daily summary 的な履歴ポインター
  - Session Searchの本文要約だけでなく、日次・作業単位の履歴ポインターを渡せるようにする。
- Docker / sandbox系の詳細制御
  - 外部Backendのsandbox、workspace access、network accessを実行ごとに見える形で扱う。

## 今回の実装との関係

- 今回は `context_handoff` と `host_progress` を先に入れ、何を渡したか・何をしているかを見える化する。
- 上記項目は、今回の実装で作るHandoffの土台に後から載せる。
