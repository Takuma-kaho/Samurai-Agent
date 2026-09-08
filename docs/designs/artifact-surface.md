# Artifact・Surface設計

- 状態: 製品範囲は2026-09-07の会話で合意済み。2026-09-08に未接続API・承認・データ操作の要件を補強。以下は実装前の詳細設計案であり、実装・実機検証の完了を示さない
- 対象: Roomの成果物の表示・修正・保存、文章と表データの直接編集、必要時に開く操作画面
- 正本: [PRODUCT.md](../../PRODUCT.md)、[ARCHITECTURE.md](../../ARCHITECTURE.md)
- 関連: [Native App](native-app.md)、[RoomとAgentの共同作業](room-agent-work.md)、[Agent Backend](agent-backends.md)
- 実装計画: [Phase 5残作業・7](../../plans/native-artifact-surface-plan-phase5-7.md)

## 1. 目的と合意済みの範囲

RoomでAgentへ依頼すると、成果物や、その仕事に必要な画面を開ける。人は内容を確認し、文章や表のデータを直接直すか、対象を指定してAgentへ修正を依頼できる。フォームや表から保存した内容は、同じRoomの次の仕事で参照できる。

| 対象 | 今回の体験 |
| --- | --- |
| 文書 | 文章の表示・直接編集・保存、Agentへの修正依頼 |
| 表 | 表示、セルのデータ編集・保存、Agentへの修正依頼 |
| 画像・PDF | 表示、ファイル保存、Agentへの修正依頼。人による直接編集は含めない |
| HTML・Surface | 表示、絞り込み、フォーム入力、データ保存、Agentによる画面の生成・修正 |
| 共通 | Chatから開く、保存済みの結果を再び開く、変更と出所を確認する |

Word・Excel互換編集、画像・PDFの手動編集、汎用の画面レイアウト編集は今回の必須機能にしない。HTML・Surfaceの入力欄を操作することと、HTML/CSS/JavaScriptを編集することは区別する。今回は文章・表データの直接編集と、画面が提供する入力操作を基本とする。

MulmoClaudeの必要時に開くGUI、Codexの箇所を指定する修正依頼、OpenClawの操作できる生成画面、Buzzの共有文書編集を体験の参考にする。SamuraiのWorkspace所有、Room認可、交換可能なBackend、共通Domain APIは維持する。

## 2. 責務とデータ

### 2.1 ArtifactとSurface

- Artifactは保存した成果物。文書、表、画像、PDF等の内容と出所を持つ。
- Surfaceは情報の表示・操作方法。既存ArtifactやCollectionを表示する組込み画面と、生成したHTML画面を扱う。
- Generated Surfaceは既存のDefinition、Revision、bundleを再利用する。HTMLを表示するためだけに同じ内容のArtifactをもう一つ正本として作らない。
- 表Artifactは、その時点の表を保存した成果物。Collectionを表示する表は、継続管理するレコードの操作画面。画面からの保存先をServer側で固定し、両方へ暗黙に二重保存しない。
- 入力中の文字、選択中の行、表示フィルターはClientの表示状態。保存した文書・表・フォーム送信結果はWorkspace Coreのデータであり、iframeやlocalStorageだけに置かない。
- Collectionの基本の表・フォームは型、必須値、参照、版を検証して既存レコードを操作する。旧Vueにあったgallery/calendar/kanban専用画面の一括再現は必須にせず、保存済みデータを汎用の一覧/表から扱えるようにする。

### 2.2 保存と識別

PostgreSQLはID、Room所属、版、権限、Activity、Eventを管理し、本文・画像・PDF・HTML bundleはconfigured storage rootに保存する。既存のWorkspace recordとFile Transactionを使い、別のデータベースやAgent専用の正本を新設しない。

Client上の参照は、Server connection、workspace ID、room ID、resource kind、resource ID、必要なrevision IDを伴う。resource IDだけ、ファイルパスだけ、Session IDだけで開かない。Room Workとの関連と、生成・修正した担当・Run・Operationを保存する。Sessionは内部の出所・継続参照としてのみ使う。

Artifactの変更は既存のimmutable revisionを利用する。表示中の版と現在版を区別し、現在版へ保存するときは読んだ版を必ず送る。初期Artifactにrevisionがない場合も、元の内容を履歴として保持してから初回編集を行う。空の文書や全セルを消した表も、正しい編集結果として保存可能にする。

過去版を戻す場合は、過去の履歴を消さず、その内容から新しい現在版を作る。Generated Surfaceのコードの版と、その画面が操作するCollectionレコードの版は独立して管理する。

## 3. Native Appでの体験

### 3.1 開く・再び開く

1. Room Workの結果に成果物カードを表示する。タイトル、種類、作成・更新状態を示す。
2. カードを開くと、Chatの横のパネルに内容を表示する。狭い画面では同じ内容を広い専用表示に切り替え、Chatへ戻れるようにする。
3. Agentが新しい画面を提示したときは開けるが、人が別の成果物を編集している場合は表示を奪わず、結果カードから開ける状態にする。
4. パネルを閉じても成果物は消えない。Roomの成果物一覧と元の仕事から再度開く。
5. Generated Surfaceは既存のpin/unpin/archiveを利用する。pinは再び開きやすくする操作であり、保存・公開範囲を切り替える操作にはしない。

パネルには、種類に応じた操作だけを表示する。文章・表では「編集」「保存」「キャンセル」、共通で「Agentに修正を依頼」「ダウンロード」「履歴」を用意する。画像・PDFに手動編集ボタンを出さない。Surfaceでは宣言された操作と入力欄を表示する。

### 3.2 人による直接編集

- 文書はMarkdownを基本とする。段落、見出し、箇条書き、リンク、簡単な表を読める表示と本文編集を用意する。Wordの組版や互換性は完成条件に含めない。
- 表は既存の構造化データに基づくセル編集を使う。文字列、数値、真偽値、空値を保持する。行の追加・削除は保存先のschemaと許可された操作に従う。Excelの数式エンジンやマクロは導入しない。
- 保存ボタンで確定し、入力中の下書きとServerに保存された内容を区別する。IME入力中に再取得した本文を重ねない。
- 保存失敗・競合では下書きを残す。「最新の内容を読み直す」と自分の内容の確認を可能にし、自動で他の人やAgentの変更を上書きしない。
- Room切替や画面を閉じる操作で未保存内容が失われる場合は、保存・破棄・そのまま戻る導線を用意する。権限失効後の下書きは共有領域や永続キャッシュへ再保存しない。

### 3.3 Agentへの修正依頼

修正依頼には、対象resource、表示中の版、依頼文、必要なら選択した文章または行・列の参照を付ける。文書の選択範囲と表のセル指定を基本とし、画像・PDFでは対象ファイルと説明を渡す。全形式への描画式注釈ツールは必須にしない。

元の仕事への追加指示には既存のRoom Work制御権限を適用する。制御権限のないRoomメンバーでも新しい仕事を依頼できる場合は、許可された成果物を参照した別の依頼として扱い、既存仕事の制御を迂回しない。

AgentにはServerが再認可した対象と現在の版を渡す。モデルが書いたresource ID、path、room IDだけを信頼しない。画像・PDFは実際のBackendの生成・変換能力で処理し、未対応や失敗を明示する。文章の返答だけをファイル修正成功にしない。

指定した版が現在版と異なる場合は、選択箇所を黙って最新内容へ当て直さず、対象と新旧版を示して再確認する。表は列ID/row IDで対象を保持し、表示順が変わった後に行番号だけで修正しない。

### 3.4 表示と操作の実装範囲

表示、直接編集、Agentによる生成/修正は別の能力として扱う。画像/PDFを表示できることは、接続Backendが生成・修正できる証拠にはならない。実装済みのcapabilityとServerの結果を使って状態を表示する。

Markdownは読みやすい本文として、表は型付きの値として表示する。chartは認可された実データの値・軸・単位を描画し、絞り込み後も元データと一致する。タイトル・JSON・参照IDだけをグラフとして表示しない。全種類のchart editorやOffice互換機能は設けない。

必須の文書/表の保存とフォーム入力は実際のDomain操作まで接続する。未接続の操作ボタンを出して、対応不能表示だけで実装完了にしない。任意のBackend機能や破損したファイルの非対応とは区別する。

## 4. Surfaceの入力と保存

~~~mermaid
sequenceDiagram
  participant U as 利用者
  participant C as React Client
  participant F as 隔離されたSurface
  participant D as Domain API
  participant W as Workspace Core
  U->>F: 入力して保存
  F->>C: 宣言済み操作と入力値
  C->>D: 対象の版と同一操作IDで要求
  D->>W: Room認可と入力検証の後に変更
  W-->>D: 保存結果とEvent
  D-->>C: 結果を返す
  C-->>F: 保存結果と最新データを反映
~~~

組込みのform/tableはReactの入力部品で表示し、生成HTMLは隔離されたiframe内で表示する。どちらも同じDomain Operationへ接続する。

1. ServerはSurfaceの宣言済みactionと対象データのschemaを照合する。
2. 親Clientは自分が開いたframeからのメッセージだけ受け付ける。frameの世代、Surface、版、action ID、入力の型とサイズを検査する。
3. Clientはconnection/workspace/Roomを表示時の対象へ固定して要求する。生成HTMLへ認証情報、Desktop bridge、任意URLの呼出し口を渡さない。
4. Serverは現在のMembership、Roomの閲覧・編集・実行権限、Surfaceの状態と版、対象resourceの所属を検査する。
5. actionで固定した対象と利用者が入力できるfieldを分ける。入力値でRoom、対象ID、command ID、承認状態を差し替えさせない。
6. 編集は文書Artifactのrevision、表Artifactのrevision、Collectionのrecord/patch、または宣言したフォーム送信結果として保存する。再実行時も同じ保存先を使う。
7. 二重クリック・通信再送には同じOperation IDを使い、保存結果を再取得する。保存済みで応答だけ失われた場合は、新しいIDで繰り返さない。
8. 成功後はServerの保存結果で画面を更新する。画面の再表示・再起動後も保存済みのデータを読み直せる。

表示の絞り込みやタブ切替は、データ更新やAgent実行を必要としない。保存やAgentへの依頼は、それぞれ宣言された操作として実行する。既存のApproval Lifecycleで必要な承認は親Clientが扱い、iframeの自己申告だけで完了させない。

承認は[Native Appの確認待ち](native-app.md#413-仕事の確認待ちと証拠)を共用する。Coreが保持する要求ID・操作・対象版・期限に結び付けて、人が許可または拒否した結果を保存する。応答後も現在の権限を検査し、許可の受付と保存/実行の完了を分ける。Surfaceの更新・archive・停止・期限切れ後に古い承認を別actionへ転用しない。親画面のbuttonや`confirmed: true`は永続した承認の代わりにならない。

レコードの更新では、入力可能fieldと固定fieldを分け、数値・真偽値・空値・参照IDを型付きで扱う。生成画面の更新後も保存先とレコードIDを保ち、schema不整合時には入力を破棄せず再確認へ戻す。フィルター等の表示状態を保持する場合も本文や権限を一緒にlocal保存しない。

## 5. 表示・実行の境界

- MarkdownはHTMLを無条件に実行せず、安全に描画する。画像やリンクも現在のRoomで認可済みの参照を解決する。
- 生成HTMLはsandboxを保ち、親と同じorigin、Node、Electron API、親DOM、credential、任意のネットワークやファイル書込みを与えない。
- 既存の`network_access: none`と`workspace_write: domain_commands_only`を維持する。必要なデータと画像等は、親Clientが認可済みのQuery・File APIから取得して渡す。
- HTML文字列の検査だけに依存せず、iframeのsandbox、CSP、message検査、Server認可を組み合わせる。
- フォーム入力の完成に`form`要素の無条件解禁は不要である。既存検証と整合する入力部品とaction bridgeを用い、通常のフォーム送信や外部送信を許可しない。
- PDF・画像のプレビューはバイナリのMIME・encoding・実byteを検証する。base64の文字列をそのままPDF本文として返さない。SVG等の実行可能な内容も親画面へ直接挿入しない。
- 出力のダウンロードは、認可済みの内容を指定形式で保存する。HTMLの書出しにcredentialや有効な操作権限を埋め込まない。App外でWorkspaceへの保存操作がそのまま動くとは扱わない。

## 6. Event・再接続・移植

表示更新には永続的なPublic Eventと再照会を使う。文書やSurfaceの版が変わった場合は、そのIDと版から最新状態を取得する。Event payloadに本文やsecretを複製しない。作成・修正・入力保存のActivityを実行主体と関連付け、Phase 8で使える証拠を残すが、自動学習の新設は行わない。

別Roomへの遅延応答は破棄し、同じworkspace IDを持つ別Serverの結果を混ぜない。認可が失われた場合は、表示、操作口、Object URL等を解放する。切断後は公開Event履歴とQueryで復元し、通知だけを正本にしない。

Workspace Export/RestoreではArtifactの全revisionとblob、Generated SurfaceのDefinition・全revision・asset、保存先のCollection等、Activity・Event・出所参照を保持する。接続先URLは復元先から解決し、元Serverのpreview URLや一時認証URLに依存しない。

## 7. 失敗時と検証

| 条件 | 必要な挙動・証拠 |
| --- | --- |
| 同じ文書を人とAgentが編集 | 古い版の保存を拒否し、先行更新と下書きを失わない |
| 未保存のまま画面を変更 | 保存・破棄の意思を確認でき、別成果物へ入力を混ぜない |
| 古いSurfaceから操作 | 現在版でない操作を拒否し、再表示へ案内する |
| Surface更新後に承認する | 旧要求の対象・版・期限を検査し、新しいactionへ承認を流用しない |
| 古い版/並べ替え後の箇所をAgentへ指定 | 版と資源/行/列を照合し、別の内容へ黙って適用しない |
| 入力部品はあるが保存経路がない | 必須操作のDomain接続を完成させ、拒否する旧APIを実装済みと扱わない |
| グラフを絞り込む | 実データの値・単位と描画結果を照合し、参照情報だけの表示にしない |
| 他Room・DM・別Serverの参照 | 閲覧・書込み・出力を拒否し、本文も返さない |
| 確定保存後に通信切断 | 同じ操作の結果を復元し、二重保存しない |
| bundleの表示失敗 | エラーを示し、組込み画面・成果物・文章のfallbackを使う |
| Agentの修正失敗 | 元の成果物を保持し、修正済みと表示しない |
| ファイル保存途中の停止 | 既存File Transactionの復旧を通し、未確定版を完成扱いしない |
| 再起動・移転 | DB、実ファイル、版、入力済みデータ、出所を照合できる |

詳細な検証範囲・command・完了ゲートは実装計画で管理する。今回の文書作成ではコードの読み取りのみを行い、実Agent、実DB、実Clientは未検証である。

## 8. 実装時に選定する事項

Markdown表示部品、PDF viewer、チャート表示部品は既存依存・必要機能・保守性から選ぶ。ライブラリ名や新しい製品要件を本書だけで確定しない。現在のReact Appへ接続し、Vue画面の状態管理やSession必須APIをそのまま移植しない。

表のwire schema、公開Query/Eventの追加名、コード配置の細分化は既存契約から具体化する技術事項である。製品範囲を変更する必要が判明した場合は、その変更だけ利用者と相談する。
