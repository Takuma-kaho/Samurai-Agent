# Core08 Session依存分類

状態: **実装・検証済み**

| 分類 | 現在の代表箇所 | Core08での扱い |
| --- | --- | --- |
| A: 任意SessionRef | `TrustedDomainContext.sessionRef`、Operation／Runの`session_ref_json` | 任意出所として維持。認可根拠には使わない。 |
| B: Native App既存Chat互換 | Session付きDomain Command、既存Chat操作 | Sessionから信頼済みRoom／Principalを解決して新Coreへ一方向接続する。 |
| C: 保存のための偽Session | Artifactの`ensureArtifactSession`／Envelope、Collectionの`ensureSession`／Envelope | 削除する。SessionなしのTrusted Contextと`inputSummary`を使う。 |
| D: SessionからRoom権限を逆算 | Generated Surface actionとSession経由一覧 | `resource_access_boundaries`とRoom再認可に置換する。 |
| E: Chat表示・Session一覧・再開状態 | Message presentation、Native App session history | Native App側の対象外として維持する。 |

一括置換やSession関連コードの全面削除はしない。A・B・Eは互換のため残し、C・DだけをCore08のMutation／認可境界から除く。

確認結果: Artifact・Collectionの主要MutationとGenerated Surfaceのcreate／revise／actionはC・Dを通らない。Session付きNative App経路はBとして新Coreへ一方向に渡し、Chat表示・Session一覧はEとして変更していない。
