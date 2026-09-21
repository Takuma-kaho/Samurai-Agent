# Native UI・メニュー・入力欄の改善計画

作成日: 2026-09-19

状態: 2026-09-19の実装依頼に基づき実装・検証中。追加要件R13〜R15を含める。実施結果は[検証記録](../reports/native-ui-menu-refinement/report.md)へ記録する。

利用者向けの別資料: [改善内容と進め方](native-ui-menu-refinement-overview-plan.md)

### 2026-09-19の実装中の範囲変更（以下の旧工程より優先）

利用者の回答により、今回はデザイン修正を優先する。

- Room行右クリックの作成・子Room作成・移動・名前変更はUIのみ。新たな機能接続・保存処理は後続とし、項目を無効表示して成功を装わない。既存の別入口から動く機能は維持する。
- Workspaceは同名でも名前をそのまま表示する。接続先名の補足と同名時の追加機能は今回実装しない。内部の`connectionId + workspaceId`による識別は維持する。
- RoomメニューのKnowledge・学習ボタンから既存画面を中央に開く方針は了承済み。新しい画面内容は作らない。
- V3のうち新しい右クリック操作の実Server保存確認は後続。既存の参加者管理・担当Agent選択・設定の維持、V1・V2・V4・V5の今回変更に関係する確認を実施する。後続へ回した機能を完成扱いしない。

## 1. 目的・背景

左ナビゲーション、Room一覧、中央の会話と入力欄という大枠を維持し、各部品の配置、配色、情報量、メニューの役割を揃える。必要な操作へ少ない手順で到達でき、設定や成果物を開いても進行中の仕事を失わないことを製品価値として守る。

利用者の実画面では、Workspace選択の説明過多、横並びの検索・通知、テーマと合わない緑色の設定画面、過剰な枠線、参加者のID表示、Roomメニューと成果物の同時表示、入力欄の重複した案内が問題になっている。

## 2. 禁止事項

- 左ナビ＋会話の基本構成を作り直さない。
- Roomメニューを6タブのまま残す、横タブへ置き換える、別のカテゴリタブを新設する、という解決にしない。
- Roomメニューを「Room設定」「Room管理」と呼ばない。全画面の個人設定の表示名は「設定」とする。
- 見た目の整理を理由に、既存の参加者管理・共有・保存・権限確認・失敗表示を削除しない。
- Knowledgeの新画面の中身、概要情報、学習画面の再設計、モデル・推論レベルの選択機能を先回りして作らない。
- 参照画像のIDコピー、退出、削除などを、指示された機能だと解釈して追加しない。
- 実在しない参加者、写真、オンライン状態、未読数で完成を装わない。今回UIだけを作る右クリック項目は未接続と明記し、機能完成と扱わない。
- 既定Agentを依頼単位の担当切り替えへ無断で変更しない。自動選択や権限の緩和を行わない。
- Coreを迂回する更新、エラー隠蔽、未検証の成功扱い、テストの弱体化をしない。
- スキル集全体のグローバル導入は今回行わない。既に導入したcodexスキルの削除も依頼されていない。
- 実装は2026-09-19の明示依頼で承認済み。branch作成・commit・push・設計書更新は行わない。

## 3. 正本・参照資料・確定事項

### 3.1 正本と既存計画

- [PRODUCT.md](../PRODUCT.md)、[ARCHITECTURE.md](../ARCHITECTURE.md)
- [Native App画面設計](../docs/designs/native-app.md)第11〜15章
- [Native UI移行](../docs/designs/native-ui-migration.md)
- [RoomとAgentの共同作業](../docs/designs/room-agent-work.md)
- [Native UI・Room中心の記憶管理・共有計画](native-ui-workspace-context-sharing-plan.md)
- [試作品UI移行計画](native-openclaw-ui-migration-plan.md)

この会話の最新合意は、既存設計書の6タブ、Workspace選択内の未読表示、既定Agentのヘッダー表示などの表示仕様を変更する。既存計画全体の完了条件やCoreの契約は変更しない。設計書は過去仕様を含むため、本書との対応表を使い、古い画面仕様へ戻さない。本作業では設計書を編集しない。

### 3.2 デザイン参照先

プロダクトのデザイン・実装時に、必要なスキルを読み直せるよう、以下を継続参照先として残す。

| 参照先 | 使う範囲 |
| --- | --- |
| [awesome-design-skills 全体](https://github.com/bergside/awesome-design-skills) | 利用者指定のスキル集。codex以外にも適した部品の参考があるか確認する入口 |
| [codexスキル](https://github.com/bergside/awesome-design-skills/tree/main/skills/codex) | 主な参考。情報量の少ない部品、統一した余白、意味で管理する配色、操作状態、明確なラベル |
| [codex SKILL.md](https://github.com/bergside/awesome-design-skills/blob/main/skills/codex/SKILL.md)／[DESIGN.md](https://github.com/bergside/awesome-design-skills/blob/main/skills/codex/DESIGN.md) | 実装時に読む具体的な指針。Samuraiの既存3テーマと今回の合意を優先する |
| [Microsoft Fluent 2 Avatar group](https://fluent2.microsoft.design/components/web/react/core/avatargroup/usage) | 人とAgentのアイコンを重ねる表示と、上限を超えた人数の入口 |
| [Google Material Web Menus](https://github.com/material-components/material-web/blob/main/docs/components/menu.md) | 小さなメニューの配置基準、キーボード操作、閉じた後の扱い |

codexスキルはBergside / TypeUIのデザイン指針であり、OpenAI Codexの公式UI仕様書として扱わない。各参照先は変更され得るため、実装で採用した箇所と参照日を作業記録へ残す。スキル集を一括で適用せず、他の指針を採る場合も役割を限定し、テーマや画面構成を混在させない。参照のためだけに新しいUIライブラリを導入しない。

### 3.3 会話で確定した仕様

| ID | 確定した内容 |
| --- | --- |
| R1 | Workspace選択は名前を中心にする。「固定入口」「接続済みServer」などの見出し、未読情報、装飾的な枠線を除く |
| R2 | 左ナビに検索欄を1つ配置。その下に通知、Agentを縦に並べる |
| R3 | 設定・メニューを既存の各テーマへ統一。緑色や暖色の独自背景、過剰な四角い枠線をやめる |
| R4 | ヘッダーは人とAgentを混ぜた3〜4個程度の重なるアイコン。開いた参加者一覧から追加・権限変更なども行える |
| R5 | 3点ボタンはRoomメニュー。独立したSVGのパネル開閉ボタンは成果物を確認するための操作 |
| R6 | 担当Agentの表示・切り替え入口は、チャット入力ボックスの下。将来のモデル・推論レベルの左側に置ける構造 |
| R7 | Roomメニューは右パネルの1画面。タブなし。参加者とAgentを別タブにせず、共有はボタンにする。成果物と同時に開かない |
| R8 | Room作成・移動などは左ナビの右クリックで小さなポップアップを開く。今回はUIと開閉操作のみ、項目からの機能接続は後続。ダブルクリックにはしない |
| R9 | Knowledgeは将来の全画面を想定。概要情報と新しい画面の中身は今回作らない。Knowledgeと学習をRoomメニュー内の別タブにしない |
| R10 | 入力欄を簡素にし、「⌘/Ctrl + Enterで送信」の常時案内を消す |
| R11 | 「本人設定」の画面名・メニュー項目は「設定」に統一する |
| R12 | awesome-design-skillsのGitHub URLを計画に残す。全体のグローバル導入は今回省く |
| R13 | 左ナビのSamuraiアイコンとテキストを削除し、Workspace選択を先頭にする |
| R14 | アプリ全体の文字・アイコン・余白・枠線をCodex skillで見直す。添付Codex／Buzzの情報密度を参考に、既存の3テーマと機能を維持して小ぶりに統一する |
| R15 | 実装前・途中・実装後に実画面を撮影して目視評価する。スクリーンショット内の文章や操作項目は追加の依頼として扱わない |

## 4. 現行実装と確認できた原因

確認日は2026-09-19。利用者提供の画面と現行sourceを照合した。実Clientでの再現操作や修正後テストはまだ行っていない。

| 対象 | 現行実装・根拠 | 今回必要な変更 |
| --- | --- | --- |
| Workspace選択、検索・通知 | [NativeApp.tsx](../apps/web/src/native-app/NativeApp.tsx)に見出し、Server情報、未読、固定入口がある。[app.css](../apps/web/src/styles/app.css)のquick-actionsは2列 | 重複情報の整理と縦配置。検索を実際に入力できる欄にする |
| 配色・見出し | [NativeAccountSettings.tsx](../apps/web/src/native-app/NativeAccountSettings.tsx)と[NativeRoomAdministration.tsx](../apps/web/src/native-app/NativeRoomAdministration.tsx)に緑系の固定色、グラデーション、独自のセリフ体、大きな見出しがある | 共通theme tokenと文字階層へ移行 |
| 右パネルの同時表示 | NativeAppは`closed`以外ならRoom用と成果物用の両targetを作り、`hidden`で分けている。一方app.cssは両パネルに`display:flex`を指定し、対象の`[hidden]`規則がない | CSSが非表示指定を上書きする経路を実画面で再現し、表示領域を確実に一つにする |
| 参加者のID | [use-native-room-participants.ts](../apps/web/src/native-app/use-native-room-participants.ts)は人の`label`へ`accountId`を直接代入している | 認可済みの表示名へ解決。IDを主表示に使わない |
| 参加者の画像 | 現行`NativeAgent`と参加者投影に画像URLの契約はない | 名前の頭文字・共通SVGの代替アイコンを使える構成。写真データやuploadを新設しない |
| 右クリック | [RoomNavigator.tsx](../apps/web/src/components/RoomNavigator.tsx)にRoom選択・階層開閉はあるが、右クリックメニューはない | Room選択とは独立したメニュー状態と操作対象を追加 |
| Room作成・移動、人の参加管理 | [use-native-room-administration.ts](../apps/web/src/native-app/use-native-room-administration.ts)にcreate、移動前確認、move、参加変更前確認、member保存がある | 入り口と見せ方を変え、既存処理を再利用 |
| 名前変更 | [domain-api-v1.ts](../apps/server/src/workspace-server/domain-api-v1.ts)と[workspace-server-store.ts](../packages/workspace-server/src/workspace-server-store.ts)に`room.patch`がある。現行Room管理hookには名前変更操作がない | Clientへの接続が必要。CSS変更だけで実現済みとはしない |
| ピン留め・アーカイブ | 調査したRoomの公開操作・Clientには対応経路を確認できていない。成果物のpin、Workspaceのarchiveは別の機能 | メニュー候補と実装済み機能を混同しない。第11節に残す |
| 担当Agent、入力欄 | [RoomWorkSurface.tsx](../apps/web/src/native-app/RoomWorkSurface.tsx)にヘッダー表示、未設定banner、入力placeholder、送信案内が重複している。既存の既定Agent変更処理はある | 表示を入力欄下へまとめ、既存変更処理へ接続 |
| 設定の名称 | [NativeProfileMenu.tsx](../apps/web/src/native-app/NativeProfileMenu.tsx)とNativeAccountSettingsに「本人設定」がある | 可視ラベル、画面見出し、アクセシブル名を「設定」へ統一 |
| Knowledge | NativeAppには中央で[NativeKnowledgeTools](../apps/web/src/native-app/NativeKnowledgeTools.tsx)を表示する分岐もある | 新しい内容を設計せず、既存の入口・機能を失わない移行方法を確認する |

既存Vitest環境はNodeで、主要UIテストには静的描画と純粋関数のテストがある。`hidden`属性があることを静的描画で確認するだけでは、CSS適用後の非表示や実際のfocusは証明できない。

## 5. 対象・対象外

対象はNative Appの表示と操作導線、および既存処理へつなぐためのClient側の調整。Backendの認可・保存契約を作り直す計画ではない。新しい公開操作が必要と分かった項目は、必要な理由と差分を明記してから範囲を確定する。

Knowledgeの新しい本文・概要・管理画面、学習仕様の再設計、モデル／推論レベル選択、Agent実行方式、データ移行、全OS配布、UIライブラリ総入替、スキル集全体の導入は対象外。

名前変更・ピン留め・アーカイブは、利用者が右クリック操作の例に挙げた候補として残す。保存範囲やアーカイブ後の挙動まで合意されたものと解釈せず、黙って今回の実装必須へ増やしたり、候補から消したりしない。

## 6. 守る設計境界

- Workspaceの識別は`connectionId + workspaceId`、Room操作はさらに`roomId`を使う。表示名だけへ簡素化しても識別子と再認可は維持する。
- 右クリックしたRoomと現在会話中のRoomを混同しない。対象を開くだけでRoom選択やデータ変更を実行しない。確定操作時も最新の対象と権限を照合する。
- 人のRoom membershipとAgentの参加・実行権限は、見た目を統合しても別の既存契約を維持する。Coreで拒否される操作をUIで許可しない。
- 担当Agentの表示位置を変えても、既定Agentの変更はRoomに保存され、次の新規依頼へ適用される。既存Workの担当・返信先・実行中処理は変えない。
- パネル・設定・Knowledge導線で会話、添付、返信先、成果物の未保存編集、実行streamを失わない。[use-native-draft-navigation.ts](../apps/web/src/native-app/use-native-draft-navigation.ts)の保護を利用する。
- テーマ変更でコンポーネントを再作成しない。個人の表示設定と、共有されるRoomの設定・認可を混ぜない。
- 操作ID、期待する版、移動前確認、保存後の再取得、古い非同期応答の除外を維持する。

## 7. 画面・部品の具体方針

### 7.1 配色・余白・文字・枠線

背景・文字・hover・入力面は、既存の`--native-frame`、`--native-surface`、`--native-surface-soft`、`--native-surface-raised`、`--native-copy`、`--native-muted`を共通で利用する。dark / light / specialの3テーマを維持する。設定画面固有の緑・茶色・金色グラデーションは撤去する。

部品を囲むカードとボタンの枠線を繰り返さず、余白と面の明暗でまとまりを表す。入力欄は背景差で識別できるようにする。キーボードfocusの輪郭、エラー、必要な境界まで一律`border:0; outline:none`で消さない。外側の角丸ウィンドウや特別テーマの装飾を無断で作り直さない。

実装時の調整基準は、余白4 / 8 / 12 / 16 / 24px、本文14px、ナビ・操作ラベル13px前後、補助文字12px、見出し16〜18px、SVG16px、アイコン操作領域32px以上とする。既存の日本語sans-serifを継承し、設定だけ巨大なセリフ体にしない。数値は実画面で調整する初期値であり、新しい製品仕様の確定値ではない。画面全体の縮小や小さすぎる文字で解決せず、操作領域と読みやすさを維持する。

利用者提供の`Screenshot 2026-09-19 at 21.58.31.png`（Buzz）と`Screenshot 2026-09-19 at 21.59.12.png`（Codex）は、細い文字階層、小さなSVG、会話を優先する余白、控えめな区切りの比較資料として使う。画面構成や機能をそのまま複製しない。既存の外枠と3テーマを保ち、各画面の部品を共通tokenへ揃える。

### 7.2 左ナビ

順序はWorkspace名、検索欄、通知、Agent、Room一覧、下部のアカウント入口とする。通知とAgentは同じ行高・左揃えのナビ項目にする。検索は単なる横長ボタンにせず、入力した語を既存検索へ渡せる1つの検索欄とする。検索結果の既存絞り込みやRoomへの移動を維持し、2つの検索語入力を同時に要求しない。

Workspaceプルダウンの通常表示は名前と選択印だけ。未読は通知入口で扱う。接続失敗・再認可失敗は操作時に必要な場所で短く表示し、失敗を隠さない。同名Workspaceの判別方法は第11節に分離する。

Room行を右クリックすると、その行を対象に小さなメニューを出す。画面端では内側へ寄せ、選択・階層開閉を同時実行しない。項目を選んだときに名前入力や移動先選択などの小画面へ進む。常時Roomメニューへ大きな作成・移動フォームを並べない。キーボードからもContextMenuキーまたはShift+F10で同じ操作へ到達できるようにする。

右クリック項目の接続台帳を実装前に作り、作成・子Room作成・移動は既存処理を再利用する。名前変更は既存`room.patch`へのClient接続を確認する。ピン留め・アーカイブは第11節の未決定事項を解決してから実装対象を確定する。

### 7.3 参加者とヘッダー

参加者は人とAgentを同じグループで表示する。初期値は通常幅で4個、狭い幅で3個、残りは`+N`。アイコンは円形で少し重ねる。重なって識別しにくくならないよう背景色と同色の細い区切りを使う。取得中・失敗を0人と表示しない。

グループから1つの参加者一覧を開き、名前・人／Agentの区別・必要な権限を示す。追加・変更・解除は権限を持つ人だけが既存処理から実行する。人とAgentの別タブは作らない。表示名が取れない場合は取得失敗／未取得を示し、長いAccount IDで通常の名前欄を埋めない。画像がない場合は頭文字やSVGを用いる。

ヘッダーの操作は参加者グループ、3点のRoomメニュー、成果物パネル開閉の順を基本とし、別のhit area・名称・開閉状態を持たせる。3点とパネル開閉は文字記号や「パネル」ラベルのボタンではなく、統一したSVGで表す。

### 7.4 Roomメニューと成果物

3点ボタンから右パネルのRoomメニューを開く。Room名と閉じる操作を上部に置き、関連操作を短い行／ボタンとしてまとめる。`ROOM ADMINISTRATION`、巨大な「Room管理」、対象ServerやWorkspace versionの常時説明を置かない。参加者やAgentの管理はヘッダーの参加者一覧へ集約し、同じ一覧をメニュー内に複製しない。

共有は独立ボタンから既存の共有編集・管理へ進む。共有の対象・公開範囲・最終確認・停止は既存契約のまま維持する。Roomの会話全体を共有する新機能へ読み替えない。

右側の表示状態は閉じる／Roomメニュー／成果物のどれか1つ。成果物ボタンを押したら成果物を表示し、Roomメニューを最後に開いたという理由でRoomメニューを復元しない。成果物を表示中なら同ボタンで閉じる。3点ボタンでRoomメニューを開く場合は成果物を退ける。どちらも表示していない領域は、幅を取らず、Tab移動・アクセシビリティツリーの対象にも残さない。

会話やeditorの下書きを捨てるアンマウントだけで表示問題を回避しない。既存状態の保持と対象付きdraft guardを利用し、非表示パネルの描画・focusを確実に抑える。通常幅では会話の右、狭幅では既存Drawer方式に合わせる。

### 7.5 入力欄と担当Agent

入力ボックスと、その直下の小さな操作行を分ける。操作行の左に「Agentアイコン・名前・下向きSVG」を置く。将来のモデル・推論レベルはその右に置ける構造にするが、今回は仮のモデル名や動かないボタンを表示しない。

ヘッダーの既定Agent表示と重複する常時bannerを整理する。未設定時は同じ操作位置に短い案内と選択入口を出し、未設定・無効・権限不足・接続失敗を同一状態に潰さない。変更できない利用者にも担当と理由は読めるようにする。UIの簡素化のために送信条件を緩めない。

添付と送信は識別できるSVGとアクセシブル名を持たせる。送信のショートカットは既存動作を維持し、常時テキスト案内だけを除く。日本語変換の確定で誤送信しないことを実操作で確認する。

### 7.6 設定・Knowledge

全画面設定の入口とタイトルは「設定」。プロフィール、回答設定、外観、接続の機能は維持する。左カテゴリと右詳細の既存構造を、Roomメニューのタブ撤去と混同して削除しない。共通配色・余白・入力部品に揃え、不要な英語ラベルや実装説明を取り除く。端末保存／接続への反映など、利用者の判断に必要な説明は短く残す。

Knowledgeの将来の表示方式は全画面。今回、概要の件数・要約・日時などを決めたり、ダミーで載せたりしない。新しいKnowledge画面の内容や学習との統合内容は後続で決める。既存Knowledge・学習機能への到達性は保つ必要があるため、既存`NativeKnowledgeTools`を再利用する導線と画面切替の範囲をP0で確認する。空の新画面を作って「導線完成」としない。

## 8. 要件・既存仕様・工程の対応

| 今回 | 変更される既存の表示仕様 | 工程 | 主な完成証拠 |
| --- | --- | --- | --- |
| R1・R2 | UI-01、NAV-01の未読・固定入口表示、検索／通知2列 | P1・P2 | V1・V2・V5 |
| R3・R11 | UI-04、UI-05の独自配色・見出し、「本人設定」の表示名 | P1・P4 | V1・V2・V4・V5 |
| R4 | HDR-01、R-M01・R-G01の別タブ入口 | P3 | V2・V3・V5 |
| R5・R7 | UI-05の6タブ、成果物／Room設定切替、パネル復元方法 | P3 | V2・V4・V5 |
| R6・R10 | HDR-02、R-G02のヘッダー表示、送信の常時案内 | P4 | V2・V4・V5 |
| R8 | R-B01・R-B03の操作入口 | P0・P2 | V2・V3・V5 |
| R9 | UI-06、R-K01・R-K02・R-L01のRoom内タブ配置 | P0・P3 | 新画面の内容は対象外。既存機能への到達性だけをV4で確認 |
| R12 | プロジェクト外のスキル利用 | 本計画 | 第3.2節のURL。全体導入は実施しない |

既存のUI番号・操作IDは参照のために維持する。古い計画のSI-08／SI-09全体を、この改善の完了だけで完了扱いしない。

## 9. 実装工程

| 工程 | 目的・対象・具体的な作業 | セルフレビュー・完了／次工程の条件 |
| --- | --- | --- |
| P0 接続と未決定事項の確認 | 正本・第3.2節の主スキル・関係するメニュー実装例を読む。Room操作候補をCoreあり／Client接続あり／未対応へ分類。既存Knowledge導線を確認。第11節の製品判断を分離する | 未対応機能を実装済みと記載していない。未決定項目だけ保留し、独立した配色や表示修正は進められる |
| P1 共通の見た目 | app.css、NativeAccountSettings、NativeRoomAdministration、検索・通知・共有など対象面のstyleを棚卸し。theme token、文字、SVG、行高、hover／focus／disabled／loading／errorを揃える | 固定緑色と重複した装飾枠が残らず、3テーマで視認できる。Coreを触らない。V1の関係項目を実施しP2へ |
| P2 左ナビと右クリック | NativeApp、RoomNavigator、WorkspaceContextSearch、既存管理hook。Workspace簡素化、検索1欄、縦ナビ、対象Room付きcontext menu、小画面への既存操作接続 | 選択と右クリックを分離。別Roomへの誤更新なし。検索語・対象切替・長い名前・画面端を確認。採用項目のV2・V3後P3へ |
| P3 Roomメニュー・参加者 | NativeApp、RoomWorkSurface、NativeRoomAdministration、use-native-room-participants、共有の既存入口。タブ撤去と責務の移設、参加者グループと統合一覧、右パネル排他表示 | 参加者管理や共有の処理を失わない。非表示幅ゼロ・focus不可。draft維持。V2・V3・V4の該当項目後P4へ |
| P4 入力欄・設定 | RoomWorkSurface、NativeProfileMenu、NativeAccountSettings。Agent操作行、案内整理、設定名称・画面統一 | Agent変更の意味を維持。返信先・添付・未設定時の復旧・設定保存／取消を確認。V1・V2・V4後P5へ |
| P5 一連の確認 | 全変更をまとめて実画面・3テーマ・通常／狭幅で確認し、必要な実Server保存とAgent実行を確認する。再利用できる結果をreportsへ記録 | 第10節の証拠が揃い、今回の修正必須と完了に必要な未確認事項が解消。利用者の見た目確認と機能の検証結果を分けて記録する |

実装時は承認された範囲を続けて進め、工程ごとに続行承認を取り直さない。製品の意味を変える未決定事項と、実装上の通常判断を区別する。

## 10. レビューと検証

### 10.1 採用する検証

| ID | 検証・必要な理由 | 時期・方法 | 完了証拠と限界 |
| --- | --- | --- | --- |
| V1 | 文書・静的・型・build。部品移設とstyle整理の整合性 | 計画はリンク・用語・`git diff --check`。実装はまとめて`pnpm lint`、`pnpm --filter @samurai-agent/web typecheck`、`pnpm --filter @samurai-agent/web build` | 各コマンド結果。lintは既存source-quality検査であり、CSS描画の証拠にはしない |
| V2 | focused test。対象取り違え、状態遷移、操作接続の回帰 | P2〜P4の変更単位で下記の既存testを選び、`pnpm exec vitest run <対象ファイル>` | 権限・対象・draft・既存動作の意味のあるassertion。文字列置換やCSS値だけの新テストは増やさない |
| V3 | 実Serverを使う変更操作。見た目だけの成功を防ぐ | P2／P3の接続後、検証用Roomで採用した作成・移動・名前変更・人／Agent参加変更を行い、保存後再取得とreloadで確認 | 許可される操作の保存、権限外拒否、必要な版競合。Coreを変更した場合は変更責務の実DBテストを追加。mockで代替しない |
| V4 | 実Clientの状態保持。パネルと設定の切替で入力が消えないこと | P3〜P5。会話入力・添付・返信対象・成果物未保存編集を用意し、メニュー／成果物／設定／テーマを切替。既存Knowledge導線も確認 | 中身と対象が維持される実操作証拠。1本の実Agent依頼で実行中切替と返答を確認し、テーマごとに依頼を繰り返さない |
| V5 | 視覚・キーボード。今回の中心となる改善の確認 | P5。dark / light / special、通常幅と980〜1024pxのDesktop、390pxのBrowser renderer。右クリック、Tab、矢印、Enter、Esc、IMEを操作 | 画面比較、はみ出しなし、長い名前・空・失敗・上限超過、focus復帰、非表示面に移れないこと。静的markupでは代替しない |

関連testは以下。実装で触れた責務に限定して実行する。

- `apps/web/src/components/RoomNavigator.test.tsx`、`RoomNavigator.focused.test.ts`
- `apps/web/src/native-app/NativeApp.test.ts`、`RoomWorkSurface.test.ts`
- `apps/web/src/native-app/NativeRoomAdministration.test.ts`、`native-room-administration.test.ts`
- `apps/web/src/native-app/NativeAccountSettings.test.tsx`、`NativeProfileMenu.test.ts`
- `apps/web/src/native-app/WorkspaceContextSearch.test.tsx`、`WorkspaceNotificationCenter.test.tsx`
- `apps/web/src/native-app/use-native-app.test.ts`、`use-native-draft-navigation.test.ts`
- `apps/web/src/lib/native-app-theme-preferences.test.ts`

新しい右クリックの対象解決や参加者の表示名解決は、その責務の近くに必要なtestを追加する。既存のNode環境のtestを実クリックの成功証拠にしない。macOS Electronの主ウィンドウは現行`minWidth:980`なので、390pxの結果はBrowser rendererの証拠として分ける。Windows／Linux実GUI、配布、他Backendの総当たりは今回追加しない。

### 10.2 操作・見た目のチェックリスト

- Workspace一覧は名前中心で、未読・固定入口が戻っていない。名前を省略しても完全な名称を確認できる。
- 検索欄は1つ、通知とAgentは縦配置。検索・通知の既存機能は動く。
- 全テーマで設定・メニューに旧緑色や暖色背景が残らない。通常文字のコントラストは4.5:1以上を確認する。
- Room行右クリックで開いた対象と、実行先が一致する。キーボードでも開閉・項目選択できる。
- 参加者0／1／3／4／5人以上、長い名前、画像なし、取得失敗を扱える。人とAgentの実人数を使う。
- Roomメニューにタブがなく、成果物と同時表示されない。共有ボタンが既存の共有へつながる。
- 3点ボタンと成果物SVGボタンは独立し、閉じると元の入口へfocusが戻る。
- 入力欄下の担当Agentを変更しても、進行中Workと返信先は変わらない。ショートカット案内は常時表示されない。
- 設定の名称・配色が揃い、保存／取消／復帰が動く。テーマ切替で未送信入力を失わない。
- Knowledge概要・新画面の中身・モデル／推論の仮ボタンを作っていない。

UIの検証は一度最後まで進め、非ブロッキングの問題はまとめて修正する。指摘は修正必須／追加調査／任意改善／対象外に分ける。修正必須には要件、発生条件、source上の原因、影響を付ける。新しい差分や失敗がない限り検証を繰り返さない。

## 11. 完了条件・未決定・未検証

### 今回の計画作成の完了条件

最新合意R1〜R12が記載され、参照URL、対象・対象外、既存機能との接続、未決定事項、実装時の検証方法が追えること。計画の保存はUI実装の完了を意味しない。

### 実装前に意味を確定する事項

| 事項 | 分かっていること | 残る判断 |
| --- | --- | --- |
| 右クリックの全項目 | 小さなメニューと作成・移動の入口は確定。名前変更・ピン留め・アーカイブが操作例に挙がった | 実際に含める項目。特にピン留めの端末／Account保存範囲、アーカイブの非表示・復元・実行中Workの扱い。未確認のCore機能をUIだけで模倣しない |
| 同名Workspace | 利用者回答済み。同名のまま名前だけ表示。識別は接続先との組で維持 | 追加の判別機能は後続 |
| 既存Knowledgeへの暫定導線 | 利用者回答済み。Roomメニューのボタンから既存Knowledge・学習画面を中央に開く | 新内容・概要・学習の再設計は後続 |

これらをAIの提案で確定したことにせず、依存する箇所だけを分ける。アイコン数は合意範囲内の通常4・狭幅3を初期値とし、改めて大きな仕様判断を増やさない。

### 実装の完了条件

採用した操作を含めR1〜R11の対象内変更が動き、V1〜V5の必要な確認が成功し、既存の会話・入力・成果物編集・認可を壊していないこと。利用者の見た目確認が未実施なら、その事実を残し、技術検証の成功と混同しない。後続と明記したKnowledgeの内容やモデル選択を、今回の完了条件へ戻さない。

現在未検証: 改善後の実画面、Browser／Electron操作、実Server保存、実Agent実行、3テーマ・狭幅の表示。計画段階なので実施していない。
