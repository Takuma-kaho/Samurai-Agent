# Native Artifact Surface Phase 5・7 実装検証記録

- 実施日: 2026-09-10
- 対象リポジトリ: `/Users/kahotakuma/Developer/Samurai-Agent`
- 基準プラン: [`plans/native-artifact-surface-plan-phase5-7.md`](../../plans/native-artifact-surface-plan-phase5-7.md)
- 作業ブランチ: `codex/phase5-react-app-replacement`
- 基準: `2cbf2b2` と本記録を含む未commit差分

## 1. 現時点の判定

実装とローカルのOSS release gateは成功した。GitHubのクリーンなPostgreSQL環境で実行されるrequired CIは、未pushのためこの記録時点では未実行である。したがって、ローカル成功をリモートCI成功としては扱わない。

今回の再レビューで確認したP1相当の不足は、以下のとおり修正し、対象テストと実画面操作で再確認した。

- 再起動後のSurface Action再送は、クライアント独自のhashではなくServerと同じ `stableHash` で永続Operationを照合する。
- Collectionの保存中に同じ行を続けて編集した場合、後続入力を残したままServerが返したversionを次の保存のbaseへ進める。
- 承認済みSurface Actionの結果と最新Surface dataは、同じmounted iframeに、request IDとoperation IDが一致した場合だけ返す。再起動後の結果は別のrecovery経路へ渡す。
- 承認完了後の親/iframe通知が「確認要求を送信」のまま残らないよう、保存結果を受信したことを明示する。
- 承認後の実行・再認可・復旧・通知はHTTP routeから `WorkspaceInteractionRequestWorkflowService` へ分離した。保守用Accountは監査actorに限り、保存済みの依頼者と承認者の現在のRoom実行権限を両方再確認する。

## 2. 品質・方針のセルフレビュー

- 追加したSurface recoveryは `native-generated-surface-operation-recovery.ts` に閉じ、Room/Surface/Operationの照合規則をReact表示コンポーネントへ分散させていない。共有フレームワーク化やglobal lockは導入していない。
- interaction lifecycleはtransport、業務workflow、通知portを分離した。HTTP routeは認証済み入力と公開応答への変換を担い、lease、再認可、side effect、recoveryの業務判断はworkflow serviceが担う。
- 追加の制約は、対象/版/Operation/承認actorの既存業務境界に限る。Room全体をread-onlyにする待避策、組織横断のlock、汎用outbox、無関係な全面リファクタリングは入れていない。
- 失敗・曖昧な永続履歴・権限失効は空の成功結果へ変換せず、再照会または明示的な失敗状態へ進む。

## 3. 実Client・Native+Gemini E2E

すべてrepo外の専用Self-host環境（専用Docker PostgreSQL、storage、Browser/Electron profile、Workspace、Room、Account）で行った。本番DB、既存の開発DB、既存Desktop profile、外部メッセージ送信には触れていない。Gemini APIキーの値は画面、ログ、記録へ出していない。

| シナリオ | 実施結果 |
| --- | --- |
| Native+Geminiの実生成 | 実ElectronでGemini E2E Agentの完了済みRunを確認。文書Artifact、数値/`false`/`null`/空文字を含む表Artifact、`Gemini E2E 結果表示Surface` が同じ隔離Workspaceへ保存されていることを確認した。 |
| iframeからの承認Action | `Gemini E2E 結果表示Surface` の入力欄へ `Phase5-7 live iframe result 20260910-2312` と本文を入力し、iframeの保存→親画面の確認要求→実Electronの「実行を許可」を通した。 |
| 保存結果と最新dataの返却 | 同じiframe内で `保存成功 ID: artifact_2687f5fa6439f656e7d7e6f929454ba7cb4632ff` と入力タイトルを確認した。親画面ではInteractionが `完了`、Server Versionが `4`、結果が `Generated Surface action completed.` になった。 |
| 再表示 | Surfaceを閉じて開き直した後も、永続Interaction/Operation結果から同じ保存結果を再接続する経路を確認した。 |
| 実Electron再確認 | 現在の最終worktreeを読むElectronで、隔離Workspace、Room、Gemini E2Eの完了済みWork、成果物・操作画面への入口が表示されることをComputer Useで確認した。 |

この実画面経路は、生成HTMLへ結果を返せないという再レビュー指摘に対する修正を直接確認するものだ。最後の通知文言だけの修正は副作用・識別子・保存経路を変更しないため、Component testとWeb typecheckで再確認した。

## 4. 最新コードで実行した自動検証

| 検証 | 結果 |
| --- | --- |
| `pnpm exec vitest run apps/web/src/native-app/GeneratedSurfaceFrame.test.ts` | 17 tests passed。mounted iframeへの承認結果、識別子不一致のfail-closed、完了通知を確認。 |
| `pnpm exec vitest run apps/web/src/native-app/native-artifact-workspace.test.ts apps/web/src/native-app/GeneratedSurfaceFrame.test.ts apps/web/src/native-app/native-collection-panel.test.ts` | 53 tests passed。共通hash、再起動後のOperation recovery、Collectionの保存中追加入力を確認。 |
| `CI=true pnpm run backend:release:verify -- --json` | `ok: true`。全workspace typecheck、1,384 passed / 6 skipped tests、i18n、Web/Desktop build、architecture、PostgreSQL境界、release hygieneを含む。 |
| `pnpm run verify:source-quality` | format 950 files、lint 831 files、issues `[]`。 |
| `pnpm run desktop:verify` / `pnpm run desktop:build` | Desktop境界、typecheck、Main/Preload bundle、artifact検査すべて成功。 |
| `pnpm audit --audit-level=moderate` | `No known vulnerabilities found`。 |
| `git diff --check` | 成功。 |

ローカルの `verify:ci-full` は既存の隔離DBに残った管理者passwordと一時envの不一致により、deep PostgreSQL probeだけを実行できなかった。DBの認証情報を書き換えて成功扱いにすることはせず停止した。GitHubの `postgres-deep` と `postgres-completion-load` は各jobで使い捨てDBを作るため、最終required CIで別途確認する。

## 5. 未検証と対象外

- GitHub required CIの実行結果は未pushのため未検証。push後にCI URLと対象SHAを確認するまでPhaseの正式クローズにはしない。
- Hosted実環境、Windows/Linux GUI、署名済み配布物は本プランが明示する後続Phaseの対象であり、Self-host成功と同一視しない。
- 実Gemini以外の外部CLIの公式認証を新たに要求することは、本Phaseで変更したNative+Gemini機能の完成条件に含めない。

## 6. 次の確定手順

この記録を含む差分をcommitしてpushし、CI、Security、PostgreSQL deep、Completion loadをすべて確認する。失敗があれば原因がコードか環境かを分け、コード起因だけを最小範囲で修正して同じ対象SHAのCIを再実行する。
