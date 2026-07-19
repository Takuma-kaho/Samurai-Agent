# Samurai Agent Core 追加スコープ実装計画

作成日: 2026-07-13

状態: 実装前

## 作業開始前の必読

**実装へ着手する前に、必ず[`core-reference-integration-plan.md`](./core-reference-integration-plan.md)を最初から最後まで読むこと。**

- 台帳にある90項目、Core追加候補39件、接続契約4件、製品後続5件、対象外42件の関係を把握してから実装する。
- 台帳の`Core追加候補`をすべて未実装と決めつけず、現行コードと既存証拠を確認する。
- 台帳と本計画に矛盾が見つかった場合は、勝手に解釈して実装せず、正本ドキュメントへ戻って原因を整理する。

## 0. この文書の位置づけ

この文書は、既存の[`core-completion-plan.md`](./core-completion-plan.md)を実装した後に見つかった追加スコープを、Coreへ統合するための実装計画である。

正本の優先順位は変えない。

1. [`PRINCIPLES.md`](../PRINCIPLES.md)
2. [`ARCHITECTURE.md`](../ARCHITECTURE.md)
3. [`PUBLIC_NAMING.md`](../PUBLIC_NAMING.md)
4. [`WEB_UI_DESIGN.md`](../WEB_UI_DESIGN.md)
5. [`core-completion-plan.md`](./core-completion-plan.md)と既存実装
6. 本計画

[`core-reference-integration-plan.md`](./core-reference-integration-plan.md)は、参照OSS比較から見つかった追加スコープの台帳として使う。本計画は、その台帳からCoreに必要な項目だけを依存順へ並べ直した実行用文書である。

```text
既存Core完成計画と実装
  ↓
追加スコープ台帳
  ↓
本計画でCore追加分だけを実装
  ↓
製品UI・Installer・Auto Updateは後続トラック
```

## 1. 先に結論

今回のCore追加は、次の5段階で行う。

1. 既存Coreの回帰基準と追加ギャップを固定する。
2. Codex／Claude Codeへ任せる機能のCapability契約を作る。
3. Browserの「ページ取得」と「実画面操作」を分離する。
4. WYSIWYG、Image、Mind mapに必要なCore契約を追加する。
5. 既存機能を含む必須gateをすべて再実行する。

独自の検索エンジン、Browser engine、Subagent schedulerは作らない。ただし、Backend側の機能がSamuraiから本当に使えるかを検出し、使えない時に理由を説明する責務はCoreへ追加する。

完成判定は、後述する**50問 × 2点 = 100点**の軽量確認テストで行う。100/100に加え、拒否条件への違反が0件であることを必須とする。

## 2. 2026-07-13時点の調査結果

### 2.1 公式資料から確認できたこと

| 機能 | Codex | Claude Code | Core判断 |
| --- | --- | --- | --- |
| Web検索 | CLIはWeb searchを持ち、`codex exec --json`へ検索eventを出せる。`cached`、`indexed`、`live`、`disabled`を設定できる | `WebSearch`と`WebFetch`をbuilt-in toolとして持つ | 独自検索エンジンは不要。接続・mode・source eventの正規化は必要 |
| Subagent | CLIのmulti-agent機能とSubagent threadを持つ | `Agent` toolとcustom subagentを持つ | 独自schedulerは不要。利用可否、親runとの関連、失敗eventは必要 |
| Browser読取 | Web searchとMCPを利用できる | `WebFetch`とMCPを利用できる | Backend／MCPへ委譲する |
| Browser実操作 | Browser Use系機能はあるが、`codex exec`で常に利用できるとは公式資料だけでは断定できない | Chrome連携はあるが、非対話`claude -p`での利用は環境・認証・接続状態に依存する | Backend名だけで利用可能と判定しない。実probeまたはMCP browser adapterを必須にする |
| MCP | CLI設定からMCP serverを利用できる | `--mcp-config`とAgent SDKからMCP serverを利用できる | Samurai tool bridgeの既存方針を継続する |

主な公式参照元。

- [OpenAI Codex Web search](https://learn.chatgpt.com/docs/web-search)
- [OpenAI Codex Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Claude Code Tools reference](https://code.claude.com/docs/en/tools-reference)
- [Claude Code non-interactive mode](https://code.claude.com/docs/en/headless)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Chrome integration](https://code.claude.com/docs/en/chrome)
- [MulmoClaude公式リポジトリ](https://github.com/receptron/mulmoclaude)

MulmoClaudeは、Claude Codeの実行能力とMCP／PluginをHostから利用し、結果をCanvasやWorkspaceへ戻している。Samuraiでも「Backendの能力はBackendへ任せ、Hostは接続とWorkspaceへの回収を担当する」という部分を参照する。

### 2.2 実装時に必ず確認する参照OSS

各Phaseの着手時にREADMEだけでなく、関連する実装コードとテストを確認する。

| 参照OSS | GitHub | 主に確認する領域 |
| --- | --- | --- |
| Hermes Agent | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | Memory、Skill、Background Review、Curator、Automation |
| OpenClaw | [openclaw/openclaw](https://github.com/openclaw/openclaw) | Gateway、Session、Pairing、Allowlist、外部境界、Diagnostics |
| MulmoClaude | [receptron/mulmoclaude](https://github.com/receptron/mulmoclaude) | Host、Artifact、Canvas、Renderer、Plugin、Claude Code接続 |

実装記録には、最低限次を残す。

- 参照したrepositoryとcommit SHA。
- 参照したfile pathとtest path。
- 採用した仕組み。
- Samurai向けに変更した理由。
- 採用しなかった部分と理由。

### 2.3 現在のSamurai実装から確認できたこと

- `CodexBackend`は`codex exec --json`、`ClaudeCodeBackend`は外部CLIとして起動できる。
- 両Backendへrun単位のSamurai MCP tool bridgeを注入できる。
- Backend statusの`supports`は、現在はsession、resume、cancel、streamなどrun lifecycle中心である。Web検索、Browser、Subagentの利用可否は表現できない。
- 現在の`browser.screenshot`は、実画像ではなくHTML snapshot fallbackを保存する場合がある。この状態を本物のscreenshot成功として扱ってはいけない。
- 現在のCore completion reportは、実装欠損だけでなくsource hashの古さでも失敗する。追加実装前にevidenceを現行HEADへ合わせて再生成する必要がある。

### 2.4 ローカルCLIで確認できたこと

| 対象 | 確認結果 | 計画への反映 |
| --- | --- | --- |
| Codex CLI | `0.142.5`。`--search`、MCP、multi-agent、Browser Use系featureは存在する | 現在の既定modelとのversion不一致で実runは失敗した。CLI version／model互換性をCapability診断へ含める |
| Claude Code | `2.1.158`。非対話初期化eventに`WebSearch`、`WebFetch`、`Task`が出た | 認証されておらず検索実行は未完了。tool露出と実行可能を分けて判定する |

結論として、**機能名がCLIに存在することと、Samuraiから実際に使えることは別**である。

## 3. Coreと製品UIの境界

### 3.1 今回Coreへ含めるもの

- Backend Capabilityの宣言、検出、診断、event正規化。
- Web検索のBackend委譲とsource記録。
- Browser read／interact／screenshotの能力分離とadapter境界。
- Backend内部Subagentの利用可否と親runへの関連付け。
- Artifactの編集command、revision、復元、provenance。
- Image生成・編集結果をArtifact revisionへ戻す共通経路。
- graph形式のnode／edge schema、renderer、編集command、再読込。
- Wiki、Skill、Automationなどの既存Core操作をSurfaceとChatから同じDomain Commandへ流す契約。
- 既存Core全体を壊していないことを示す回帰gate。

### 3.2 Coreには契約だけを入れ、製品UIへ回すもの

| 項目 | 今回Coreへ入れるもの | 後続の製品UIへ回すもの |
| --- | --- | --- |
| WYSIWYG | document patch、revision、競合検出、復元、renderer contract | 高機能toolbar、ページレイアウト、共同編集、細かな装飾UX |
| Image編集 | source asset、生成／編集request、provider結果、provenance、revision、rollback | brush、crop、mask、layerなどの専用画像Editor |
| Mind map | 汎用graph schema、node／edge command、renderer、reload | 高度な自動配置、テーマ編集、プレゼン演出 |
| 管理Surface | Wiki／Skill／Automationのread modelとDomain Command接続、最小reference surface | 完成した専用管理画面の磨き込み |

### 3.3 今回やらないもの

- Installer。
- Onboarding。
- Auto Update。
- 配布署名、公証、release channel管理。
- Desktop Shellの製品的な磨き込み。
- 独自Web検索provider pool。
- 独自Browser engine。
- 独自Subagent scheduler。
- 3D、Voice、Mobile node、全Messaging対応。

## 4. 実装の不変条件

- Workspaceを状態の正本にする。
- Backend固有状態をWorkspaceの正本にしない。
- UI操作とAgent操作は同じDomain Commandへ入れる。
- Backend Capabilityが不明な時は`available`扱いにしない。
- HTML取得、検索、実Browser操作を同じ成功として扱わない。
- Backend toolの結果は、正規化event、source、ArtifactまたはWorkspace changeとして残す。
- 外部検索結果やWeb内容をHost命令として扱わない。
- 既存Coreの3点項目も回帰gateから除外しない。
- 公開面に参照元固有名を出さない。

### 4.1 拒否条件

次のいずれかに該当する実装は、テストが動いて見えても不合格とする。

- エラーを隠すためだけの一時的な追加実装。
- 根本原因を直さず、別経路で成功したように見せるfallback。
- `catch`して成功値、空データ、仮Artifactを返すfake success。
- Runtime、Domain Command、Workspace正本を迂回する直接保存。
- 失敗テストの削除、skip、期待値の弱体化、過剰なtimeout延長。
- Backend Capabilityが未確認なのに`available`として扱う処理。
- HTML snapshotを実screenshotとして扱う処理。
- 参照OSSを確認せず、名前や見た目だけを模倣する実装。
- 目的外の大規模refactorや、新しい安全frameworkの追加。

エラーが出た場合は、次の順で対応する。

1. 再現条件と根本原因を特定する。
2. 正本ドキュメントと責務境界を確認する。
3. 関連する参照OSSの実装とテストを確認する。
4. 恒久対応を最小範囲で実装する。
5. 暫定対応しかできない場合は実装を止め、理由と恒久対応案を先に報告する。

## 5. Phase 0: 既存Core baselineと追加ギャップを固定する

### 5.1 目的

既存Coreを作り直さず、何が実装済みで何が追加作業かを現行HEADで確定する。

### 5.2 作業

1. `reports/core-completion/`のevidence freshnessを確認し、今回影響する主要機能の軽量証拠だけを現行HEADで再生成する。
2. source hash不一致と実装失敗を分けて報告する。
3. 台帳のCore追加候補39件を、次の3状態へ変換する。
   - `verified_existing`: 既存実装と自動証拠がある。
   - `implementation_gap`: 実装が足りない。
   - `evidence_gap`: 実装はあるが証拠が足りない。
4. 追加Core用reportを`reports/core-additional-scope/`へ分離する。
5. 既存scorecardを書き換えて過去の完成条件を曖昧にせず、追加検証から既存主要機能の軽量回帰fixtureを呼ぶ。

### 5.3 変更候補

- `plans/core-reference-integration-plan.md`
- `plans/core-completion-scorecard.json`
- `scripts/verify-core-completion.mjs`
- `reports/core-completion/`
- 新規`reports/core-additional-scope/`

### 5.4 完了条件

- 39件のCore追加候補が3状態のいずれかへ分類される。
- stale evidenceだけを理由に再実装する項目が0件である。
- 追加実装前のCore baseline reportを現行HEADから再生成できる。

## 6. Phase 1: Backend Capability契約を追加する

### 6.1 目的

「Codexだから使える」「Claude Codeだから使える」という推測をやめ、実際の起動方式・設定・認証で使える能力をHostが判断できるようにする。

### 6.2 追加する契約

```text
BackendCapabilityId
  web_search
  web_fetch
  browser_read
  browser_interact
  browser_screenshot
  subagent_delegate
  mcp_tools

BackendCapabilityState
  available
  unavailable
  misconfigured
  unverified
```

Capability statusには最低限、次を持たせる。

- `backend_id`
- `capability_id`
- `state`
- `source`: `backend_native | mcp_adapter | samurai_adapter`
- `mode`: 検索の`cached | indexed | live`など
- `reason`
- `checked_at`
- `probe_version`
- secretを含まないevidence summary

### 6.3 実装方針

- 既存`AgentBackendStatus.supports`のrun lifecycle情報は残し、task capabilityを別フィールドへ追加する。
- 静的検出は、CLI version、起動引数、設定、tool一覧を確認する。
- 動的probeは明示的なdiagnostics実行で行い、毎回のChat起動時に外部通信しない。
- Codexは`web_search` modeを設定できるようにし、検索eventとsourceを正規化する。
- Claude Codeは非対話modeの既定引数を正規化し、`WebSearch`、`WebFetch`、`Agent`のtool露出と実行可能を分けて記録する。
- 認証切れ、CLI version不一致、tool denied、network denied、MCP接続失敗を別のreason codeにする。
- Backend内部SubagentはBackendの責務とし、Samuraiは親run id、子作業summary、最終結果、失敗だけを記録する。

### 6.4 変更候補

- `packages/core-schemas/src/`
- `packages/agent-backends/src/index.ts`
- `packages/agent-backends/src/agent-backends.test.ts`
- `packages/runtime/src/agent-runtime.ts`
- `packages/runtime/src/backend/event-bridge.ts`
- `apps/server/src/api-server.ts`
- `scripts/doctor.mjs`
- 新規`scripts/verify-backend-delegated-capabilities.mjs`

### 6.5 完了条件

- Web／Gateway／Automationのどこから見ても同じBackend Capability statusになる。
- Codex／Claude Codeのtool名だけで`available`にしない。
- capabilityが使えない時、利用者に「原因」「影響」「設定または次の選択肢」を説明できる。
- Web検索とSubagentのSamurai独自Runtimeが追加されていない。

## 7. Phase 2: Browser境界を正規化する

### 7.1 目的

現在のHTML取得fallbackを、本物のBrowser操作やscreenshot成功と誤認しない構造へ直す。

### 7.2 能力を分ける

| Capability | 意味 | 許可する実装元 |
| --- | --- | --- |
| `web_fetch` | URLから本文を取得する | Backend native、Samurai read adapter |
| `browser_read` | browser contextからDOM／textを読む | Backend native、MCP browser adapter |
| `browser_interact` | click、input、navigationを行う | Backend native、MCP browser adapter |
| `browser_screenshot` | 実際のviewport画像を取得する | screenshot対応adapterだけ |
| `html_snapshot` | HTML／textをWorkspaceへ保存するfallback | Samurai read adapter |

### 7.3 実装方針

- `browser.screenshot`からHTML fallbackを外す。実画像が取れない場合は`unsupported`または`html_snapshot`へ明示的にfallbackする。
- Browser adapterの入力と出力を共通化し、BackendまたはMCPごとの差をadapter内へ閉じる。
- Browser操作のtool event、URLのredaction、取得Artifact、失敗reasonをrunへ関連付ける。
- Browser adapterがない環境では、Coreを壊さず`browser_interact unavailable`を返す。
- Browser結果を直接Memoryへ保存せず、参照元付きArtifactまたは一時contextとして扱う。

### 7.4 変更候補

- `packages/capability-registry/src/index.ts`
- `packages/runtime/src/agent-runtime.ts`
- `packages/runtime/src/backend/event-bridge.ts`
- `apps/server/src/api-server.ts`
- 新規または既存のBrowser adapter package
- 新規`scripts/verify-browser-capability-boundary.mjs`

### 7.5 完了条件

- HTML snapshotをPNG screenshotとして返す経路が0件である。
- adapterあり／なし／認証切れ／network拒否をfixtureで再現できる。
- 最低1つの実Browser adapterでnavigate、click、input、screenshotを確認できる。
- adapterがない環境でもWeb検索とHTML取得は別Capabilityとして利用できる。

## 8. Phase 3: 編集可能なGenerative UIのCore契約を追加する

### 8.1 WYSIWYGのCore部分

Coreでは、特定Editorライブラリではなく次を完成させる。

- document Artifactの編集command。
- `base_revision_id`による競合検出。
- GUI編集とChat編集で共通のrevision作成。
- source run、editor source、before／after、変更summaryの記録。
- revisionのrestore。
- reload後の同一内容復元。

### 8.2 Image生成・編集のCore部分

- 画像provider、Backend tool、MCPのいずれから返っても同じArtifactへ保存する。
- original assetを保持し、編集結果を新revisionにする。
- prompt、source asset、provider、source run、mime type、dimensions、hashをprovenanceへ残す。
- providerがない時にfake成功を返さない。
- 画像生成と画像編集を別operationとして記録する。

### 8.3 Mind mapのCore部分

公開契約は用途をMind mapへ固定せず、汎用graph resourceとして作る。

```text
GraphDocument
  nodes[]
    id
    label
    body?
    position?
    metadata?
  edges[]
    id
    source
    target
    label?
    metadata?
```

- create、node patch、edge patch、delete、restoreをDomain Commandにする。
- `graph_view` rendererを登録する。
- AI生成と人間操作を同じcommandへ流す。
- node／edge参照切れをvalidationで拒否する。
- reload後も同じgraphとrevisionへ戻す。

### 8.4 変更候補

- `packages/core-schemas/src/`
- `packages/ui-protocol/src/`
- `packages/action-catalog/src/`
- `packages/workspace-store/src/`
- `packages/runtime/src/`
- `apps/server/src/`
- `apps/web/src/`の最小reference renderer
- `scripts/samurai-artifact-mcp.mjs`
- 新規検証script群

### 8.5 完了条件

- WYSIWYG相当のGUI編集とChat編集が同じArtifact revision列へ残る。
- Imageの生成、編集、restoreがprovenance付きで通る。
- graphの生成、編集、validation、reload、restoreが通る。
- SurfaceがWorkspace正本を迂回して独自状態を持たない。

## 9. Phase 4: 台帳の既存Core候補を閉じる

### 9.1 目的

台帳のP1、P2、P3、P5、P6について、既存Coreで満たしているものと追加修正が必要なものを証拠で閉じる。

### 9.2 閉じ方

| グループ | Coreで確認すること | 製品UIへ送ること |
| --- | --- | --- |
| Backend／Learning | Backend一貫性、Skill改善、Curator、Automation、Memory検査 | 学習内容の見せ方の磨き込み |
| Gateway | Session、Pairing、Allowlist、分割送信、Artifact送信、入口別制限 | 対応Channel追加 |
| Artifact／Attachment | preview contract、export、Chart、Calendar、file metadata、取込provenance | 完成したEditorや管理画面 |
| Wiki／Skill／Automation | read model、lint、backlink、edit／disable／pause command、主Chat context | 専用画面の視覚的な磨き込み |
| Plugin／Diagnostics | manifest、enable／disable、version、error boundary、correlation、Doctor | Marketplaceや配布UX |

既存の自動証拠が現行HEADで通る項目は実装し直さない。追加コードが必要な項目だけを小さな変更単位へ落とす。

### 9.3 完了条件

- 39件すべてが`verified_existing`または新しい自動証拠付き`implemented`になる。
- evidenceだけ不足していた項目に、不要な再実装が入っていない。
- 製品後続5件がCore package、Core API、Core scorecardへ混入していない。

## 10. Phase 5: 100点確認テスト

### 10.1 採点方法

追加スコープ台帳の`A`、`X`、`B`、`C`、`D`、`E`、`G`を正式な確認テストとして組み込む。全50問を各2点で採点し、**50問 × 2点 = 100点**とする。製品後続の`F01〜F05`はCoreの採点対象に含めない。

| 点数 | 判定 |
| --- | --- |
| 2点 | 固定fixtureを使う自動テストまたは静的検査で、正常系と代表的な失敗系を再現できる |
| 1点 | 一部だけ確認済み、手動確認だけ、または失敗系・永続化の証拠が不足している |
| 0点 | 未実装、未確認、fake success、または正本の責務境界を迂回している |

- `N/A`による除外は認めない。該当providerがない場合は、未設定・未認証を正しく診断できることをfixtureで確認する。
- 合格は100点のみとする。99点以下は未完了である。
- 100点でも、4.1の拒否条件に1件でも違反していれば不合格とする。
- 各項目は、test名、実行command、対象file、結果、現行HEADのcommit SHAをreportへ残す。

### 10.2 50問の確認項目

#### A. 台帳整合性: 5問・10点

| ID | 2点の条件 |
| --- | --- |
| A01 | 台帳の0〜2点だった全90項目が欠落なく存在する |
| A02 | 以前3点満点だった項目が追加対象へ混入していない |
| A03 | 全行がCore追加候補、接続契約、製品後続、対象外のいずれかに分類されている |
| A04 | 39件、4件、5件、42件の集計が表と一致する |
| A05 | Backend委譲機能とGenerative UI機能が台帳の最新判断と一致する |

#### X. Backend委譲Capability: 5問・10点

| ID | 2点の条件 |
| --- | --- |
| X01 | Codexの非対話起動経路でWeb検索の利用可否、mode、source eventをfixtureから判定できる |
| X02 | Claude Codeの非対話起動経路でWebSearch／WebFetchの利用可否とtool eventをfixtureから判定できる |
| X03 | Backend内部Subagentの結果を親runへ関連付け、利用不可時は具体的な理由を返せる |
| X04 | HTML取得、実画面操作、実screenshotを別Capabilityとして判定できる |
| X05 | Backend、認証、CLI version、設定の不整合を別reason codeで診断できる |

#### B. BackendとLearning: 7問・14点

| ID | 2点の条件 |
| --- | --- |
| B01 | Web、Gateway、Automationで選択Backendが一致する |
| B02 | Skill利用結果から改訂を作成し、適用できる |
| B03 | Curatorのsnapshot、pin、整理、rollbackが通る |
| B04 | 時刻を制御したfixtureで、Automationが再起動後も一度だけ実行される |
| B05 | 時刻を制御したfixtureで、Heartbeatが未完Workとzombieを処理する |
| B06 | secretと外部instructionがMemory正本へ混入しない |
| B07 | 独自Runtimeを追加せず、X01〜X05の接続契約と失敗説明が通る |

#### C. Gateway: 8問・16点

| ID | 2点の条件 |
| --- | --- |
| C01 | 同一threadが同一Sessionへ戻る |
| C02 | 未承認PairingからCore操作を実行できない |
| C03 | Allowlist変更が次の入力から反映される |
| C04 | 長文が欠落、逆順、重複なく分割される |
| C05 | PDF Artifactの送信payloadを採用済みChannel adapterへ渡せる |
| C06 | Image Artifactの送信payloadを採用済みChannel adapterへ渡せる |
| C07 | Channel別Domain Command制限が変更処理より前に適用される |
| C08 | Gateway経由の操作がWebと同じWorkspace履歴へ残る |

#### D. Canvas、Artifact、Generative UI: 10問・20点

| ID | 2点の条件 |
| --- | --- |
| D01 | Chatから必要な時だけCanvas／Surfaceを選択できる |
| D02 | Document Artifactを表示し、reload後も復元できる |
| D03 | Artifact正本からPDFをexportできる |
| D04 | ChartをWorkspaceデータから生成し、reload後も復元できる |
| D05 | Calendar変更が同じCollection／Automationへ反映される |
| D06 | WYSIWYG編集とChat編集が同じrevision履歴へつながる |
| D07 | Image生成結果をprovenance付きArtifactとして保存できる |
| D08 | Image編集結果を新revisionとして保存し、restoreできる |
| D09 | graphを生成、編集、検証、再読込できる |
| D10 | 代表的な添付形式を由来付きArtifactへ変換し、主実行エージェントへ渡せる |

#### E. Workspace、Plugin、管理Surface: 10問・20点

| ID | 2点の条件 |
| --- | --- |
| E01 | File Inspectorでfile、metadata、由来を確認できる |
| E02 | Wikiを検索し、閲覧できる |
| E03 | Wiki lintがbroken link、duplicate、orphanを検出する |
| E04 | Wiki backlinkを取得できる |
| E05 | Skillを一覧、編集、無効化でき、履歴が残る |
| E06 | Automationを一覧、停止、再開でき、履歴が残る |
| E07 | ToolとFrontend Surfaceを同じPlugin manifestで追加できる |
| E08 | Plugin例外時もChat／Workspaceが動き続け、失敗理由が残る |
| E09 | Pluginのversion、enable、disableを管理できる |
| E10 | Wiki／Skill／Automationから主Chatへ選択resourceを渡せる |

#### G. 全体統合と非目標: 5問・10点

| ID | 2点の条件 |
| --- | --- |
| G01 | UI操作とLLM操作が同じDomain Commandへ到達する |
| G02 | Core追加候補39件と接続契約4件が実装箇所または既存証拠へ対応する |
| G03 | 対象外42件と製品後続5件がCoreへ混入していない |
| G04 | 影響packageの型検査と対象unit／integration testがすべて通る |
| G05 | 現行HEADから既存Core回帰と追加Coreの採点証拠を再生成できる |

### 10.3 軽量テストの実行方針

テストは、短時間で繰り返せる**schema検査、静的検査、unit test、境界単位のintegration test**だけで構成する。

- E2E、Browserの画面操作、目視確認、pixel比較を必須にしない。
- 24時間テスト、soak test、長時間の耐久試験、実時間待機を行わない。
- 実Docker、実Messaging配信、実外部サービス、課金APIへの接続を必須にしない。
- Backend、Browser、Channel、時刻、再起動はfake executable、fake adapter、fake clock、一時Workspaceで決定的に再現する。
- 1 commandは原則30秒以内、全確認は原則10分以内を目安にする。超える場合はtimeoutを伸ばさず、対象分割またはfixture化を行う。
- repository全体の無差別な`pnpm test`、全Web build、既存の重い総合検証を毎回の必須条件にしない。影響packageと既存主要機能の軽量回帰へ絞る。
- real probeは任意の補助確認とし、100点の採点には使わない。実行しないCapabilityは、実環境で確認されるまで`unverified`と表示する。

実装時に、次の短い入口commandを固定する。

```sh
pnpm run core:additions:check-ledger
pnpm run core:additions:test
pnpm run core:additions:score
pnpm run core:additions:verify
```

- `check-ledger`: 90件と39／4／5／42件の分類を静的に確認する。
- `test`: 影響packageの型検査と対象unit／integration testだけを実行する。
- `score`: 50問の証拠を集計し、100点未満なら失敗終了する。
- `verify`: 上記3つと、既存主要機能の短い回帰fixtureをまとめて実行する。

### 10.4 Backend接続の扱い

- 認証されていないBackendを成功扱いにしない。
- version不一致、model不一致、認証切れ、tool無効化を別reason codeにする。
- Backend未設定でもCore自体は起動できるが、そのCapabilityは`unavailable`または`unverified`になる。
- 実接続の成功を製品上で宣言する場合だけ、同じ起動引数によるreal probeの別証拠を要求する。Core追加計画の完了自体には要求しない。

## 11. 代表統合fixture

以下を1本のE2Eにはせず、独立した短いintegration testへ分割する。

1. 一時Workspaceへ既存Core baseline fixtureを読み込む。
2. fake Codex／Claude Code executableからCapabilityと不足理由を取得する。
3. Web検索event、source、最終回答を同じrunへ保存する。
4. HTML取得、Browser操作、実screenshotの成否を別々に記録する。
5. Subagent結果と失敗を親runへ関連付ける。
6. 小さなPDF fixtureから文書ArtifactとChartを作る。
7. 文書をSurface commandとChat commandから編集し、revisionをrestoreする。
8. Image生成・編集adapter fixtureからprovenance付きrevisionを作り、restoreする。
9. graphを生成し、node／edgeを編集してreloadする。
10. Wiki、Skill、Automation、Gateway、Pluginの既存主要経路を個別fixtureで確認する。
11. 現行HEADから50問の採点reportを再生成する。

## 12. 最終完了条件

- [ ] 50問の軽量確認テストが100/100である
- [ ] 4.1の拒否条件への違反が0件である
- [ ] 既存Core主要機能の短い回帰fixtureが通る
- [ ] Core追加候補39件が証拠付きで閉じている
- [ ] 接続契約4件がCapability status、event、失敗説明を持つ
- [ ] Codex／Claude Codeの機能をBackend名だけで利用可能判定していない
- [ ] 独自検索エンジン、Browser engine、Subagent schedulerを追加していない
- [ ] HTML snapshotと実screenshotが区別されている
- [ ] WYSIWYGのCore契約がArtifact revisionへ統一されている
- [ ] Image生成・編集がprovenance付きArtifact revisionへ統一されている
- [ ] graph schema、Domain Command、renderer、reload、restoreが通る
- [ ] 既存のLearning、Gateway、Plugin、Workspace、i18nが壊れていない
- [ ] Installer、Onboarding、Auto UpdateがCore追加範囲へ混入していない
- [ ] 現行HEADから全evidenceとreportを再生成できる
- [ ] E2E、24時間テスト、実外部サービス接続を完了条件に含めていない
- [ ] 参照OSSごとにrepository、commit SHA、参照file、採用／不採用理由が記録されている

この条件をすべて満たした時点で、追加スコープは「参照OSSの機能を寄せ集めた状態」ではなく、Backendの能力を正しく借り、WorkspaceとGenerative UIへ価値を戻すSamurai Agent Coreとして統合されたと判断する。
