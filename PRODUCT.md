# Samurai Agent

## 製品

Samurai Agentは、人と専門Agentが一緒に働き、その過程で得た知識・経験・判断を利用者が所有できるAI-native Workspaceである。

使い慣れたChatを中心に、複数のAgentや外部アプリを同じWorkspaceへ接続できる。

## 製品体験

- Native AppはChatを中心に構成する
- Workspace、Roomを左側から選択できる
- Roomを継続的な会話と作業の場として扱う
- Agentはプロフィールと専門性を持つチームメンバーとして参加する
- 学習結果や根拠は、必要なときに確認・修正できる
- 複数Workspaceをまとめて管理したい場合だけ、Organizationを追加できる

独自性は特殊なUIではなく、知識の所有、学習、再利用、移植性に置く。

## 基本単位

- Server：Workspaceを配置・運用する場所。製品上の必須階層ではない
- Workspace：利用者が所有するKnowledgeの正本であり、メンバー、Room、Agent作業、export / restoreの基本単位
- Room：会話、作業、Knowledge、権限の境界
- Organization：同一Server上の複数Workspaceを任意でまとめて管理する追加機能
- Agent：専門性を持って作業へ参加する実行主体
- Session：Room内の実行継続を支える内部参照
- Activity：作業で起きたことを示す証拠
- Episode：関連するActivityのまとまり
- Knowledge：次の作業で再利用できる知識
- Skill：再利用できる手順

## 学習と所有

作業結果はActivityとして残し、根拠を持つKnowledgeやSkillへ育てる。

自動学習は同じRoom内で行い、Roomをまたぐ共有は利用者の明示操作で行う。

KnowledgeとSkillは、特定のAgentやAI提供元に依存せず、利用者が確認・編集・移植できる。

## 判断基準

- 非エンジニアが迷わず使える
- 利用者が自分のデータを所有できる
- AgentやAI提供元を交換できる
- Native Appと外部アプリで同じKnowledgeを利用できる
- 作業結果と、その根拠を追跡できる
