# Samurai Agent Architecture

## 全体構成

Native Appと外部アプリは、共通のClient APIを通じてWorkspace Coreへ接続する。

Workspace Coreは、認可、データ所有、操作、履歴を管理する。

RuntimeはAgentの実行を担当し、Knowledge HostはActivityからKnowledgeやSkillを育てる。

Backend、Gateway、Adapterは外部のAgentやAI提供元との接続を担当する。

## 基本構造

Workspace → Room → Session、Activity、Knowledge、Skill

ServerはWorkspace Coreを配置・運用する境界であり、製品上の必須階層ではない。Native Appは登録済みの複数Serverを横断してWorkspaceを表示し、利用者はWorkspaceを選択する。選択時に対応するServer接続を裏で解決し、対象Workspaceを再認可してから表示する。

Workspaceは単体で成立する基本単位である。Room、Agent、Knowledge、メンバー、招待、実行結果、export / restoreを所有する。

Roomは会話、作業、Knowledge、権限の範囲を決める。

SessionはRoom内の実行を継続・復旧するために内部管理する。

Organizationは、同一Server上の複数Workspaceを任意でまとめる管理層である。OrganizationがなくてもWorkspaceは利用でき、Organizationへの所属だけではWorkspaceやRoomの内容を読めない。複数Serverを横断するWorkspace switcherはNative Appの接続機能であり、Organizationを横断管理する機能ではない。

## 操作の入口

Workspace Coreへの操作は、次の共通入口を通す。

- Query：情報を取得する
- Domain Operation：状態を変更する
- Activity Ingest：外部の作業結果を証拠として取り込む
- Run Control：実行の継続や停止、復旧を管理する

公開APIはバージョンを持ち、Native Appと外部アプリで同じ契約を利用する。

## Event

操作結果は共通のEventとして記録する。

ClientはEvent履歴とリアルタイム通知を組み合わせ、切断後も履歴から状態を復元する。

## データ所有

- PostgreSQL：ID、関係、権限、履歴、整合性
- ファイル：Knowledge、Skillなど利用者が所有する本文

Knowledgeの参照・学習範囲はRoomごとに管理し、共有は明示操作で行う。

Workspaceは一つのホームServerに配置する。別Serverへの移転はWorkspace単位のexport / restoreと整合性確認で行い、切替完了後も移転元を自動削除せずarchiveとして残す。削除は別の明示操作とする。同一Server内のOrganization追加・解除はWorkspaceのデータIDや履歴を変更しない。

## 責務境界

- Clientは表示と利用者操作を担当する
- Workspace Coreは認可とデータ変更を担当する
- RuntimeはAgent実行を担当する
- Knowledge Hostは学習処理を担当する
- Gateway、Adapter、BackendはWorkspace Coreへ結果を返す
- Native Appと外部アプリは同じCoreを利用する
- Native AppのWorkspace targetは少なくともServer connectionとworkspace IDの組で識別し、workspace ID単独で別ServerのWorkspaceへ接続しない
- Organizationは同一Server内のWorkspace一覧、Membership管理、共通ポリシーを扱うが、Workspace / Room contentの認可根拠にはならない

## 検証原則

- 権限外の操作を拒否できる
- Roomごとのデータ境界を守れる
- 中断した処理を重複なく復旧できる
- Event履歴からClient状態を復元できる
- ExportとRestoreで利用者のデータを再現できる
- 実際に確認できた範囲だけを完了とする
