import { useEffect, useRef, useState } from "react";

export type NativeDraftNavigationPhase = "clean" | "unsaved" | "saving" | "save_failed";

export interface NativeDraftNavigationState {
  label: string;
  phase: NativeDraftNavigationPhase;
  dirty: boolean;
  saving: boolean;
  pending: boolean;
  canSave: boolean;
  saveError?: string;
  saveUnavailableMessage?: string;
}

export interface NativeDraftNavigationStateInput {
  scopeKey: string;
  label: string;
  dirty: boolean;
  saving: boolean;
  saveError?: string | null;
  canSave?: boolean;
  saveUnavailableMessage?: string;
}

export type NativeDraftNavigationTarget = () => void | Promise<void>;
export type NativeDraftSave = () => boolean | void | Promise<boolean | void>;
export type NativeDraftDiscard = () => void;

export interface NativeDraftNavigationController {
  readonly scopeKey: string;
  getState: () => NativeDraftNavigationState;
  requestNavigation: (target: NativeDraftNavigationTarget) => boolean;
  saveAndNavigate: () => Promise<boolean>;
  discardAndNavigate: () => boolean;
  cancelNavigation: () => void;
  updateState: (state: NativeDraftNavigationStateInput) => void;
  subscribe: (listener: () => void) => () => void;
}

export type NativeDraftNavigationControllerChange = (
  controller: NativeDraftNavigationController | undefined
) => void | (() => void);

export interface UseNativeDraftNavigationOptions extends NativeDraftNavigationStateInput {
  save?: NativeDraftSave;
  discard?: NativeDraftDiscard;
  /** Registers one controller instance and may return its instance-specific detach. */
  onControllerChange?: NativeDraftNavigationControllerChange;
}

export interface NativeDraftNavigationControllerOptions extends NativeDraftNavigationStateInput {
  save?: NativeDraftSave;
  discard?: NativeDraftDiscard;
}

type ControllerConfig = NativeDraftNavigationControllerOptions & {
  save?: NativeDraftSave;
  discard: NativeDraftDiscard;
};

const defaultSaveFailure = "保存に失敗しました。下書きを保持しています。もう一度保存してください。";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return defaultSaveFailure;
}

function navigationTarget(target: NativeDraftNavigationTarget): void {
  try {
    const result = target();
    if (result && typeof (result as Promise<void>).catch === "function") {
      void result.catch(() => undefined);
    }
  } catch {
    // Navigation errors belong to the destination's existing error surface.
  }
}

class NativeDraftNavigationControllerImpl implements NativeDraftNavigationController {
  private config: ControllerConfig;
  private pendingTarget: NativeDraftNavigationTarget | undefined;
  private localSaveError: string | undefined;
  private localSaving = false;
  private listeners = new Set<() => void>();

  public constructor(input: ControllerConfig) {
    this.config = input;
  }

  public get scopeKey(): string {
    return this.config.scopeKey;
  }

  public getState(): NativeDraftNavigationState {
    const saving = this.config.saving || this.localSaving;
    const saveError = this.config.saveError?.trim() || this.localSaveError;
    const phase: NativeDraftNavigationPhase = saving
      ? "saving"
      : saveError
        ? "save_failed"
        : this.config.dirty
          ? "unsaved"
          : "clean";
    return {
      label: this.config.label,
      phase,
      dirty: this.config.dirty,
      saving,
      pending: this.pendingTarget !== undefined,
      canSave: this.config.canSave !== false && this.config.save !== undefined,
      ...(saveError ? { saveError } : {}),
      ...(this.config.saveUnavailableMessage ? { saveUnavailableMessage: this.config.saveUnavailableMessage } : {})
    };
  }

  public requestNavigation(target: NativeDraftNavigationTarget): boolean {
    if (this.getState().phase === "clean") {
      navigationTarget(target);
      return true;
    }
    this.pendingTarget = target;
    this.emit();
    return false;
  }

  public async saveAndNavigate(): Promise<boolean> {
    const target = this.pendingTarget;
    if (!target || this.localSaving || this.getState().saving) return false;

    const state = this.getState();
    if (!state.canSave) {
      this.localSaveError = state.saveUnavailableMessage ?? "この下書きを保存できる権限または保存先がありません。下書きを破棄するか、権限を確認してください。";
      this.emit();
      return false;
    }

    if (state.phase === "clean") return this.finishNavigation(target);

    this.localSaving = true;
    this.localSaveError = undefined;
    this.emit();
    let succeeded = false;
    let saveReportedClean = false;
    let failure: string | undefined;
    try {
      const result = await this.config.save?.();
      succeeded = result !== false;
      saveReportedClean = result === true;
      if (!succeeded) failure = defaultSaveFailure;
    } catch (error) {
      failure = errorMessage(error);
    } finally {
      this.localSaving = false;
    }

    if (!succeeded) {
      this.localSaveError = failure ?? defaultSaveFailure;
      this.emit();
      return false;
    }

    const afterSave = this.getState();
    if (afterSave.saving || afterSave.saveError || (afterSave.dirty && !saveReportedClean)) {
      this.emit();
      return false;
    }
    return this.finishNavigation(target);
  }

  public discardAndNavigate(): boolean {
    const target = this.pendingTarget;
    if (!target || this.getState().saving) return false;
    this.config.discard();
    this.pendingTarget = undefined;
    this.localSaveError = undefined;
    this.emit();
    navigationTarget(target);
    return true;
  }

  public cancelNavigation(): void {
    if (!this.pendingTarget) return;
    this.pendingTarget = undefined;
    this.emit();
  }

  public updateState(input: NativeDraftNavigationStateInput): void {
    const scopeChanged = input.scopeKey !== this.config.scopeKey;
    this.config = {
      ...input,
      save: this.config.save,
      discard: this.config.discard
    };
    if (scopeChanged) {
      this.pendingTarget = undefined;
      this.localSaveError = undefined;
    } else if (!input.saveError && !input.dirty && !input.saving) {
      this.localSaveError = undefined;
    }
    this.emit();
  }

  public configure(input: ControllerConfig): void {
    const scopeChanged = input.scopeKey !== this.config.scopeKey;
    this.config = input;
    if (scopeChanged) {
      this.pendingTarget = undefined;
      this.localSaveError = undefined;
    } else if (!input.saveError && !input.dirty && !input.saving) {
      this.localSaveError = undefined;
    }
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private finishNavigation(target: NativeDraftNavigationTarget): boolean {
    if (this.pendingTarget !== target) return false;
    this.pendingTarget = undefined;
    this.localSaveError = undefined;
    this.emit();
    navigationTarget(target);
    return true;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function createNativeDraftNavigationController(
  input: NativeDraftNavigationControllerOptions
): NativeDraftNavigationController {
  return new NativeDraftNavigationControllerImpl({
    ...input,
    discard: input.discard ?? (() => undefined)
  });
}

export function useNativeDraftNavigation(options: UseNativeDraftNavigationOptions): NativeDraftNavigationController {
  const controllerRef = useRef<NativeDraftNavigationControllerImpl | undefined>(undefined);
  if (!controllerRef.current) {
    controllerRef.current = new NativeDraftNavigationControllerImpl({
      ...options,
      discard: options.discard ?? (() => undefined)
    });
  }
  const controller = controllerRef.current;
  controller.configure({
    scopeKey: options.scopeKey,
    label: options.label,
    dirty: options.dirty,
    saving: options.saving,
    saveError: options.saveError,
    canSave: options.canSave,
    saveUnavailableMessage: options.saveUnavailableMessage,
    save: options.save,
    discard: options.discard ?? (() => undefined)
  });

  const [, setRevision] = useState(0);
  useEffect(() => controller.subscribe(() => setRevision((revision) => revision + 1)), [controller]);
  useEffect(() => {
    const detach = options.onControllerChange?.(controller);
    return () => {
      if (typeof detach === "function") {
        detach();
        return;
      }
      // Preserve the old callback contract for callers that only use the
      // controller value and do not return an instance-specific detach.
      options.onControllerChange?.(undefined);
    };
  }, [controller, options.onControllerChange]);
  return controller;
}
