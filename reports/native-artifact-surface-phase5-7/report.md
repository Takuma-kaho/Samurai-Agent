# Native Artifact Surface Phase 5–7 実装・検証報告

- 実施日: 2026-09-08、2026-09-09
- 対象計画: `plans/native-artifact-surface-plan-phase5-7.md`
- 作業ブランチ: `codex/phase5-react-app-replacement`
- 対象: Native Artifact Surface、Generated Surface interaction、Vue から React への置換、Desktop bridge と永続化

## 実装した重要な補正

- `workspace_completion_episodes` の旧 PostgreSQL 一意制約は、`external_episode_key` が `NULL` の Activity まで一意にしていた。新規の追記専用 migration v126 で旧制約を安全に除去し、非 `NULL` の外部キーだけを一意にする部分インデックスへ移行した。既存の外部エピソード重複防止は維持しつつ、複数 Artifact の Completion Activity を保存できる。
- Generated Surface の target command 結果を永続化前に JSON 化し、任意フィールドの `undefined` を保存対象から除外した。これにより、Artifact 作成 Action が副作用の後で署名検証エラーになる不整合を解消した。
- interaction 記録でも未指定の任意フィールドを明示的な `undefined` として渡さないようにし、HTTP・Domain・PostgreSQL の JSON 境界を一貫させた。
- 追記専用 migration v127 で、通常チャットにも残す Runtime binding と Human Work 専用 binding を分離した。Work 固有フィールドがない通常Runは保存を許可し、Work形状が不完全な binding は従来どおり拒否する。
- 通常チャットからの `create_artifact` は、存在しないHuman Work出所を要求しない。Work由来の場合だけServerが保存した出所をArtifact metadataへ付与する。
- PostgreSQL Artifactの現在ファイルは immutable revision を指すため、Runtime tool結果では論理Artifact参照とrevision参照を別々に返すようにした。Runtime履歴・Workspace Change・CompletionがArtifact本体を一貫して参照できる。

## 隔離した実API E2E

空の Docker PostgreSQL、専用ストレージ、Self-host Workspace Server を使用した。既存のDB、Desktop profile、Keychain、実ユーザーの認証情報には触れていない。正規 migration を適用後、Server を一度停止・再起動して同じ永続データを検証した。

- Markdown、Table、Image、PDF、Generated Surface を実APIで作成した。
- Markdown と Table を revision 2 へ更新した。Table は React editor と同じ JSON 文字列入力で検証した。
- Generated Surface の即時 Artifact 作成 Action を実行し、`201` で保存されることを確認した。
- 承認が必要な Action を accept して `completed` へ遷移すること、pin が `pinned` へ遷移することを確認した。
- Surface 更新後に旧 revision の承認を実行し、`generated_surface_revision_stale` で `failed` になることを確認した。
- 再起動後に Artifact 7件、Image 70 bytes、PDF 480 bytes、Surface の revision 2 と pin 状態、interaction の completed / stale failed 状態が復元されることを確認した。
- migration v126 と、`external_episode_key IS NOT NULL` に限定された一意インデックスが隔離DBに存在することを確認した。
- 検証後、E2E専用のDockerコンテナ、ストレージ、Desktop profile、Vite preview を削除・停止した。

## Gemini Provider E2E

- `.env` から読み込むNative primary providerが `gemini/gemini-3.5-flash` で、fallbackなしとして構成されることを確認した。APIキーの値は出力・保存していない。
- 隔離WorkspaceからGeminiへ実リクエストを送信し、Geminiが `create_artifact` を正しいprovider tool名・Domain operationで返すところまで確認した。この実行で通常チャットRuntime binding、Artifact出所、Artifact resource refの3不具合を発見し、上記のとおり修正した。
- 修正後の実Gemini呼び出しはGemini側HTTP `503`（`temporary_unavailable`）で失敗した。最終の実Gemini成功経路は外部サービスの一時利用不可により未確認であり、同一の無料枠リクエストを繰り返して成功扱いにはしていない。
- 外部送信を行わない隔離SSE E2Eでは、Geminiの `streamGenerateContent` 形式（function call + `STOP` + `[DONE]`）を用いて、Native → Artifact → Generated Surface → direct Surface Action → Artifact → Server再起動後の復元を成功確認した。
- 検証終了後、このGemini E2E専用のDockerコンテナと `/private/tmp` 配下の一時ストレージ・スクリプトを削除した。

## 2026-09-09 Desktop 実Gemini再検証

- 新しい Docker PostgreSQL、Workspace storage、Electron `--user-data-dir`、テスト用Account/Workspace/Roomだけを `/private/tmp` 配下に作成した。既存のDesktop profile、既存Workspace、既存DBは参照も更新もしなかった。
- Desktop のテスト用署名鍵は Electron `safeStorage`（macOS Keychain）で保護した。Gemini APIキーそのものは現行実装にDesktop Keychain保管・読出し経路がないため、隔離Serverの実行環境にだけ与えた。値はDesktop profile・PostgreSQL・報告書・ログに保存していない。
- fallbackなしの `gemini/gemini-3.5-flash` で、DesktopからSamurai Nativeの仕事を実行した。最終Run `run_c6c4defddbe048c4` は `completed / settled` となり、Gemini HTTP 503は発生しなかった。
- 実Geminiが返すprovider向けAction名 `create_artifact` を、保存前に正規のDomain command `artifact.create` へ一貫して正規化した。Surface HTML/CSS/JavaScriptの境界もprovider instructionへ明記し、通常の `function` を動的 `Function()` と誤判定しないようvalidatorを補正した。
- 画面内の生成済みSurfaceの実ボタンをクリックし、`Surface Action Artifact Final` が作成・表示され、本文 `Created by Surface action final` とrevision 1をDesktop画面で確認した。
- Surface ActionのUI UUIDは、下流のCompletion/Domain処理に渡す前に決定的な `surface_*` Operation IDへスコープするよう修正した。これにより、UI由来UUIDでもActionの副作用・Completion記録を同じidempotency境界で完了できる。
- 通常のアプリ終了後、同じ隔離profileでElectronを再起動した。完了済みのNative仕事履歴、Artifact、Surface revision 1、Surface内の見出しとボタンがすべてDesktop画面へ復元された。

## 自動検証結果

| 検証 | 結果 |
| --- | --- |
| focused Vitest（HTTP、interaction、schema） | 44 passed |
| `pnpm typecheck` | 成功 |
| `pnpm lint` | 成功（format 935、lint 816） |
| `pnpm test` | 1,205 passed、1 skipped |
| `pnpm core:domain-contracts:verify` | 成功 |
| `pnpm phase01:verify` | 成功（438 entries） |
| `pnpm core:test:generated-surface` | 成功 |
| `pnpm core:test:physical-boundaries` | 成功。Vue source は 0、Web runtime は React NativeApp |
| `pnpm desktop:verify` | 成功 |
| Gemini SSE契約隔離E2E | 成功。Artifact、Surface、direct action、再起動後の復元を確認 |
| Gemini実API | 成功。Desktop → Samurai Native → Gemini → Artifact/Generated Surface → Surface Action → Artifact を確認。最終Runに503なし |
| Web build / Desktop build | 成功 |
| `git diff --check` | 成功 |

Web build は 1,002.73 kB の単一 JavaScript chunk に対する Vite のサイズ警告を出したが、ビルド失敗ではない。Phase 5–7 の機能変更とは別の性能改善候補として扱う。

## 画面確認の補足と残る利用者確認

- Vite で起動した現在の React renderer をブラウザのアクセシビリティツリーで確認し、React NativeApp の未接続画面、接続項目、秘密鍵入力、接続ボタンが表示されることを確認した。
- 2026-09-08時点では、既存アプリと同一bundle IDのElectron画面を安全に識別できずUI操作を行わなかった。2026-09-09に専用profileと専用Accountを用意したことで、この制約を解消して実Desktop操作を実施した。
- Gemini HTTP 503による未確認状態は、2026-09-09の実Gemini成功Runで解消した。公式Codex / Claude Codeの実機認証は依然として利用者側の確認対象である。

### 2026-09-09 時点の残る利用者確認

- Codex Cloudの外部連携フロー。
- UIの見た目・操作感・確認ダイアログなどの最終UX確認。
- 上記以外のNative+Gemini、Artifact/Surface Action、再起動後の永続化は、隔離Desktop環境で実施済み。検証後、この追加E2E用Dockerコンテナ、storage、Electron profile、Vite/Serverプロセスを削除済み。
