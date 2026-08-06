# Samurai Agent Web UI Design

## 0. この文書の位置づけ

この文書は、Samurai Native AppのWeb UIに関する視覚設計とUI責務の正本である。

ここで定義するもの。

- Chat、Session、App Agent、Surfaceの見せ方
- 固定Web UIのレイアウトと表示状態
- Dark-only、Chat-first、UI on demandの視覚方針
- Workspace Coreを利用するクライアントとしての境界

ここで定義しないもの。

- Workspaceの永続モデル
- Room権限
- Domain Operation
- Activity Historyの保存契約
- Backend、Runtime、Gateway、DB、APIの仕様

それらは PRINCIPLES.md、SAMURAI_AGENT_MANUAL.md、ARCHITECTURE.md の正本に従う。

---

## 1. UIの役割

Web UIは、Workspaceそのものではない。Samurai Native AppがWorkspaceを利用するためのクライアントである。

~~~mermaid
flowchart LR
  User["人間"]
  App["Native App UI"]
  Session["App Session"]
  Surface["Surface"]
  Gateway["Gateway"]
  Core["Workspace Core"]

  User --> App
  App --> Session
  App --> Surface
  App --> Gateway
  Gateway --> Core
~~~

- Chat、Session、App AgentはNative Appが所有する。
- WorkspaceはKnowledge、Activity、Artifact、Collectionを所有する。
- UIを閉じてもWorkspaceの正本は残る。
- Native Appだけの専用Knowledge領域は作らない。

---

## 2. 基本方針

- Dark-only
- Native App内はChat-first
- UI on demand
- Low text
- Calm operational UI

最初に見えるのは静かなChat作業面である。Workspace、Knowledge、Run History、Contextは必要な時だけ開く。

Chat-firstは、Workspace Core全体の原則ではない。Native Appの表示・操作方法として採用する。

---

## 3. 画面状態

| 状態 | 役割 |
| --- | --- |
| Chat Empty | 新しいSessionをまだ保存していない初期画面 |
| Chat Active | 会話と実行状態を表示する通常画面 |
| With Artifact | 会話から成果物のpreviewを表示する状態 |
| Workspace Peek | ArtifactやKnowledgeを右側で見る状態 |
| Context Drawer | Activity、Memory候補、Skill候補、Run状態を見る補助面 |

空のChatは、初回送信または実アクションまでSessionとして保存しない。

---

## 4. レイアウト

### 4.1 App Shell

- 左：軽いNavigation
- 中央：Chat rail
- 右：必要時だけ開くWorkspace PeekまたはContext Drawer

中央のChat railは読みやすい最大幅を持つ。画面全体を大きなカードで囲まない。

常時置くNavigation。

- New Chat
- Search
- Automation
- Plugin
- Session list
- Settings

Memory、Skill、Run History、Backend設定を常設メニューに並べすぎない。検索、専用画面、Context Drawerから到達する。

### 4.2 Chat

- 初期画面は短い見出しとprompt barだけにする
- User messageは右寄せ、Agent messageは左寄せの通常文章にする
- Agent messageを大きなカードや発光面にしない
- prompt barは画面下部に残す
- Session listは送信成功時だけ並び替える
- Backendの進行状態はChat内の補助表示にする

### 4.3 Workspace Peek

- Artifact、Knowledge、Collectionをクリックした時だけ開く
- desktopではChatと右側のWorkspaceを分割する
- Chatを完全には消さない
- Workspace側は独立してスクロールする
- split比率はUI preferenceとしてlocalStorageに保存する
- mobileでは1カラムに落とす

Workspace PeekはWorkspaceデータの投影であり、Workspaceの保存単位ではない。

### 4.4 Context Drawer

置いてよいもの。

- Activityの要約
- Memory / Knowledge / Skill候補
- Backend Event
- Tool log
- 要確認状態

長文の思想説明、常時必要ではない設定、履歴全体は置かない。

---

## 5. Chatから現れるSurface

Generative UIは、会話を置き換える独立アプリではない。

~~~text
Chat
 ├─ 文章だけで足りる
 ├─ Artifact previewを出す
 ├─ Collection editorを出す
 ├─ Knowledge viewを開く
 └─ 何も追加表示しない
~~~

Surfaceは、WorkspaceのArtifact、Collection、Knowledge、Activityを表示・操作する。

- Surfaceの表示状態はNative Appが持つ
- 保存対象はWorkspace CoreへDomain Operationで送る
- SurfaceのレイアウトやDOMを正本にしない
- Sessionの会話履歴とWorkspaceのKnowledgeを同じ一覧に混ぜない

---

## 6. Visual Language

### 6.1 Dark-only

Samurai Native AppはDark表示を基本とする。

~~~css
--bg: #000000;
--stage: #050505;
--panel: #080808;
--ink: #f0f0ed;
--muted: #a4a7a3;
--line: #292d30;
~~~

- 面はほぼ黒で揃える
- 上辺中央に薄いrimを置く
- glowを広げすぎない
- カードを増やしすぎない

### 6.2 Prompt bar

- pill形状
- 高さ48〜52px
- attach、voice、sendはicon中心
- sendは上矢印
- placeholderは薄い色
- 枠線と影を強くしない

### 6.3 Artifact card

- Chat内では作成通知、title、短いpreviewだけを表示する
- 内部的なBackend情報を本文へ出しすぎない
- クリックでWorkspace Peekを開く

### 6.4 Navigation

- hover / activeはグレーの背景面で表現する
- 選択状態を太字や緑dotだけで示さない
- desktopではicon railへ折りたためる
- 幅やsplit比率はlocalStorageに保存し、Workspace DBへ入れない

---

## 7. Responsive

### 980px以下

- 1カラムへ変更
- Sidebarを軽いNavigationへ縮小
- Session listを隠す
- Workspace PeekとContext Drawerを下部へ移す

### 640px以下

- page paddingを縮小
- prompt barを少し詰める
- message幅を広げる
- document surfaceの余白と見出しを縮小

---

## 8. 保存と表示の境界

| UIの状態 | 所有者 | Workspaceへ保存するもの |
| --- | --- | --- |
| Chat message / Session | Native App | 必要なActivityとSessionRef |
| App Agentの会話 | Native App | 結果、変更、出所 |
| Artifact preview | Native App | Artifact本体とRevision |
| Collection editor | Native App | Collectionの変更 |
| Context Drawer | Native App | Activity、候補、Run参照 |
| Workspace Peek | Native App | KnowledgeやArtifactの明示変更 |

Session全文、UIの開閉、split比率はWorkspace Backupの対象にしない。

---

## 9. 実装ガードレール

- Workspaceを常設Dashboardの主役にしない
- RoomをChat roomとして説明しない
- SessionをWorkspaceの必須親にしない
- App AgentをWorkspaceのBackendと混同しない
- Runtime、DB、API仕様をこの文書へ持ち込まない
- 参照元固有名をUI文言や公開コンポーネント名に出さない
- design-labの見た目を丸ごとコピーせず、tokenとrecipe単位で再利用する

実装前に、PRINCIPLES.md、ARCHITECTURE.md、PUBLIC_NAMING.mdとの責務と用語の一致を確認する。
