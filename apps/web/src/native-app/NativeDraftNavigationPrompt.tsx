import type { NativeDraftNavigationController } from "./use-native-draft-navigation";

const defaultSaveFailure = "保存に失敗しました。下書きを保持しています。もう一度保存してください。";

export function NativeDraftNavigationPrompt({ controller }: { controller: NativeDraftNavigationController }) {
  const state = controller.getState();
  if (!state.pending) return null;
  const saving = state.phase === "saving";
  const failed = state.phase === "save_failed";
  const title = saving
    ? state.label + "を保存中です"
    : failed
      ? state.label + "の保存に失敗しました"
      : state.dirty
        ? state.label + "の未保存下書きがあります"
        : state.label + "を保存しました";
  const description = saving
    ? "保存が完了するまで、下書きと移動先を保持します。"
    : failed
      ? (state.saveError ?? defaultSaveFailure) + " 内容を確認して、もう一度保存するか破棄してください。"
      : state.dirty
        ? "移動する前に、下書きを保存または破棄してください。"
        : "保存が完了しました。選んだ操作を実行できます。";
  return <section className="native-draft-navigation-prompt" role="dialog" aria-modal="true" aria-label={state.label + "の下書き"}>
    <strong>{title}</strong>
    <p>{description}</p>
    {!state.canSave && !saving ? <p className="native-inline-error" role="alert">{state.saveUnavailableMessage ?? "この下書きは保存できません。破棄するか、権限を確認してください。"}</p> : null}
    <div className="native-dialog-actions">
      <button type="button" className="native-button native-button-primary" onClick={() => void controller.saveAndNavigate()} disabled={saving || !state.canSave}>保存して移動</button>
      <button type="button" className="native-button native-button-quiet" onClick={() => controller.discardAndNavigate()} disabled={saving}>破棄して移動</button>
      <button type="button" className="native-button native-button-quiet" onClick={() => controller.cancelNavigation()}>キャンセル</button>
    </div>
  </section>;
}
