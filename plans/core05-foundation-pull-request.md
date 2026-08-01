# Core 05: Room / Agent基盤と学習範囲の追加

## PRタイトル

`Core 05のRoom・Agent基盤を追加`

## 概要

WorkspaceにRoomとAgentを保存し、Chat実行と学習記録を `Room + Session + Agent + Backend` で結び付ける基盤を追加する。

- SessionはRoomに所属し、Backend Runは実行したAgentを記録する。
- HostがAgentのBackend bindingを解決し、Backend Session keyを4要素で固定する。
- Memory・Knowledge Wiki・Skill・学習利用記録をRoom／Agent／Session範囲で先に絞る。
- Background Reviewは元のRoom範囲だけを読み書きし、出所が不足するRunは停止する。

## 背景

Core 01〜04で整備したWorkspace保存・Host・Backend cassetteの上に、Core 05のLearning Coreへ進むための活動範囲と役割の土台が必要だった。

既存のBackend IDだけでは、どの役割がどのRoomで実行・学習したかを後から追えない。また、学習レビューが範囲不明のデータを読むことを防ぐ必要がある。

## 主な変更

- SQLite migrationでRoom、Agent、利用範囲、学習出所を保存する。
- `room.*` と `agent.*` のDomain Operationを追加する。
- Settingsの既定Room／既定Agentを検証し、Gatewayを含む新規SessionにRoomを必須化する。
- Agentの永続的なBackend変更を `agent.backend.bind` に限定し、Turn単位の`backend_id`は互換用の一時指定として維持する。
- Background Reviewの候補取得、学習履歴、既存リソース、変更対象をRoom／Session／Agent範囲で検証する。
- 古い未分類の学習参照は、Roomレビューで本文を読み込まない。
- 正本ドキュメントと固定契約fixtureをCore 05の128操作に同期する。

## 意図的に含めないもの

- Web／Desktop画面
- Room membership、招待、ACL、閲覧権限
- 旧Session／RunへのRoom・Agent出所のbackfill
- 旧Bundle復元の互換
- Agentの自動生成、動的Plugin、後続Coreの学習判断

## 確認済み

- `pnpm run core:domain-commands:check`
- `pnpm --filter @samurai-agent/runtime run typecheck`
- `pnpm --filter @samurai-agent/workspace-store run typecheck`
- `pnpm --filter @samurai-agent/agent-backends run typecheck`
- `pnpm run core:test:background-review`
- `pnpm run core:test:wiki-learning-loop`
- `pnpm exec vitest run packages/runtime/src/core05-room-agent-runtime.test.ts`
- `git diff --check`

## レビュー観点

- Host以外がBackend Session keyを組み立てていないこと。
- Room／Agent情報がないBackground Reviewが、全件読込やWorkspace範囲への自動昇格をしないこと。
- AgentのBackend bindingと一時的なBackend指定が混同されていないこと。
- UIや権限管理など、Core 05の範囲外を追加していないこと。
