import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { supportedLocales, type SupportedLocale } from "@samurai-agent/core-schemas";
import type { DesktopWorkspaceConnection } from "../lib/api";
import {
  nativeThemeDefault,
  nativeThemes,
  normalizeNativeTheme,
  type NativeTheme
} from "../lib/native-app-theme-preferences";
import type {
  NativeAccountPreferences,
  NativeAccountPreferencesInput
} from "../lib/native-account-preferences";
import {
  nativeAccountLocaleLabels,
  nativeAccountSettingsCategories,
  nativeAccountSettingsCategoryLabels,
  nativeAccountSettingsConnectionStateLabel,
  nativeAccountSettingsDraft,
  nativeAccountSettingsDirtyFormLabel,
  nativeAccountSettingsHasErrors,
  nativeAccountSettingsIsProfileDirty,
  nativeAccountSettingsIsResponsesDirty,
  nativeAccountSettingsNavigationDecision,
  nativeAccountSettingsPreferenceErrorMessage,
  nativeAccountSettingsProfileInput,
  nativeAccountSettingsValidateProfile,
  nativeAccountSettingsValidateResponses,
  type NativeAccountConnectionReflectionState,
  type NativeAccountSettingsCategory,
  type NativeAccountSettingsDraft
} from "./native-account-settings-helpers";

export interface NativeAccountPreferencesStore {
  load: (accountId: string, registeredDisplayName: string) => Promise<NativeAccountPreferences>;
  save: (accountId: string, expectedRevision: number, input: NativeAccountPreferencesInput) => Promise<NativeAccountPreferences>;
}

export interface NativeAccountConnectionReflection {
  connectionId: string;
  state: NativeAccountConnectionReflectionState;
  error?: string;
}

export interface NativeAccountSettingsProps {
  accountId: string;
  registeredDisplayName?: string;
  initialPreferences?: NativeAccountPreferences;
  /** Parent supplies the existing IndexedDB Account preferences store. */
  preferencesStore?: NativeAccountPreferencesStore;
  preferencesLoading?: boolean;
  preferencesError?: string | null;
  onRetryPreferences?: () => void | Promise<void>;
  onPreferencesSaved?: (preferences: NativeAccountPreferences) => void;
  theme?: NativeTheme;
  /** Parent applies the already-allowlisted theme without remounting the app. */
  onThemeChange: (theme: NativeTheme) => void | Promise<void>;
  connections?: readonly DesktopWorkspaceConnection[];
  connectionReflections?: readonly NativeAccountConnectionReflection[];
  connectionsLoading?: boolean;
  connectionsError?: string | null;
  onRetryConnection?: (connectionId: string) => void | Promise<void>;
  onManageConnection?: (connectionId: string) => void;
  initialCategory?: NativeAccountSettingsCategory;
  onCategoryChange?: (category: NativeAccountSettingsCategory) => void;
  onCopyAccountId?: (accountId: string) => void | Promise<void>;
  onBack: () => void;
}

type FormKind = "profile" | "responses";
type Feedback = { kind: "success" | "error" | "notice"; message: string };
type PendingNavigation =
  | { kind: "back" }
  | { kind: "category"; category: NativeAccountSettingsCategory };

const emptyConnections: readonly DesktopWorkspaceConnection[] = [];
const emptyReflections: readonly NativeAccountConnectionReflection[] = [];

export function NativeAccountSettings({
  accountId,
  registeredDisplayName = "本人",
  initialPreferences,
  preferencesStore,
  preferencesLoading = false,
  preferencesError,
  onRetryPreferences,
  onPreferencesSaved,
  theme = nativeThemeDefault,
  onThemeChange,
  connections = emptyConnections,
  connectionReflections = emptyReflections,
  connectionsLoading = false,
  connectionsError,
  onRetryConnection,
  onManageConnection,
  initialCategory = "profile",
  onCategoryChange,
  onCopyAccountId,
  onBack
}: NativeAccountSettingsProps) {
  const loadFromStore = preferencesStore?.load;
  const saveToStore = preferencesStore?.save;
  const [category, setCategory] = useState<NativeAccountSettingsCategory>(initialCategory);
  const [storedPreferences, setStoredPreferences] = useState<NativeAccountPreferences | undefined>(initialPreferences);
  const storedPreferencesRef = useRef<NativeAccountPreferences | undefined>(initialPreferences);
  const [draft, setDraft] = useState<NativeAccountSettingsDraft>(() => nativeAccountSettingsDraft(initialPreferences, registeredDisplayName));
  const draftRef = useRef(draft);
  const accountIdRef = useRef(accountId);
  const initialPreferencesRef = useRef(initialPreferences);
  const loadSequence = useRef(0);
  const [localLoading, setLocalLoading] = useState(Boolean(loadFromStore && !initialPreferences));
  const [localLoadError, setLocalLoadError] = useState<string | null>(null);
  const [savingForm, setSavingForm] = useState<FormKind | null>(null);
  const [profileFeedback, setProfileFeedback] = useState<Feedback | null>(null);
  const [responsesFeedback, setResponsesFeedback] = useState<Feedback | null>(null);
  const [profileValidationVisible, setProfileValidationVisible] = useState(false);
  const [responsesValidationVisible, setResponsesValidationVisible] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const [selectedTheme, setSelectedTheme] = useState<NativeTheme>(() => normalizeNativeTheme(theme));
  const [themeBusy, setThemeBusy] = useState(false);
  const [themeFeedback, setThemeFeedback] = useState<Feedback | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<Feedback | null>(null);

  const applyPreferences = useCallback((next: NativeAccountPreferences, preserveDirty: boolean): void => {
    const previous = storedPreferencesRef.current;
    const currentDraft = draftRef.current;
    const profileDirty = preserveDirty && nativeAccountSettingsIsProfileDirty(currentDraft, previous);
    const responsesDirty = preserveDirty && nativeAccountSettingsIsResponsesDirty(currentDraft, previous);
    const nextDraft: NativeAccountSettingsDraft = {
      displayName: profileDirty ? currentDraft.displayName : next.display_name,
      outputLocale: responsesDirty ? currentDraft.outputLocale : next.output_locale,
      instructions: responsesDirty ? currentDraft.instructions : next.instructions
    };
    storedPreferencesRef.current = next;
    draftRef.current = nextDraft;
    setStoredPreferences(next);
    setDraft(nextDraft);
  }, []);

  const resetForAccount = useCallback((next: NativeAccountPreferences | undefined): void => {
    const nextDraft = nativeAccountSettingsDraft(next, registeredDisplayName);
    storedPreferencesRef.current = next;
    draftRef.current = nextDraft;
    setStoredPreferences(next);
    setDraft(nextDraft);
    setProfileFeedback(null);
    setResponsesFeedback(null);
    setProfileValidationVisible(false);
    setResponsesValidationVisible(false);
    setPendingNavigation(null);
    setLocalLoadError(null);
  }, [registeredDisplayName]);

  const loadPreferences = useCallback(async (): Promise<void> => {
    if (!loadFromStore) {
      setLocalLoading(false);
      if (!storedPreferencesRef.current && !initialPreferences) {
        setLocalLoadError("設定を取得できません。親画面からAccount設定storeを接続してください。");
      }
      return;
    }
    const sequence = ++loadSequence.current;
    const requestedAccountId = accountId;
    setLocalLoading(true);
    setLocalLoadError(null);
    try {
      const result = await loadFromStore(requestedAccountId, registeredDisplayName);
      if (sequence !== loadSequence.current || accountIdRef.current !== requestedAccountId) return;
      applyPreferences(result, true);
    } catch (error) {
      if (sequence !== loadSequence.current || accountIdRef.current !== requestedAccountId) return;
      setLocalLoadError(nativeAccountSettingsPreferenceErrorMessage(error));
    } finally {
      if (sequence === loadSequence.current && accountIdRef.current === requestedAccountId) setLocalLoading(false);
    }
  }, [accountId, applyPreferences, initialPreferences, loadFromStore, registeredDisplayName]);

  useEffect(() => {
    const accountChanged = accountIdRef.current !== accountId;
    accountIdRef.current = accountId;
    if (accountChanged) {
      loadSequence.current += 1;
      resetForAccount(undefined);
    }
    void loadPreferences();
  }, [accountId, loadPreferences, resetForAccount]);

  useEffect(() => {
    if (initialPreferences === initialPreferencesRef.current) return;
    initialPreferencesRef.current = initialPreferences;
    if (initialPreferences) {
      setLocalLoadError(null);
      applyPreferences(initialPreferences, true);
    }
  }, [applyPreferences, initialPreferences]);

  useEffect(() => {
    setSelectedTheme(normalizeNativeTheme(theme));
  }, [theme]);

  const profileValidation = nativeAccountSettingsValidateProfile(draft);
  const responsesValidation = nativeAccountSettingsValidateResponses(draft);
  const profileDirty = nativeAccountSettingsIsProfileDirty(draft, storedPreferences);
  const responsesDirty = nativeAccountSettingsIsResponsesDirty(draft, storedPreferences);
  const loading = localLoading || preferencesLoading;
  const loadError = preferencesError ?? localLoadError;
  const formDisabled = loading || savingForm !== null || !storedPreferences;
  const navigationDecision = nativeAccountSettingsNavigationDecision({
    profileDirty,
    responsesDirty,
    saving: savingForm !== null,
    themeBusy
  });
  const navigationDisabled = navigationDecision === "blocked" || pendingNavigation !== null;
  const dirtyFormLabel = nativeAccountSettingsDirtyFormLabel(profileDirty, responsesDirty);

  const applyCategory = (next: NativeAccountSettingsCategory): void => {
    setCategory(next);
    onCategoryChange?.(next);
  };

  const requestCategory = (next: NativeAccountSettingsCategory): void => {
    if (next === category || navigationDisabled) return;
    if (navigationDecision === "confirm") {
      setPendingNavigation({ kind: "category", category: next });
      return;
    }
    applyCategory(next);
  };

  const requestBack = (): void => {
    if (navigationDisabled) return;
    if (navigationDecision === "confirm") {
      setPendingNavigation({ kind: "back" });
      return;
    }
    onBack();
  };

  const cancelNavigation = (): void => {
    // Deliberately clear only the pending intent.  The form drafts, category,
    // return context, Room, and stream are owned by the parent and remain
    // untouched when the user chooses to continue editing.
    setPendingNavigation(null);
  };

  const discardAndNavigate = (): void => {
    const pending = pendingNavigation;
    if (!pending || navigationDecision === "blocked") return;
    setPendingNavigation(null);
    if (pending.kind === "back") {
      onBack();
      return;
    }
    applyCategory(pending.category);
  };

  const updateDraft = (patch: Partial<NativeAccountSettingsDraft>): void => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
    if (Object.prototype.hasOwnProperty.call(patch, "displayName")) {
      setProfileFeedback(null);
      setProfileValidationVisible(false);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "outputLocale") || Object.prototype.hasOwnProperty.call(patch, "instructions")) {
      setResponsesFeedback(null);
      setResponsesValidationVisible(false);
    }
  };

  const commitSavedPreferences = (next: NativeAccountPreferences, form: FormKind): void => {
    const previous = storedPreferencesRef.current;
    const currentDraft = draftRef.current;
    const otherFormDirty = form === "profile"
      ? nativeAccountSettingsIsResponsesDirty(currentDraft, previous)
      : nativeAccountSettingsIsProfileDirty(currentDraft, previous);
    const nextDraft: NativeAccountSettingsDraft = form === "profile"
      ? {
        displayName: next.display_name,
        outputLocale: otherFormDirty ? currentDraft.outputLocale : next.output_locale,
        instructions: otherFormDirty ? currentDraft.instructions : next.instructions
      }
      : {
        displayName: otherFormDirty ? currentDraft.displayName : next.display_name,
        outputLocale: next.output_locale,
        instructions: next.instructions
      };
    storedPreferencesRef.current = next;
    draftRef.current = nextDraft;
    setStoredPreferences(next);
    setDraft(nextDraft);
    onPreferencesSaved?.(next);
  };

  const saveForm = async (form: FormKind): Promise<void> => {
    const current = storedPreferencesRef.current;
    if (!current || !saveToStore || savingForm !== null) return;
    const validation = form === "profile" ? profileValidation : responsesValidation;
    if (form === "profile") setProfileValidationVisible(true);
    else setResponsesValidationVisible(true);
    if (nativeAccountSettingsHasErrors(validation)) return;
    const currentDraft = draftRef.current;
    const input: NativeAccountPreferencesInput = {
      display_name: form === "profile" ? nativeAccountSettingsProfileInput(currentDraft) : current.display_name,
      output_locale: form === "responses" ? currentDraft.outputLocale : current.output_locale,
      instructions: form === "responses" ? currentDraft.instructions : current.instructions
    };
    setSavingForm(form);
    if (form === "profile") setProfileFeedback({ kind: "notice", message: "プロフィールを保存しています…" });
    else setResponsesFeedback({ kind: "notice", message: "回答設定を保存しています…" });
    try {
      const result = await saveToStore(accountId, current.revision, input);
      if (accountIdRef.current !== accountId) return;
      commitSavedPreferences(result, form);
      if (form === "profile") setProfileFeedback({ kind: "success", message: "プロフィールを保存しました。登録済みServerへ反映中です。" });
      else setResponsesFeedback({ kind: "success", message: "回答設定を保存しました。この端末の同じAccountで使用します。" });
    } catch (error) {
      const message = nativeAccountSettingsPreferenceErrorMessage(error);
      if (form === "profile") setProfileFeedback({ kind: "error", message });
      else setResponsesFeedback({ kind: "error", message });
    } finally {
      setSavingForm(null);
    }
  };

  const cancelForm = (form: FormKind): void => {
    const current = storedPreferencesRef.current;
    if (!current) return;
    const next = form === "profile"
      ? { ...draftRef.current, displayName: current.display_name }
      : { ...draftRef.current, outputLocale: current.output_locale, instructions: current.instructions };
    draftRef.current = next;
    setDraft(next);
    if (form === "profile") {
      setProfileFeedback(null);
      setProfileValidationVisible(false);
    } else {
      setResponsesFeedback(null);
      setResponsesValidationVisible(false);
    }
  };

  const chooseTheme = async (next: NativeTheme): Promise<void> => {
    if (themeBusy || next === selectedTheme) return;
    setSelectedTheme(next);
    setThemeBusy(true);
    setThemeFeedback({ kind: "notice", message: `${nativeThemes.find((item) => item.id === next)?.label ?? "テーマ"}を適用しています…` });
    try {
      await onThemeChange(next);
      setThemeFeedback({ kind: "success", message: "テーマをこの端末へ適用しました。進行中の仕事や入力はそのままです。" });
    } catch {
      setThemeFeedback({ kind: "error", message: "テーマの保存に失敗しました。この起動中のみ適用されている可能性があります。" });
    } finally {
      setThemeBusy(false);
    }
  };

  const copyAccountId = async (): Promise<void> => {
    if (!onCopyAccountId) return;
    setCopyFeedback(null);
    try {
      await onCopyAccountId(accountId);
      setCopyFeedback({ kind: "success", message: "Account IDをコピーしました。" });
    } catch {
      setCopyFeedback({ kind: "error", message: "Account IDをコピーできませんでした。" });
    }
  };

  const retryPreferences = async (): Promise<void> => {
    if (onRetryPreferences) {
      setLocalLoading(true);
      setLocalLoadError(null);
      try {
        await onRetryPreferences();
      } catch (error) {
        setLocalLoadError(nativeAccountSettingsPreferenceErrorMessage(error));
      } finally {
        setLocalLoading(false);
      }
      return;
    }
    await loadPreferences();
  };

  const reflections = new Map(connectionReflections.map((reflection) => [reflection.connectionId, reflection]));
  const renderFeedback = (feedback: Feedback | null): React.ReactNode => feedback
    ? <p className={`native-account-settings__feedback is-${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.message}</p>
    : null;

  return <>
    <style>{nativeAccountSettingsStyles}</style>
    <div className="native-account-settings">
      <header className="native-account-settings__header">
        <div>
          <span className="native-account-settings__eyebrow">アカウント</span>
          <h1 id="native-account-settings-title">設定</h1>
          <p>表示名と回答設定は、このAccountの端末内設定として管理します。</p>
        </div>
        <button className="native-account-settings__back" type="button" onClick={requestBack} disabled={navigationDisabled} aria-label="設定を閉じて元の画面へ戻る">戻る</button>
      </header>

      <div className="native-account-settings__mobile-category">
        <label htmlFor="native-account-settings-category-mobile">設定カテゴリ</label>
        <select id="native-account-settings-category-mobile" value={category} onChange={(event) => requestCategory(event.currentTarget.value as NativeAccountSettingsCategory)} disabled={navigationDisabled}>
          {nativeAccountSettingsCategories.map((item) => <option key={item} value={item}>{nativeAccountSettingsCategoryLabels[item]}</option>)}
        </select>
      </div>

      <div className="native-account-settings__layout">
        <nav className="native-account-settings__nav" aria-label="設定カテゴリ">
          {nativeAccountSettingsCategories.map((item) => <button
            key={item}
            type="button"
            className={category === item ? "is-selected" : undefined}
            aria-current={category === item ? "page" : undefined}
            onClick={() => requestCategory(item)}
            disabled={navigationDisabled}
          >{nativeAccountSettingsCategoryLabels[item]}</button>)}
        </nav>

        <main className="native-account-settings__detail" aria-labelledby="native-account-settings-title">
          <div className="native-account-settings__status" aria-live="polite">
            {loading ? <p role="status">設定を読み込んでいます…</p> : null}
            {loadError ? <p className="is-error" role="alert">{loadError}</p> : null}
            {loadError || (!storedPreferences && !loading) ? <button className="native-account-settings__quiet-button" type="button" onClick={() => void retryPreferences()} disabled={loading}>最新値を読み直す</button> : null}
          </div>

          {category === "profile" ? <section className="native-account-settings__section" aria-labelledby="native-account-settings-profile-title">
            <div className="native-account-settings__section-heading"><div><span className="native-account-settings__eyebrow">Profile</span><h2 id="native-account-settings-profile-title">プロフィール</h2><p>表示名だけを各登録済みServerへ反映します。個人指示はここへ複写しません。</p></div></div>
            <form className="native-account-settings__card" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void saveForm("profile"); }}>
              <label className="native-account-settings__field" htmlFor="native-account-settings-display-name"><span>表示名</span><input id="native-account-settings-display-name" value={draft.displayName} onChange={(event) => updateDraft({ displayName: event.currentTarget.value })} disabled={formDisabled} maxLength={200} autoComplete="name" aria-invalid={profileValidationVisible && Boolean(profileValidation.displayName)} aria-describedby={profileValidation.displayName && profileValidationVisible ? "native-account-settings-display-name-error" : undefined} /></label>
              {profileValidationVisible && profileValidation.displayName ? <p className="native-account-settings__field-error" id="native-account-settings-display-name-error" role="alert">{profileValidation.displayName}</p> : null}
              <div className="native-account-settings__readonly-row"><span>Account ID</span><code>{accountId}</code>{onCopyAccountId ? <button className="native-account-settings__quiet-button" type="button" onClick={() => void copyAccountId()} disabled={loading}>コピー</button> : null}</div>
              {renderFeedback(copyFeedback)}
              <p className="native-account-settings__note">端末に保存した表示名を、接続ごとの状態で確認できます。</p>
              <div className="native-account-settings__actions"><button className="native-account-settings__quiet-button" type="button" onClick={() => cancelForm("profile")} disabled={formDisabled || !profileDirty}>取消</button><button className="native-account-settings__primary-button" type="submit" disabled={formDisabled || !profileDirty || nativeAccountSettingsHasErrors(profileValidation)}>{savingForm === "profile" ? "保存中…" : "保存"}</button></div>
              {renderFeedback(profileFeedback)}
            </form>
          </section> : null}

          {category === "responses" ? <section className="native-account-settings__section" aria-labelledby="native-account-settings-responses-title">
            <div className="native-account-settings__section-heading"><div><span className="native-account-settings__eyebrow">Responses</span><h2 id="native-account-settings-responses-title">回答設定</h2><p>次に開始する依頼へ適用します。保存先はこの端末の同じAccountで、Client間同期は行いません。</p></div></div>
            <form className="native-account-settings__card" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void saveForm("responses"); }}>
              <label className="native-account-settings__field" htmlFor="native-account-settings-output-locale"><span>回答言語</span><select id="native-account-settings-output-locale" value={draft.outputLocale ?? ""} onChange={(event) => { const value = event.currentTarget.value; updateDraft({ outputLocale: value === "" ? null : value as SupportedLocale }); }} disabled={formDisabled}>{supportedLocales.map((locale) => <option key={locale} value={locale}>{nativeAccountLocaleLabels[locale] ?? locale}</option>)}</select></label>
              <label className="native-account-settings__field" htmlFor="native-account-settings-instructions"><span>個人指示</span><textarea id="native-account-settings-instructions" value={draft.instructions} onChange={(event) => updateDraft({ instructions: event.currentTarget.value })} disabled={formDisabled} maxLength={20_000} aria-invalid={responsesValidationVisible && Boolean(responsesValidation.instructions)} aria-describedby={responsesValidation.instructions && responsesValidationVisible ? "native-account-settings-instructions-error" : undefined} /></label>
              <div className="native-account-settings__character-count">{draft.instructions.length.toLocaleString()} / 20,000文字</div>
              {responsesValidationVisible && responsesValidation.instructions ? <p className="native-account-settings__field-error" id="native-account-settings-instructions-error" role="alert">{responsesValidation.instructions}</p> : null}
              <p className="native-account-settings__note">保存済みの設定は実行開始時だけ参照され、公開会話・共有内容へコピーされません。</p>
              <div className="native-account-settings__actions"><button className="native-account-settings__quiet-button" type="button" onClick={() => cancelForm("responses")} disabled={formDisabled || !responsesDirty}>取消</button><button className="native-account-settings__primary-button" type="submit" disabled={formDisabled || !responsesDirty || nativeAccountSettingsHasErrors(responsesValidation)}>{savingForm === "responses" ? "保存中…" : "保存"}</button></div>
              {renderFeedback(responsesFeedback)}
            </form>
          </section> : null}

          {category === "appearance" ? <section className="native-account-settings__section" aria-labelledby="native-account-settings-appearance-title">
            <div className="native-account-settings__section-heading"><div><span className="native-account-settings__eyebrow">Appearance</span><h2 id="native-account-settings-appearance-title">外観</h2><p>テーマはこの端末へ即時反映します。チャットや進行中の仕事を作り直しません。</p></div></div>
            <div className="native-account-settings__theme-grid" role="radiogroup" aria-label="テーマを選択">
              {nativeThemes.map((item) => <button key={item.id} type="button" role="radio" aria-checked={selectedTheme === item.id} className={`native-account-settings__theme-card${selectedTheme === item.id ? " is-selected" : ""}`} onClick={() => void chooseTheme(item.id)} disabled={themeBusy}>
                <span className={`native-account-settings__theme-swatch is-${item.id}`} aria-hidden="true"><span /></span><span><strong>{item.code} · {item.label}</strong><small>{item.description}</small></span>{selectedTheme === item.id ? <span className="native-account-settings__theme-check" aria-hidden="true">✓</span> : null}
              </button>)}
            </div>
            <p className="native-account-settings__note">テーマは「この端末で使用」します。Accountの回答設定やWorkspaceの設定とは別に保存します。</p>
            {renderFeedback(themeFeedback)}
          </section> : null}

          {category === "connections" ? <section className="native-account-settings__section" aria-labelledby="native-account-settings-connections-title">
            <div className="native-account-settings__section-heading"><div><span className="native-account-settings__eyebrow">Connections</span><h2 id="native-account-settings-connections-title">接続</h2><p>登録済み接続と表示名の反映状況を確認します。資格情報や秘密鍵は表示しません。</p></div></div>
            {connectionsLoading ? <p className="native-account-settings__status" role="status">接続状態を確認しています…</p> : null}
            {connectionsError ? <div className="native-account-settings__status is-error" role="alert">{connectionsError}</div> : null}
            {!connectionsLoading && !connectionsError && connections.length === 0 ? <p className="native-account-settings__empty" role="status">登録済み接続はありません。</p> : null}
            {connections.length > 0 ? <ul className="native-account-settings__connection-list" aria-label="登録済み接続一覧">
              {connections.map((connection) => {
                const reflection = reflections.get(connection.id);
                const state = reflection?.state ?? "unknown";
                return <li key={connection.id} className="native-account-settings__connection-item">
                  <div><strong>{connection.label || "名前未設定"}</strong><span>{connection.serverUrl}</span><small>Account: {connection.accountId}</small></div>
                  <div className="native-account-settings__connection-state"><span className={`is-${state}`}>{nativeAccountSettingsConnectionStateLabel(state)}</span>{reflection?.error ? <small>{reflection.error}</small> : null}{(state === "failed" || state === "offline") && onRetryConnection ? <button className="native-account-settings__quiet-button" type="button" onClick={() => void onRetryConnection(connection.id)}>再確認</button> : null}{onManageConnection ? <button className="native-account-settings__quiet-button" type="button" onClick={() => onManageConnection(connection.id)}>接続設定</button> : null}</div>
                </li>;
              })}
            </ul> : null}
          </section> : null}
        </main>
      </div>
    </div>
    {pendingNavigation ? <div className="native-account-settings__navigation-prompt" role="alertdialog" aria-modal="true" aria-labelledby="native-account-settings-navigation-title" aria-describedby="native-account-settings-navigation-description">
      <div className="native-account-settings__navigation-prompt-card">
        <h2 id="native-account-settings-navigation-title">未保存の変更があります</h2>
        <p id="native-account-settings-navigation-description">{dirtyFormLabel}に未保存の入力があります。保存せずに{pendingNavigation.kind === "back" ? "戻りますか" : "カテゴリを移動しますか"}。</p>
        <div className="native-account-settings__actions">
          <button className="native-account-settings__danger-button" type="button" onClick={discardAndNavigate} disabled={navigationDecision === "blocked"}>保存せず{pendingNavigation.kind === "back" ? "戻る" : "移動"}</button>
          <button className="native-account-settings__quiet-button" type="button" onClick={cancelNavigation} disabled={navigationDecision === "blocked"}>編集を続ける</button>
        </div>
      </div>
    </div> : null}
  </>;
}

export default NativeAccountSettings;

const nativeAccountSettingsStyles = `
.native-account-settings {
  --nas-ink: var(--native-copy, #eeeeee);
  --nas-muted: var(--native-muted, #b2b2b2);
  --nas-dim: var(--native-dim, #858585);
  --nas-line: var(--native-line, rgba(255, 255, 255, .09));
  --nas-line-strong: var(--native-line-strong, rgba(255, 255, 255, .18));
  --nas-panel: var(--native-surface, #171717);
  --nas-panel-soft: var(--native-surface-raised, #222222);
  --nas-accent: var(--native-accent, #d6d6d6);
  --nas-accent-rgb: var(--native-accent-rgb, 214, 214, 214);
  --nas-accent-ink: var(--native-accent-ink, #171717);
  --nas-success: var(--native-success, #bdbdbd);
  --nas-danger: var(--native-danger, #ee8981);
  background: var(--nas-panel);
  box-sizing: border-box;
  color: var(--nas-ink);
  display: flex;
  flex-direction: column;
  font-size: 13px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.native-account-settings *, .native-account-settings *::before, .native-account-settings *::after { box-sizing: border-box; }
.native-account-settings__header { align-items: center; border-bottom: 1px solid var(--nas-line); display: flex; gap: 16px; justify-content: space-between; padding: 22px 28px 18px; }
.native-account-settings__header h1 { font-family: inherit; font-size: 18px; font-weight: 600; letter-spacing: -.01em; line-height: 1.3; margin: 4px 0 6px; }
.native-account-settings__header p, .native-account-settings__section-heading p, .native-account-settings__note { color: var(--nas-muted); font-size: 12px; line-height: 1.55; margin: 0; max-width: 58rem; }
.native-account-settings__eyebrow { color: var(--nas-muted); display: block; font-size: 11px; font-weight: 600; letter-spacing: .04em; }
.native-account-settings__back { background: transparent; border: 1px solid var(--nas-line-strong); border-radius: 7px; color: var(--nas-muted); cursor: pointer; font: inherit; font-size: 12px; min-height: 32px; padding: 6px 10px; }
.native-account-settings__back:hover, .native-account-settings__back:focus-visible { background: rgba(var(--nas-accent-rgb), .08); color: var(--nas-ink); }
.native-account-settings__layout { display: grid; flex: 1; grid-template-columns: minmax(160px, 200px) minmax(0, 1fr); min-height: 0; }
.native-account-settings__nav { border-right: 1px solid var(--nas-line); display: grid; align-content: start; gap: 2px; padding: 22px 12px; }
.native-account-settings__nav button { background: transparent; border: 1px solid transparent; border-radius: 7px; color: var(--nas-muted); cursor: pointer; font: inherit; font-size: 13px; min-height: 34px; padding: 7px 10px; text-align: left; }
.native-account-settings__nav button:hover { background: rgba(var(--nas-accent-rgb), .06); color: var(--nas-ink); }
.native-account-settings__nav button.is-selected { background: rgba(var(--nas-accent-rgb), .11); border-color: var(--nas-line); color: var(--nas-ink); font-weight: 600; }
.native-account-settings__mobile-category { display: none; }
.native-account-settings__detail { min-width: 0; overflow: auto; padding: 24px 28px 42px; }
.native-account-settings__section { margin: 0 auto; max-width: 760px; }
.native-account-settings__section-heading { border-bottom: 1px solid var(--nas-line); margin-bottom: 16px; padding-bottom: 14px; }
.native-account-settings__section-heading h2 { font-family: inherit; font-size: 16px; font-weight: 600; letter-spacing: -.01em; line-height: 1.35; margin: 5px 0 6px; }
.native-account-settings__card { background: var(--nas-panel-soft); border: 1px solid var(--nas-line); border-radius: 10px; padding: 16px; }
.native-account-settings__field { display: grid; gap: 6px; margin-top: 13px; }
.native-account-settings__field:first-child { margin-top: 0; }
.native-account-settings__field > span, .native-account-settings__readonly-row > span { color: var(--nas-muted); font-size: 12px; font-weight: 600; }
.native-account-settings__field input, .native-account-settings__field select, .native-account-settings__field textarea { background: rgba(0, 0, 0, .12); border: 1px solid var(--nas-line-strong); border-radius: 7px; color: var(--nas-ink); font: inherit; font-size: 13px; min-width: 0; padding: 8px 10px; width: 100%; }
.native-account-settings__field input:focus-visible, .native-account-settings__field select:focus-visible, .native-account-settings__field textarea:focus-visible, .native-account-settings__nav button:focus-visible, .native-account-settings__back:focus-visible, .native-account-settings__theme-card:focus-visible, .native-account-settings__quiet-button:focus-visible, .native-account-settings__primary-button:focus-visible, .native-account-settings__danger-button:focus-visible, .native-account-settings__connection-state button:focus-visible { outline: 2px solid var(--nas-accent); outline-offset: 2px; }
.native-account-settings__field textarea { line-height: 1.6; min-height: 160px; resize: vertical; }
.native-account-settings__field input[aria-invalid="true"], .native-account-settings__field textarea[aria-invalid="true"] { border-color: var(--nas-danger); }
.native-account-settings__readonly-row { align-items: center; border-top: 1px solid var(--nas-line); display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; padding-top: 13px; }
.native-account-settings__readonly-row code { background: rgba(0, 0, 0, .15); border: 1px solid var(--nas-line); border-radius: 6px; color: var(--nas-ink); font-size: 11px; overflow-wrap: anywhere; padding: 6px 8px; }
.native-account-settings__character-count { color: var(--nas-dim); font-size: 11px; margin-top: 5px; text-align: right; }
.native-account-settings__field-error { color: var(--nas-danger); font-size: 11px; line-height: 1.45; margin: 5px 0 0; }
.native-account-settings__actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.native-account-settings__primary-button, .native-account-settings__quiet-button, .native-account-settings__danger-button { border-radius: 7px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600; min-height: 32px; padding: 6px 10px; }
.native-account-settings__primary-button { background: var(--nas-accent); border: 1px solid var(--nas-accent); color: var(--nas-accent-ink); }
.native-account-settings__quiet-button { background: transparent; border: 1px solid var(--nas-line-strong); color: var(--nas-muted); }
.native-account-settings__danger-button { background: transparent; border: 1px solid rgba(238, 137, 129, .55); color: var(--nas-danger); }
.native-account-settings__primary-button:hover, .native-account-settings__quiet-button:hover { filter: brightness(1.08); }
.native-account-settings button:disabled, .native-account-settings input:disabled, .native-account-settings select:disabled, .native-account-settings textarea:disabled { cursor: not-allowed; opacity: .5; }
.native-account-settings__feedback { border-radius: 7px; font-size: 12px; line-height: 1.5; margin: 12px 0 0; padding: 8px 10px; }
.native-account-settings__feedback.is-success { background: rgba(var(--nas-accent-rgb), .08); border: 1px solid rgba(var(--nas-accent-rgb), .25); color: var(--nas-success); }
.native-account-settings__feedback.is-error { background: rgba(238, 137, 129, .1); border: 1px solid rgba(238, 137, 129, .34); color: var(--nas-danger); }
.native-account-settings__feedback.is-notice { background: rgba(var(--nas-accent-rgb), .08); border: 1px solid rgba(var(--nas-accent-rgb), .25); color: var(--nas-accent); }
.native-account-settings__status { color: var(--nas-muted); font-size: 12px; line-height: 1.5; margin: 0 0 14px; }
.native-account-settings__status.is-error { color: var(--nas-danger); }
.native-account-settings__status + .native-account-settings__quiet-button { margin-bottom: 16px; }
.native-account-settings__theme-grid { display: grid; gap: 8px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.native-account-settings__theme-card { align-items: center; background: var(--nas-panel-soft); border: 1px solid var(--nas-line); border-radius: 9px; color: inherit; cursor: pointer; display: grid; gap: 8px; min-width: 0; padding: 12px; position: relative; text-align: left; }
.native-account-settings__theme-card:hover { background: rgba(var(--nas-accent-rgb), .06); border-color: var(--nas-line-strong); }
.native-account-settings__theme-card.is-selected { border-color: var(--nas-accent); }
.native-account-settings__theme-card strong { display: block; font-size: 12px; }
.native-account-settings__theme-card small { color: var(--nas-muted); display: block; font-size: 11px; line-height: 1.45; margin-top: 4px; }
.native-account-settings__theme-swatch { align-items: center; border: 1px solid var(--nas-line-strong); border-radius: 7px; display: flex; height: 40px; justify-content: center; overflow: hidden; position: relative; width: 100%; }
.native-account-settings__theme-swatch::before, .native-account-settings__theme-swatch::after, .native-account-settings__theme-swatch span { border-radius: 999px; content: ""; display: block; position: absolute; }
.native-account-settings__theme-swatch::before { height: 44px; left: -10%; opacity: .8; top: -16px; transform: rotate(-15deg); width: 120%; }
.native-account-settings__theme-swatch::after { bottom: 6px; height: 6px; left: 12%; width: 55%; }
.native-account-settings__theme-swatch span { height: 6px; right: 12%; width: 22%; }
.native-account-settings__theme-swatch.is-dark { background: #202020; }
.native-account-settings__theme-swatch.is-dark::before { background: #343434; }
.native-account-settings__theme-swatch.is-dark::after, .native-account-settings__theme-swatch.is-dark span { background: #d6d6d6; }
.native-account-settings__theme-swatch.is-light { background: #f2f2f2; }
.native-account-settings__theme-swatch.is-light::before { background: #d6d6d6; }
.native-account-settings__theme-swatch.is-light::after, .native-account-settings__theme-swatch.is-light span { background: #5b5b5b; }
.native-account-settings__theme-swatch.is-special { background: #000; }
.native-account-settings__theme-swatch.is-special::before { background: #252525; }
.native-account-settings__theme-swatch.is-special::after, .native-account-settings__theme-swatch.is-special span { background: #f0f0f0; }
.native-account-settings__theme-check { color: var(--nas-accent); font-size: 14px; position: absolute; right: 9px; top: 8px; }
.native-account-settings__empty { border: 1px dashed var(--nas-line-strong); border-radius: 9px; color: var(--nas-dim); font-size: 12px; margin: 0; padding: 14px; }
.native-account-settings__connection-list { display: grid; gap: 8px; list-style: none; margin: 0; padding: 0; }
.native-account-settings__connection-item { align-items: flex-start; background: var(--nas-panel-soft); border: 1px solid var(--nas-line); border-radius: 9px; display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) minmax(140px, auto); padding: 12px; }
.native-account-settings__connection-item > div:first-child { display: grid; gap: 4px; min-width: 0; }
.native-account-settings__connection-item strong { font-size: 13px; }
.native-account-settings__connection-item span, .native-account-settings__connection-item small { color: var(--nas-muted); font-size: 11px; overflow-wrap: anywhere; }
.native-account-settings__connection-state { align-items: flex-end; display: flex; flex-direction: column; gap: 5px; text-align: right; }
.native-account-settings__connection-state > span { border-radius: 999px; font-size: 10px; font-weight: 700; padding: 3px 7px; }
.native-account-settings__connection-state > span.is-synced { background: rgba(var(--nas-accent-rgb), .1); color: var(--nas-success); }
.native-account-settings__connection-state > span.is-pending { background: rgba(var(--nas-accent-rgb), .1); color: var(--nas-accent); }
.native-account-settings__connection-state > span.is-failed, .native-account-settings__connection-state > span.is-offline { background: rgba(238, 137, 129, .12); color: var(--nas-danger); }
.native-account-settings__connection-state > span.is-unknown { background: rgba(255, 255, 255, .06); color: var(--nas-muted); }
.native-account-settings__connection-state small { max-width: 210px; }
.native-account-settings__navigation-prompt { align-items: center; background: rgba(0, 0, 0, .62); display: flex; inset: 0; justify-content: center; padding: 24px; position: fixed; z-index: 20; }
.native-account-settings__navigation-prompt-card { background: var(--nas-panel-soft); border: 1px solid var(--nas-line-strong); border-radius: 10px; max-width: 460px; padding: 18px; width: 100%; }
.native-account-settings__navigation-prompt-card h2 { font-size: 16px; margin: 0; }
.native-account-settings__navigation-prompt-card p { color: var(--nas-muted); font-size: 12px; line-height: 1.6; margin: 10px 0 0; }
@media (max-width: 720px) { .native-account-settings__header { padding: 20px 18px 16px; } .native-account-settings__layout { display: block; } .native-account-settings__nav { display: none; } .native-account-settings__mobile-category { display: grid; gap: 6px; padding: 14px 18px 0; } .native-account-settings__mobile-category label { color: var(--nas-muted); font-size: 11px; font-weight: 600; } .native-account-settings__mobile-category select { background: var(--nas-panel-soft); border: 1px solid var(--nas-line-strong); border-radius: 7px; color: var(--nas-ink); font: inherit; font-size: 13px; min-height: 32px; padding: 7px 9px; } .native-account-settings__detail { padding: 20px 18px 36px; } .native-account-settings__theme-grid { grid-template-columns: 1fr; } .native-account-settings__connection-item { grid-template-columns: 1fr; } .native-account-settings__connection-state { align-items: flex-start; text-align: left; } }
`;
