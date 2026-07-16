# Core 1 契約・Domain Command基盤 OSS品質完成計画

## 0. この文書の状態

- 対象: Core分類1「契約・Domain Command基盤」だけ。
- 状態: 実装計画。**この文書を作成した時点では未完了**。
- 完了判定: 本文の必須実装を終え、全Hard Gateが合格し、旧経路を削除した時だけ完了。
- 基準日: 2026-07-15。
- 上位正本: `PRINCIPLES.md` → `ARCHITECTURE.md` → `PUBLIC_NAMING.md` → 本計画。

この計画は、既存の「テストが通る契約基盤」を、**コードの構成とプログラムの作り方まで参照OSS級にする**ための差分計画である。

## 1. 対象範囲

| Core分類 | この計画での扱い |
| --- | --- |
| 1. 契約・Domain Command基盤 | 全面対象 |
| 2. Host・Runtime | Domain Operationの定義、配線、分岐、直接更新をHostから除去する範囲だけ対象 |
| 3. Backend実行・Event正規化 | Backend Toolを同じDispatcherへ接続する境界だけ対象 |
| 4. Workspace・永続化 | Read/Write Port、冪等性Record、Query read-only接続に必要な範囲だけ対象 |
| 5〜8 | 各機能をDomain Operationとして接続する境界だけ対象。各機能そのものの完成度は対象外 |

対象外を理由に、Core 1の境界違反を残してはならない。たとえば`AgentRuntime`全体の分割はCore 2だが、Domain Operation ID分岐、114件の手書き配線、直接Store更新はCore 1として除去する。

## 2. 完成の定義

完成時は、次をコード構造で保証する。

> **1 Active Operation = 1 Operation Module = 1 Zod入力契約 = 1 Zod出力契約 = 1固有Handler = 1 Registry定義 = 1 Dispatcher実行経路**

2026-07-15時点の基準Inventoryは以下。

- Active Command: 102件。
- Active Query: 12件。
- Deprecated Operation: 5件。Registryには登録しない。
- Active Operation: 114件。
- `collection.manage`: 互換変換専用。正規Operationではない。

ただし、**件数一致だけでは合格にしない**。114件すべてのID集合、Schema、Handlerのソース位置、実行先、入口Mappingを比較する。

## 3. 現状の批判的評価

### 3.1 残す価値がある実装

- CommandとQueryのRegistryが分かれている。
- 入力Schema、冪等性Record、Heartbeat、CAS、Trusted Ingressの基礎がある。
- 102 Command、12 Query、5 DeprecatedのInventoryがある。
- 全入口を同じRuntime APIへ寄せる作業が進んでいる。
- `core:domain-commands:check`とEvidence生成の基礎がある。

### 3.2 完了扱いできない理由

| 現状 | 問題 | 必須修正 |
| --- | --- | --- |
| `domain-operation-handlers.ts`に114個の名前付き関数がある | 実体の大半は共通`typedPortHandler`を返すだけで、固有Handlerの存在を件数で擬似的に満たしている | Operation Module内に固有のnamed Handlerを置き、共通転送Handlerを削除 |
| Contract、Schema、Handler、実処理が複数の巨大ファイルへ分散 | 1操作を理解・変更するために複数箇所を追う必要がある | 1操作1Moduleへ近接配置 |
| `handler_id`文字列でContractとHandlerを後から結合 | 文字列Mappingが別の正本になり、コンパイル時の結合保証が弱い | DefinitionがHandler factoryを直接保持し、文字列結合を廃止 |
| `defineCommand()`がID文字列からEffectやConcurrencyを推測 | 新規Operationの意味を暗黙Defaultが決める | 全Operationで明示。IDベースDefaultを禁止 |
| 全入力Schemaが1つの大きなRecordに集約 | Schema変更の影響範囲とレビュー単位が大きい | Operation Moduleへ移動。共有はValue Objectだけ |
| 独自`jsonSchemaFromZod()`がZodのprivate `_def`を読む | Zod更新で壊れやすく、対応型も不完全 | 保守されている変換器へ一本化し、private API参照をゼロ化 |
| Registryは入力検証後にHandler結果をそのまま返す | 出力契約違反が実行時に外へ漏れる | Dispatcherで成功出力を必ずZod検証 |
| 構造検査の一部が正規表現・文字列検索 | 名前変更や書き方変更で誤検出・見逃しが起きる | TypeScript Compiler APIによるAST・Symbol・Import graph検査 |
| `AgentRuntime`にOperation配線が大量に残る | HostがComposition Rootを超えて個別操作を知る | Domain Compositionへ抽出し、RuntimeからOperation IDを除去 |
| Gateが自分自身の弱点を壊して確認していない | Gateが通っても本当に違反を検出できるか不明 | 意図的違反Fixtureを全種類用意し、必ず非ゼロ終了を確認 |

## 4. 参照OSS固定台帳

参照は設計思想だけでなく、**ソースの作り方**を対象にする。`main`追従ではなく、次のCommit SHAへ固定する。

| 参照OSS | 固定Commit | 参照Source | 採用する実装パターン |
| --- | --- | --- | --- |
| MulmoClaude | [`14ba3afe41f682794c4412c3e12fcab34e610778`](https://github.com/receptron/mulmoclaude/commit/14ba3afe41f682794c4412c3e12fcab34e610778) | `docs/plugin-runtime.md`, `packages/plugins/bookmarks-plugin/src/index.ts` | Zodによる実入力検証、狭いRuntime capability、直接I/O禁止、discriminated unionと網羅的switch、並列更新の直列化 |
| Hermes Agent | [`9df5f879b4a5925c0f8f947e7e16ed8e845932c3`](https://github.com/NousResearch/hermes-agent/commit/9df5f879b4a5925c0f8f947e7e16ed8e845932c3) | `tools/registry.py`, `website/docs/developer-guide/tools-runtime.md` | 操作Module単位の自己登録、Schema・Handler・Availabilityの近接、中央Registry/Dispatch、ASTによるModule discovery |
| OpenClaw | [`855659a1dd0542f6fc76dcc8343335e983f9189c`](https://github.com/openclaw/openclaw/commit/855659a1dd0542f6fc76dcc8343335e983f9189c) | `docs/gateway/protocol.md`, `packages/gateway-protocol/src/schema.ts`, `packages/gateway-protocol/src/schema/*` | Schemaの分野別Module化、Schemaから型・公開モデルを生成、Protocol check、server-owned Context、side effectの冪等性 |

参照コードをコピーしない。採用したパターン、Samurai Agent側の実装箇所、検証Gateを中央の参照台帳で1対1対応させる。全Operationへ同じOSS出典を複製しない。

## 5. 破ってはいけない構造ルール

### 5.1 Operation単位

1. Active Operationごとに`.operation.ts`を1ファイル持つ。
2. 1ファイルに置けるActive Operation定義は1件だけ。
3. 入力Zod Schema、出力Zod Schema、metadata、Handler factoryを同じModuleに置く。
4. Handlerは入力型をSchemaから推論し、`Record<string, JsonValue>`を受け取らない。
5. Handlerは固有のnamed functionとし、別Operationと同じ関数参照を共有しない。
6. 共通化してよいのはValue Object Schema、Domain primitive、Port、Service。Handler自体は共通化しない。
7. `entry.id`、`command.id`、`query.id`を見て再配送しない。
8. 1操作内の業務variantはZod discriminated unionと網羅的switchで扱う。
9. `effect`、`concurrency`、`sources`、`availability`、`render`、`version`を明示し、ID文字列から推測しない。
10. CommandはWrite Port、QueryはRead-only Portだけを受け取る。

### 5.2 Registry・Dispatcher単位

1. `handler_id`、`runtime_method`、`query_service_id`による文字列Handler結合を廃止する。
2. Registry EntryはContractと実行可能Handlerを同じDefinitionから作る。
3. Raw InputはRegistry境界より内側へ入れない。
4. Handler成功出力は返却・保存前に出力Zod Schemaで検証する。
5. Registryは重複ID、欠落Schema、欠落Handler、Handler再利用、無効metadata、生成index driftで起動失敗する。
6. 動的Availabilityの例外はfail-closedにし、Effective Inventoryへ出さず構造化診断を残す。
7. 一覧取得時だけでなく実行直前にもAvailabilityとAllowed Sourceを再確認する。
8. Registryは構築完了後にimmutableとし、Built-in OperationをPluginが上書きできない。

### 5.3 禁止事項

- Operation/Registry/Dispatcherでの`any`、`as any`、`as unknown as`。
- Zod private APIの`_def`参照。
- generic payload fallback Schema。
- generic forwarding Handler。
- Operation Moduleから`AgentRuntime`または生の`WorkspaceStore`をimport。
- Server route、Surface adapter、Provider adapter、Gateway adapterからの直接Store mutation。
- Queryから履歴、利用記録、timestamp、cache、filesystem、SQLiteを書き換えること。
- Production sourceを正規表現だけで検査して完了判定すること。
- 旧経路を「念のため」残すこと。

## 6. 目標ファイル構成

```text
packages/domain-operations/
  package.json
  src/
    definition/
      command-definition.ts
      query-definition.ts
      domain-result.ts
      domain-error.ts
      contract-version.ts
      json-schema.ts
    context/
      trusted-domain-context.ts
    registry/
      command-registry.ts
      query-registry.ts
      effective-operations.ts
    dispatcher/
      command-dispatcher.ts
      query-dispatcher.ts
    ports/
      artifact-ports.ts
      automation-ports.ts
      browser-ports.ts
      collection-ports.ts
      conversation-ports.ts
      file-ports.ts
      gateway-ports.ts
      learning-ports.ts
      memory-ports.ts
      skill-ports.ts
      workspace-ports.ts
      ...
    operations/
      artifact/
        create.operation.ts
        export-pdf.operation.ts
        repair.operation.ts
        ...
      file/
        read.operation.ts
        inspect.operation.ts
        list.operation.ts
        patch.operation.ts
        write.operation.ts
      ...
    generated/
      operation-index.generated.ts
      operation-binder.generated.ts
    catalog.ts
    runtime.ts
  test/
    structure/
    contracts/
    registry/
    handlers/
    routing/
    idempotency/
    query-purity/
    fault-injection/
    verifier-self-test/
```

依存方向を次に固定する。

```text
core-schemas
    ↓
domain-operations
    ↓
action-catalog
    ↓
runtime composition
    ↓
server ingress / backend tools / gateway / automation / surfaces
```

- `domain-operations`は`runtime`、`action-catalog`、`workspace-store`へ依存しない。
- `action-catalog`はDefinitionから公開用Catalogを投影するだけで、Domain契約を再定義しない。
- `runtime`は実Portを注入するComposition Rootだけを持つ。
- 生成indexは手編集禁止。Module discovery結果から決定的に生成し、一時生成結果との差分をGateにする。

## 7. Operation Moduleの必須形

以下は実装形の基準であり、概念例ではない。

```ts
import { z } from "zod";
import {
  defineCommand,
  type CommandHandler,
  type TrustedDomainContext,
} from "../../definition";
import type { ArtifactCreatePorts } from "../../ports/artifact-ports";

const Input = z.object({
  title: z.string().min(1),
  content: z.string(),
  expectedVersion: z.number().int().nonnegative().optional(),
}).strict();

const Output = z.object({
  artifactId: z.string().min(1),
  revision: z.number().int().positive(),
}).strict();

export const artifactCreate = defineCommand<ArtifactCreatePorts>()({
  id: "artifact.create",
  version: "1.0.0",
  input: Input,
  output: Output,
  sources: ["runtime_api", "provider_tool_call", "surface_operation"],
  availability: "active",
  effect: "workspace_mutation",
  idempotency: "required",
  concurrency: "optimistic_version",
  render: ["artifact"],
  createHandler(ports): CommandHandler<typeof Input, typeof Output> {
    return async function handleArtifactCreate(
      context: TrustedDomainContext,
      input: z.infer<typeof Input>,
    ) {
      const artifact = await ports.create({
        workspaceId: context.workspaceId,
        actorId: context.actorId,
        ...input,
      });
      return { ok: true, value: artifact };
    };
  },
});
```

必須条件。

- `defineCommand`/`defineQuery`がSchemaからHandlerの入出力型を推論する。
- `createHandler`はOperation固有のnamed functionを返す。
- Handlerが見えるPortは、その操作に必要な最小メソッドだけ。
- Simple Operationが1回のPort呼び出しだけでもよい。ただし共通転送Handlerへ隠さない。
- 複雑な業務処理はHandlerが順序と判断を持ち、PortはI/O primitiveまたは明確なDomain Serviceに限定する。
- `defineQuery`は型レベルでRead-only Port以外を受け取れない。

## 8. 必須実装

### 8.1 `@samurai-agent/domain-operations`を正本化する

- Command/Query Definition型を新Packageへ置く。
- `packages/action-catalog/src/index.ts`のDomain契約定義を移動する。
- Action CatalogはDefinitionを公開用JSONへ投影する。
- `domain-operation-input-schemas.ts`のOperation payload Schemaを各Moduleへ移動する。
- `domain-contracts.ts`のDomain固有型と検証を新Packageへ移す。
- Plugin catalog、署名検証などDomain Operationでない責務はAction Catalogへ残す。

### 8.2 Schemaを実行可能な唯一の正本にする

- 入力と成功出力をZodで定義する。
- Public JSON Schemaは既存依存の`zod-to-json-schema`へ一本化する。
- JSON Schemaを手書きしない。
- Zod private APIへ触れない。
- 全Top-level objectを`.strict()`にする。
- 自由形式が必要なfieldは、そのOperation Moduleで`z.record()`または明示Schemaとして宣言する。
- 共通SchemaはID、ResourceRef、Locale、Paginationなど意味が同一のValue Objectだけ許可する。
- Contract fingerprintは、ID、version、canonical JSON Schema、effect、concurrency、sources、renderから生成する。

### 8.3 Handlerを本当に分離する

- 114件すべてにOperation Moduleと固有named Handlerを作る。
- 現在の分野別Domain Serviceから、操作固有の業務順序・判断をHandlerへ移す。
- 共有してよい処理は、名前と責務が明確なService/Portへ残す。
- Handlerは`TrustedDomainContext`と型付きInputだけを受け取る。
- `inputSource`だけを横流しする共通Handlerを削除する。
- `domain-operation-handlers.ts`と`domain-operation-definitions.ts`は最終的に削除する。

### 8.4 Read/Write Portを能力単位にする

- 生のStoreではなく、操作に必要な最小能力をinterface化する。
- Write PortはCommandだけへ注入する。
- Queryは`ReadonlyWorkspacePort`、read-only SQLite connection、read-only filesystem adapterだけを使う。
- Query用SQLite connectionでは`PRAGMA query_only=ON`を有効にする。
- Port adapterが返す値もZodまたは明確なDomain型で境界検証する。
- Port adapterにOperation ID分岐を置かない。

### 8.5 RegistryとDispatcherを一本化する

- Generated indexから全Definitionを静的importする。
- 起動時にContract検証、Handler binding、重複検査、fingerprint生成を1回行う。
- Commandは`DurableDomainCommandBus`を必ず通す。
- QueryはCommand Busを通さず、read-only Query Dispatcherを通す。
- InputはHandler前、OutputはHandler後に検証する。
- 例外は中央でTyped Errorへ変換し、stack、path、secret、payloadを外へ出さない。
- Handlerの`DomainResult`以外の戻り値を拒否する。
- O(1)のID lookupを維持し、実行時に全Operationを走査しない。

### 8.6 Trusted ContextをServer-ownedにする

- `workspaceId`、`actorId`、`sessionId`、`runId`、`inputSource`、`correlationId`、deadline/cancellationをIngress側で確定する。
- Payload内の同名fieldをContextへ昇格しない。
- SessionとActorの所属関係を実行前に検証する。
- Effective Inventoryと実行時判定で同じAvailability resolverを使う。
- 実行直前にSession状態を再読込し、一覧取得後の状態変化を見逃さない。

### 8.7 全入口を同じDefinitionへ接続する

対象入口。

- Web/Runtime API。
- Surface Operation。
- Provider/Backend Tool call。
- Gateway inbound。
- Automation/Scheduled context。
- Generated Surface action。

Ingress adapterが行ってよいのは、Transport認証、Raw Input変換、Trusted Context生成、安定した冪等性Key生成だけ。業務処理とStore更新は禁止する。

### 8.8 冪等性・Concurrency・Crash境界を完成させる

- 全Commandで冪等性Keyを必須にする。
- HashへCommand ID、Contract version、Workspace、Session、Actor、canonical payloadを含める。
- 同じKey・同じHashは保存結果を返し、Handlerを再実行しない。
- 同じKey・違うHashは409相当のTyped Conflictを返す。
- Claim、Heartbeat、Complete/Fail、stale判定をCASで更新する。
- stale `running`だけを`outcome_unknown`へ移す。
- 外部副作用後に結果保存前Crashが起きた場合、自動再実行しない。
- 外部送信先へ渡せる場合は同じidempotency keyを下流へ伝播する。
- `failed`結果も同じTyped Errorとして再生する。
- Fake clockと実SQLite multi-process testの両方で検証する。

### 8.9 CompatibilityとDeprecatedを隔離する

- `collection.manage`は6 Actionを正規Command/Queryへ変換する純粋adapterに限定する。
- adapter自身はStore、Service、旧Handlerを呼ばない。
- Deprecated 5件はRegistryへ登録しない。
- Deprecated実行は`410 deprecated_operation`と置換先情報を返す。
- 正規OperationからCompatibility/Deprecated側へ依存しない。

### 8.10 旧経路を削除する

最終段階で次をゼロにする。

- `typedPortHandler`。
- `handler_id`によるbinding。
- `domain-operation-handlers.ts`。
- `domain-operation-definitions.ts`。
- Action Catalog内のDomain Operation巨大配列。
- Domain Operation payloadの巨大Schema Record。
- 独自`jsonSchemaFromZod()`。
- `AgentRuntime`内のOperation ID、114件のPort mapping、Domain直接処理。
- Server/adapterの直接Store mutation。
- 利用されないLegacy HandlerとFallback。

## 9. 厳格テスト設計

全GateはHard Gateとする。点数による相殺、warning扱い、既知失敗のallowlist化は禁止する。

### 9.1 構造・型Gate

| ID | 検証内容 | 合格条件 |
| --- | --- | --- |
| ST01 | Operation Module数 | Active ID集合と`.operation.ts`集合が完全一致 |
| ST02 | 1 Module 1 Operation | 各Moduleに`defineCommand`または`defineQuery`がちょうど1件 |
| ST03 | Contract近接 | Input、Output、metadata、`createHandler`が同じModuleのAST内に存在 |
| ST04 | Handler固有性 | 114件すべて別のnamed function symbol。共有参照0件 |
| ST05 | 文字列binding禁止 | `handler_id`、`runtime_method`、`query_service_id`による実行bindingが0件 |
| ST06 | 再配送禁止 | Handler/Port/Service内のOperation ID比較、switch、Map再配送が0件 |
| ST07 | 共通転送禁止 | `typedPortHandler`相当のgeneric forwarding Handlerが0件 |
| ST08 | 禁止import | HandlerからRuntime、生Store、Server、UIへのimportが0件 |
| ST09 | Read/Write分離 | Query HandlerがWrite Port型へ到達不能 |
| ST10 | 型逃げ禁止 | Production Domain sourceの`any`、二重cast、non-null乱用が0件 |
| ST11 | Zod private API禁止 | `_def`参照0件 |
| ST12 | 生成物drift | 一時生成したindex/binderとcommitted生成物がbyte一致 |
| ST13 | 循環依存 | `core-schemas → domain-operations → action-catalog → runtime`の逆流0件 |
| ST14 | Runtime境界 | `agent-runtime.ts`にOperation ID、Handler mapping、直接Domain mutationが0件 |

実装方法。

- TypeScript Compiler APIでAST、Symbol、Type、Import graphを検査する。
- 固有Handlerから操作固有Serviceへ委譲することは許可する。Serviceの分岐数、await数、呼出数を違反条件にしない。ST06はOperation IDによる再配送、ST07はgeneric forwardingだけを検査する。
- `rg`は補助診断だけに使い、合否の唯一の根拠にしない。
- Type-level negative fixtureを`tsc --noEmit`で実行し、QueryへWrite Portを渡すコードなどが必ずcompile errorになることを確認する。

### 9.2 Contract・Schema Gate

| ID | 検証内容 | 合格条件 |
| --- | --- | --- |
| CT01 | Inventory | 102 Command、12 Query、5 DeprecatedのID集合が台帳と完全一致 |
| CT02 | Zod正本 | 全114件のInput/OutputがZod-backed |
| CT03 | Strict input | 未定義Top-level fieldを全114件で拒否 |
| CT04 | Strict output | 未定義field、不足field、型違いを全114件の出力で拒否 |
| CT05 | 正常・異常表 | 各Schemaで正常、必須不足、型違い、境界値、余剰fieldを検証 |
| CT06 | Property test | `fast-check`で生成した不正値がHandlerへ到達しない |
| CT07 | JSON Schema生成 | `zod-to-json-schema`以外の独自変換0件 |
| CT08 | 公開Schema parity | Zodの受理/拒否と公開JSON Schema validatorの結果が一致 |
| CT09 | Fingerprint | Schemaまたはmetadata変更時にfingerprintが必ず変化 |
| CT10 | Version規律 | 破壊的Schema変更でversion未更新なら失敗 |
| CT11 | Catalog parity | Action Catalog、Provider Tool、Surface actionが同じDefinitionから生成 |
| CT12 | Payload限界 | 最大depth、最大配列数、最大文字数、prototype pollution入力を安全に拒否 |

### 9.3 Registry・Handler Gate

| ID | 検証内容 | 合格条件 |
| --- | --- | --- |
| RH01 | Registry初期化 | 重複ID、欠落Schema、欠落Handler、Handler再利用で起動失敗 |
| RH02 | Immutable | 初期化後の追加、削除、上書きを拒否 |
| RH03 | Deterministic | 同じSourceから同じ並び、fingerprint、Catalogを生成 |
| RH04 | Input先行検証 | 不正Input時のPort呼び出し0回 |
| RH05 | Output後行検証 | 不正Outputを返したPort/Handlerを内部契約違反として遮断 |
| RH06 | Fake Port | 全114 Handlerが期待Portだけを期待回数呼ぶ |
| RH07 | Port最小性 | 各Handler fixtureに未許可Portを渡せず、許可Port以外の呼出し0件 |
| RH08 | Typed Error | 既知Errorと未知例外が定義済みError envelopeへ変換 |
| RH09 | Availability | unavailable/例外時は一覧・実行ともfail-closed |
| RH10 | Allowed Source | 禁止入口からの実行をHandler前に拒否 |
| RH11 | Cancellation | Server-owned AbortSignal/deadlineをHandlerとPortへ伝播 |
| RH12 | O(1) lookup | DispatchがID Map lookupであり、全件走査を行わない |

### 9.4 Ingress・互換Gate

| ID | 検証内容 | 合格条件 |
| --- | --- | --- |
| IN01 | 全入口同一性 | 6入口の同じ操作が同一Definition fingerprintとHandler symbolへ到達 |
| IN02 | 結果parity | 入口差によってvalidation、result、error、changeが変わらない |
| IN03 | Direct mutation | Server/Surface/Provider/Gateway/Automation/Generated Surfaceから直接Store更新0件 |
| IN04 | Source偽装 | Payload内`input_source`を無視し、診断を返す |
| IN05 | Workspace偽装 | Payloadで別Workspaceを指定してもContextへ採用しない |
| IN06 | Actor/Session偽装 | 所属しないActor/SessionをHandler前に拒否 |
| IN07 | Effective inventory | Session、Backend、Plugin、入口状態で一覧が正しく変化 |
| IN08 | TOCTOU | 一覧取得後に無効化されたOperationを実行直前に拒否 |
| IN09 | Deprecated | 5件すべて410、Registry登録0件、置換先を返す |
| IN10 | `collection.manage` | 6 Actionすべて正しい正規Operationへ変換 |
| IN11 | Legacy isolation | Compatibility adapter以外からLegacy sourceへ到達不能 |
| IN12 | Correlation | request→operation→execution→workspace changeを同じcorrelationで追跡可能 |

### 9.5 冪等性・Concurrency・Crash Gate

| ID | 検証内容 | 合格条件 |
| --- | --- | --- |
| ID01 | Key必須 | 全102 CommandでKeyなしをHandler前に拒否 |
| ID02 | 同一再送 | 同一Key・同一内容は保存結果を返し副作用1回 |
| ID03 | Scope衝突 | Workspace/Session/Actor違いのKey再利用を拒否 |
| ID04 | Payload衝突 | Payload違いのKey再利用を拒否 |
| ID05 | Version衝突 | Contract version違いのKey再利用を拒否 |
| ID06 | 100並列 | 同一Processで100並列実行し副作用1回 |
| ID07 | Multi-process | 実SQLiteへ10 workerからclaimし成功1件 |
| ID08 | Heartbeat | 正常長時間処理をstale扱いしない |
| ID09 | CAS | stale観測後にHeartbeatが進んだRecordを上書きしない |
| ID10 | Crash-before | Handler前Crash後は安全に再claim可能 |
| ID11 | Crash-during | 内部transaction中Crash後に中途半端なWorkspace状態0件 |
| ID12 | Crash-after-external | 外部副作用後・結果保存前Crashは`outcome_unknown`、自動再実行0件 |
| ID13 | Completed replay | 完了結果を同じ型・内容で再生 |
| ID14 | Failed replay | 失敗結果を同じTyped Errorで再生 |
| ID15 | Migration | 旧Execution Recordを決定的に移行し、再実行を誤許可しない |

Crash testはtest-onlyの結果差し替えではなく、子Processを指定checkpointで終了させ、実SQLiteと一時Workspaceを再起動して確認する。

### 9.6 Query純粋性Gate

| ID | 検証内容 | 合格条件 |
| --- | --- | --- |
| QP01 | Compile-time | QueryからWrite Portへ到達するfixtureがcompile error |
| QP02 | SQLite read-only | 12 Queryを`PRAGMA query_only=ON` connectionで完走 |
| QP03 | Filesystem read-only | 書込みAPIを持たないadapterで12 Queryを完走 |
| QP04 | Logical state diff | 実行前後の全table dumpとWorkspace tree hashが一致 |
| QP05 | Hidden write | history、usage、access timestamp、cache更新0件 |
| QP06 | `skill.view` | Queryは閲覧だけ。利用記録は`skill.usage.record` Commandだけ |
| QP07 | Parallel read | 並列Queryがlock、Record、temp fileを残さない |
| QP08 | Failure purity | Query失敗時もSQLite/filesystem変更0件 |

### 9.7 Error・Security・観測Gate

| ID | 検証内容 | 合格条件 |
| --- | --- | --- |
| ES01 | Result形 | 外へ出る値が`DomainResult<Output>`だけ |
| ES02 | Error code | validation/conflict/unavailable/not-found/outcome-unknown/internalを安定code化 |
| ES03 | Redaction | stack、absolute path、secret、token、raw payloadが応答・logへ出ない |
| ES04 | Log metadata | operation ID、version、source、correlation、duration、outcomeを記録 |
| ES05 | Payload非記録 | 標準logへ入力本文・出力本文を出さない |
| ES06 | Built-in保護 | Plugin/BackendによるBuilt-in ID上書きを拒否 |
| ES07 | Oversize | size/depth上限超過をparse前後の適切な境界で拒否 |
| ES08 | Unknown exception | 未知例外でProcessを落とさず、内部Errorとして記録 |

### 9.8 Verifier自己検査

Verifierへ次の違反を1件ずつ注入し、**すべて非ゼロ終了**を確認する。

1. Active IDを1件削除。
2. 同じHandlerを2 Operationへ登録。
3. `typedPortHandler`型の共通転送を追加。
4. Handlerへ`switch(command.id)`を追加。
5. QueryへWrite Portを渡す。
6. Handlerから`WorkspaceStore`をimport。
7. Schemaから`.strict()`を外す。
8. 出力検証を外す。
9. `effect`をID defaultへ戻す。
10. Zod `_def`参照を追加。
11. 入口から直接Store mutationを追加。
12. Catalogだけ別Schemaへ変更。
13. 生成indexを手で変更。
14. Evidenceのexpected値だけ実結果に合わせる。
15. Gate途中を失敗させた状態で`status: "passed"`生成を試みる。

各違反に専用fixture名と期待Error codeを持たせる。単に「何かの理由で失敗した」だけでは合格にしない。

## 10. Test配置と実行Command

追加・更新する主な検証ファイル。

```text
scripts/verify-domain-operation-structure.mts
scripts/verify-domain-operation-imports.mts
scripts/verify-domain-operation-generated.mts
scripts/verify-domain-operation-ingress.mts
scripts/verify-domain-operation-evidence.mts
packages/domain-operations/test/**/*.test.ts
packages/domain-operations/test/**/*.type-test.ts
packages/runtime/src/commands/domain-command-bus.test.ts
apps/server/src/domain-ingress.test.ts
```

固定Command。

```sh
pnpm core:domain-commands:check
pnpm core:domain-commands:verify
```

`check`が必ず実行するもの。

1. Core Schemas、Domain Operations、Action Catalog、Runtime、Serverのtypecheck。
2. Operation unit/contract/property test。
3. AST、Symbol、Import graph検査。
4. 全入口parity。
5. Query purity。
6. 冪等性100並列、multi-process、Crash injection。
7. Verifier自己検査。
8. 対象Moduleのcoverage gate。
9. 全Repo test。
10. `git diff --check`。

Coverage基準。

- Operation Module、Registry、Dispatcher、Domain Command Bus: statement/function/line 100%。
- 上記のbranch: 95%以上。ただし冪等性状態遷移、validation、availability、error mappingはbranch 100%。
- Coverage除外commentは、理由と承認済みtest IDがない限り禁止。

`verify`は`check`に加えて次を要求する。

- 対象Sourceがcommit済みかつclean。
- 生成index、Catalog、契約台帳が一時生成結果とbyte一致。
- EvidenceのSource SHA-256とGit commit SHAが一致。
- 全Gate完了後にだけEvidenceをatomic write。
- 途中失敗時は既存のpassed Evidenceを削除またはinvalid化し、更新しない。
- Evidenceの`actual`はtest結果からのみ取得し、expected値から生成しない。

## 11. CI品質

- Linux、macOS、Windowsでtypecheck、unit、contract、AST gateを実行する。
- Linuxで実SQLite multi-process、Crash injection、全Integration testを実行する。
- Node/pnpm versionを固定する。
- 生成物drift、lockfile drift、flaky retryを禁止する。
- 同じtestの自動retryで成功扱いしない。
- 24時間soakはCore 1の完了条件にしない。決定的な並列・Crash testで保証する。

## 12. 実装順と各段階の終了条件

### Phase 0: Baseline固定

- 現行114 ID、入口Mapping、結果、Error、Store changeをCharacterization fixtureへ固定する。
- 現在の型・test失敗をゼロにする。
- 新規Operation追加を一時停止し、Inventory差分を明示管理する。

終了条件: 現行挙動を再現できるfixtureと、既知Gap一覧が揃う。

### Phase 1: Definition基盤

- `domain-operations` Package、Definition、Result、Error、Trusted Context、Schema変換を実装する。
- `artifact.create` Commandと`file.read` Queryを縦切りで移行する。
- 型Gate、出力検証、Read/Write分離を先に完成させる。

終了条件: 代表Command/Queryで全構造Gateが通り、旧経路とのparityが取れる。

### Phase 2: 全Operation移行

- 分野ごとに1 Operation 1 Moduleへ移行する。
- 各分野の移行と同時に専用Handler testを追加する。
- 書込みOperationを新旧同時実行しない。保存済みfixtureとFake Portでparityを取る。

移行順。

1. Conversation / Session。
2. Artifact / Presentation。
3. Memory / Wiki / Skill / Learning。
4. Collection。
5. File / Browser。
6. Gateway / External Send / Client Event。
7. Automation / Objective / Work Item。
8. Generated Surface / System / Settings / Translation。

終了条件: 114 Operation Module、114固有Handler、114 Input/Output契約が揃う。

### Phase 3: Catalog・全入口切替

- Action CatalogをDefinition projectionへ切り替える。
- 6入口を新Dispatcherへ切り替える。
- Effective Inventory、Trusted Context、Deprecated、Compatibilityを切り替える。

終了条件: 入口parity、偽装拒否、direct mutation 0件。

### Phase 4: Durable実行完成

- 冪等性、Heartbeat、CAS、Crash recovery、external outcome unknownを完成させる。
- 実SQLite multi-process testと子Process Crash testを通す。

終了条件: ID01〜ID15が全合格。

### Phase 5: 旧実装削除

- 旧Handler、文字列binding、巨大Schema Record、独自変換、Runtime配線、Legacy fallbackを削除する。
- 削除後にparityと全Repo testを再実行する。

終了条件: 旧経路へ到達するimport/call graphが0件。

### Phase 6: Evidence確定

- Verifier自己検査を全件通す。
- 一時生成物と台帳を一致させる。
- Commit後のclean treeで`verify`を実行する。

終了条件: 全Hard Gate合格、Evidence fresh、CI全platform合格。

## 13. 完了時に残してよいもの

- Operation Moduleから呼ばれる共有Domain Service。
- Value Objectとして意味が同じ共有Zod Schema。
- Registry/Dispatcher/Result/Error/Contextの共通基盤。
- `collection.manage`の純粋Compatibility adapter。
- Deprecated IDと置換先を示す静的台帳。
- 参照OSSの固定SHA台帳。

## 14. 完了時に残してはいけないもの

- 名前だけ違う共通転送Handler。
- Operation IDで再分岐する分野別Handler/Service。
- ContractとHandlerを結ぶ文字列ID。
- 手書きの114件中央Mapping。
- Operation payloadを集めた巨大Fallback Schema。
- Zod private API依存。
- Queryの隠れ書込み。
- 入口固有の業務処理。
- 直接Store mutation。
- 正規表現だけで合格する構造Gate。
- Gate失敗中に生成された`status: "passed"` Evidence。
- 「念のため」のLegacy実行経路。

## 15. 最終Definition of Done

次の質問へすべて「はい」と根拠付きで答えられること。

1. 114件すべてを1 Operation Moduleだけ読めば、入力、出力、意味、Handler、許可入口、Effect、Concurrency、Renderが分かるか。
2. 114件すべてが別のnamed Handler functionを持つか。
3. RegistryがContractとHandlerを文字列で後付け結合していないか。
4. 新しいOperationを1 Module追加するだけで生成index、Catalog、全入口へ安全に反映できるか。
5. Queryは型と実行環境の両方で書込み不能か。
6. どの入口から実行しても同じDefinition、validation、Handler、result、errorになるか。
7. 同じCommandを100並列・10 processで送っても副作用は1回か。
8. 外部副作用直後にProcessが落ちても自動二重実行しないか。
9. 不正な入力だけでなく、不正なHandler出力も外へ漏れないか。
10. Gateへ意図的な違反を入れた時、正しい理由で必ず失敗するか。
11. `AgentRuntime`、Server、AdapterからDomain Operationの個別処理と直接更新が消えたか。
12. 全Source、生成物、Evidence、Git SHAが一致しているか。

**1項目でも「いいえ」なら、Core分類1は未完了と判定する。**
