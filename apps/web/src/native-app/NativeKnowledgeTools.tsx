import type { FormEvent } from "react";
import { supportedLocales, type AutomationJobRecord, type SupportedLocale } from "@samurai-agent/core-schemas";
import type { NativeWorkspaceTarget } from "./types";
import {
  isNativeKnowledgeResourceKind,
  type NativeKnowledgeResourceDetail,
  type NativeKnowledgeToolsBridge,
  type NativeKnowledgeToolsSettingsDraft,
  type NativeKnowledgeToolsState,
  type NativeKnowledgeToolsTab,
  type NativeKnowledgeToolsTarget,
  type NativeRoomSearchResult,
  useNativeKnowledgeTools
} from "./use-native-knowledge-tools";

export interface NativeKnowledgeToolsProps {
  target?: NativeKnowledgeToolsTarget;
  workspaceName?: string;
  roomName?: string;
  initialTab?: NativeKnowledgeToolsTab;
  /** Optional close action supplied by the Room host. */
  onClose?: () => void;
  /** Room/Work host callback for non-Knowledge search results. */
  onOpenSearchResult?: (result: NativeRoomSearchResult) => void | Promise<void>;
  /** Optional host action for attaching a selected resource to a new request. */
  onUseResource?: (input: {
    resourceId: string;
    kind: "knowledge" | "skill";
    title: string;
    version: number;
    scopeKind: "workspace" | "room";
    roomId?: string;
  }) => void | Promise<void>;
  /** Test seam; production uses window.samuraiDesktop through the hook. */
  bridge?: NativeKnowledgeToolsBridge;
}

const tabDefinitions: Array<{ id: NativeKnowledgeToolsTab; label: string; shortLabel: string }> = [
  { id: "knowledge", label: "Knowledge / Skill", shortLabel: "知識" },
  { id: "search", label: "Room内検索", shortLabel: "検索" },
  { id: "settings", label: "基本設定", shortLabel: "設定" },
  { id: "automation", label: "既存automation", shortLabel: "自動化" }
];

const localeLabels: Record<SupportedLocale, string> = {
  en: "English",
  ja: "日本語",
  zh: "中文",
  ko: "한국어",
  es: "Español",
  "pt-BR": "Português (Brasil)",
  fr: "Français",
  de: "Deutsch"
};

const panelStyles = `
.native-knowledge-tools {
  --nkt-ink: var(--native-copy, #edf2eb);
  --nkt-muted: var(--native-muted, #a4afa7);
  --nkt-dim: var(--native-dim, #6f7a73);
  --nkt-line: var(--native-line, rgba(204, 218, 209, .12));
  --nkt-line-strong: var(--native-line-strong, rgba(204, 218, 209, .24));
  --nkt-panel: rgba(13, 17, 16, .95);
  --nkt-panel-soft: rgba(27, 34, 30, .66);
  --nkt-accent: var(--native-accent, #f1a65c);
  --nkt-accent-soft: var(--native-accent-soft, rgba(241, 166, 92, .14));
  --nkt-success: var(--native-success, #8ad8b2);
  --nkt-danger: var(--native-danger, #ee8981);
  background:
    radial-gradient(circle at 94% 4%, rgba(241, 166, 92, .12), transparent 18rem),
    linear-gradient(145deg, rgba(22, 29, 26, .98), var(--nkt-panel) 44%);
  border-left: 1px solid var(--nkt-line);
  box-shadow: -18px 0 42px rgba(0, 0, 0, .2);
  box-sizing: border-box;
  color: var(--nkt-ink);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  width: min(520px, 100%);
}
.native-knowledge-tools *, .native-knowledge-tools *::before, .native-knowledge-tools *::after { box-sizing: border-box; }
.native-knowledge-tools__header { border-bottom: 1px solid var(--nkt-line); padding: 22px 22px 16px; }
.native-knowledge-tools__header-row { align-items: flex-start; display: flex; gap: 12px; justify-content: space-between; }
.native-knowledge-tools__eyebrow { color: var(--nkt-accent); display: block; font-size: 10px; font-weight: 800; letter-spacing: .16em; margin-bottom: 8px; text-transform: uppercase; }
.native-knowledge-tools__title { font-family: Georgia, "Times New Roman", serif; font-size: clamp(24px, 3vw, 32px); letter-spacing: -.035em; line-height: 1; margin: 0; }
.native-knowledge-tools__lede { color: var(--nkt-muted); font-size: 12px; line-height: 1.55; margin: 9px 0 0; max-width: 38rem; }
.native-knowledge-tools__target { align-items: center; color: var(--nkt-dim); display: flex; flex-wrap: wrap; font-size: 11px; gap: 6px; margin: 12px 0 0; }
.native-knowledge-tools__target strong { color: var(--nkt-ink); font-weight: 650; }
.native-knowledge-tools__target-mark { background: var(--nkt-accent-soft); border: 1px solid rgba(241, 166, 92, .28); border-radius: 999px; color: var(--nkt-accent); font-size: 10px; font-weight: 750; letter-spacing: .04em; padding: 4px 8px; }
.native-knowledge-tools__close { align-items: center; background: transparent; border: 1px solid var(--nkt-line); border-radius: 10px; color: var(--nkt-muted); cursor: pointer; display: inline-flex; font-size: 19px; height: 34px; justify-content: center; line-height: 1; width: 34px; }
.native-knowledge-tools__close:hover { background: rgba(255, 255, 255, .06); color: var(--nkt-ink); }
.native-knowledge-tools__close:focus-visible, .native-knowledge-tools button:focus-visible, .native-knowledge-tools input:focus-visible, .native-knowledge-tools select:focus-visible, .native-knowledge-tools textarea:focus-visible { outline: 2px solid var(--nkt-accent); outline-offset: 2px; }
.native-knowledge-tools__tabs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; padding: 12px 14px 0; }
.native-knowledge-tools__tab { background: transparent; border: 0; border-bottom: 2px solid transparent; color: var(--nkt-dim); cursor: pointer; font: inherit; font-size: 11px; min-height: 38px; padding: 7px 5px 9px; }
.native-knowledge-tools__tab:hover { color: var(--nkt-ink); }
.native-knowledge-tools__tab[aria-selected="true"] { border-bottom-color: var(--nkt-accent); color: var(--nkt-accent); }
.native-knowledge-tools__tab-short { display: none; }
.native-knowledge-tools__status { border: 1px solid var(--nkt-line); border-radius: 10px; color: var(--nkt-muted); font-size: 12px; line-height: 1.5; margin: 14px 22px 0; padding: 10px 12px; }
.native-knowledge-tools__status.is-error { border-color: rgba(238, 137, 129, .45); color: var(--nkt-danger); }
.native-knowledge-tools__status.is-note { background: rgba(255, 255, 255, .025); }
.native-knowledge-tools__body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 16px 22px 28px; }
.native-knowledge-tools__body > * + * { margin-top: 16px; }
.native-knowledge-tools__toolbar { align-items: flex-start; display: flex; gap: 12px; justify-content: space-between; }
.native-knowledge-tools__section-title { font-size: 13px; font-weight: 760; letter-spacing: .02em; margin: 0; }
.native-knowledge-tools__section-note { color: var(--nkt-muted); font-size: 11px; line-height: 1.5; margin: 5px 0 0; }
.native-knowledge-tools__quiet-button, .native-knowledge-tools__primary-button, .native-knowledge-tools__danger-button { border-radius: 8px; cursor: pointer; font: inherit; font-size: 11px; font-weight: 700; min-height: 32px; padding: 7px 11px; }
.native-knowledge-tools__quiet-button { background: rgba(255, 255, 255, .035); border: 1px solid var(--nkt-line); color: var(--nkt-muted); }
.native-knowledge-tools__primary-button { background: var(--nkt-accent); border: 1px solid var(--nkt-accent); color: #28170b; }
.native-knowledge-tools__danger-button { background: transparent; border: 1px solid rgba(238, 137, 129, .44); color: var(--nkt-danger); }
.native-knowledge-tools__quiet-button:hover, .native-knowledge-tools__danger-button:hover { background: rgba(255, 255, 255, .08); color: var(--nkt-ink); }
.native-knowledge-tools__primary-button:hover { filter: brightness(1.08); }
.native-knowledge-tools button:disabled { cursor: not-allowed; opacity: .42; }
.native-knowledge-tools__resource-groups { display: grid; gap: 14px; }
.native-knowledge-tools__resource-group { background: rgba(255, 255, 255, .018); border: 1px solid var(--nkt-line); border-radius: 12px; overflow: hidden; }
.native-knowledge-tools__resource-group h3 { border-bottom: 1px solid var(--nkt-line); color: var(--nkt-muted); font-size: 11px; letter-spacing: .07em; margin: 0; padding: 10px 12px; text-transform: uppercase; }
.native-knowledge-tools__resource-list { display: grid; }
.native-knowledge-tools__resource-item { align-items: center; background: transparent; border: 0; border-bottom: 1px solid var(--nkt-line); color: inherit; cursor: pointer; display: grid; gap: 5px; min-width: 0; padding: 12px; text-align: left; width: 100%; }
.native-knowledge-tools__resource-item:last-child { border-bottom: 0; }
.native-knowledge-tools__resource-item:hover, .native-knowledge-tools__resource-item[aria-pressed="true"] { background: var(--nkt-accent-soft); }
.native-knowledge-tools__resource-item[aria-pressed="true"] { box-shadow: inset 3px 0 var(--nkt-accent); }
.native-knowledge-tools__resource-topline, .native-knowledge-tools__resource-meta { align-items: center; display: flex; flex-wrap: wrap; gap: 6px; }
.native-knowledge-tools__resource-topline { justify-content: space-between; }
.native-knowledge-tools__resource-title { font-size: 13px; font-weight: 700; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.native-knowledge-tools__resource-meta { color: var(--nkt-dim); font-size: 10px; line-height: 1.4; }
.native-knowledge-tools__resource-kind, .native-knowledge-tools__resource-state { border-radius: 999px; font-size: 9px; font-weight: 800; letter-spacing: .05em; padding: 3px 6px; text-transform: uppercase; }
.native-knowledge-tools__resource-kind { background: rgba(121, 178, 190, .13); color: #9fcbd1; }
.native-knowledge-tools__resource-state { background: rgba(255, 255, 255, .06); color: var(--nkt-muted); }
.native-knowledge-tools__resource-state.is-provisional { color: #9ebcff; }
.native-knowledge-tools__resource-state.is-conflict { color: var(--nkt-accent); }
.native-knowledge-tools__resource-state.is-archived { color: var(--nkt-dim); }
.native-knowledge-tools__empty { color: var(--nkt-dim); font-size: 12px; line-height: 1.5; padding: 14px 12px; }
.native-knowledge-tools__detail, .native-knowledge-tools__settings-card, .native-knowledge-tools__automation-card { background: var(--nkt-panel-soft); border: 1px solid var(--nkt-line); border-radius: 14px; padding: 15px; }
.native-knowledge-tools__detail-head { align-items: flex-start; display: flex; gap: 12px; justify-content: space-between; }
.native-knowledge-tools__detail-head h3 { font-family: Georgia, "Times New Roman", serif; font-size: 21px; letter-spacing: -.02em; line-height: 1.15; margin: 0; }
.native-knowledge-tools__detail-head p { color: var(--nkt-muted); font-size: 11px; line-height: 1.45; margin: 5px 0 0; }
.native-knowledge-tools__meta-grid { display: grid; gap: 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 15px 0; }
.native-knowledge-tools__meta-grid div { border-top: 1px solid var(--nkt-line); min-width: 0; padding-top: 7px; }
.native-knowledge-tools__meta-grid dt { color: var(--nkt-dim); font-size: 10px; margin-bottom: 3px; }
.native-knowledge-tools__meta-grid dd { font-size: 11px; margin: 0; overflow-wrap: anywhere; }
.native-knowledge-tools__field { display: grid; gap: 6px; margin-top: 11px; }
.native-knowledge-tools__field > span, .native-knowledge-tools__fieldset legend { color: var(--nkt-muted); font-size: 11px; font-weight: 700; }
.native-knowledge-tools__field input, .native-knowledge-tools__field select, .native-knowledge-tools__field textarea, .native-knowledge-tools__search-input { background: rgba(0, 0, 0, .22); border: 1px solid var(--nkt-line-strong); border-radius: 8px; color: var(--nkt-ink); font: inherit; font-size: 12px; min-width: 0; padding: 9px 10px; width: 100%; }
.native-knowledge-tools__field textarea { line-height: 1.55; min-height: 170px; resize: vertical; }
.native-knowledge-tools__field input::placeholder, .native-knowledge-tools__field textarea::placeholder, .native-knowledge-tools__search-input::placeholder { color: var(--nkt-dim); }
.native-knowledge-tools__readonly { color: var(--nkt-muted); font-size: 11px; line-height: 1.5; margin: 10px 0 0; }
.native-knowledge-tools__draft-note { color: var(--nkt-accent); font-size: 11px; line-height: 1.5; margin: 10px 0 0; }
.native-knowledge-tools__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 13px; }
.native-knowledge-tools__history { border-top: 1px solid var(--nkt-line); margin-top: 15px; padding-top: 13px; }
.native-knowledge-tools__history h4 { color: var(--nkt-muted); font-size: 11px; margin: 0 0 8px; }
.native-knowledge-tools__history-list { display: grid; gap: 7px; list-style: none; margin: 0; padding: 0; }
.native-knowledge-tools__history-list li { border-left: 2px solid var(--nkt-line-strong); color: var(--nkt-muted); font-size: 11px; line-height: 1.45; padding-left: 9px; }
.native-knowledge-tools__history-list strong { color: var(--nkt-ink); display: block; font-size: 11px; }
.native-knowledge-tools__search { display: grid; gap: 10px; }
.native-knowledge-tools__search-row { align-items: end; display: flex; gap: 8px; }
.native-knowledge-tools__search-row label { color: var(--nkt-muted); display: grid; flex: 1; font-size: 11px; gap: 6px; }
.native-knowledge-tools__search-result-list { display: grid; gap: 8px; list-style: none; margin: 0; padding: 0; }
.native-knowledge-tools__search-result { align-items: flex-start; background: var(--nkt-panel-soft); border: 1px solid var(--nkt-line); border-radius: 10px; color: inherit; cursor: pointer; display: grid; gap: 5px; padding: 11px 12px; text-align: left; width: 100%; }
.native-knowledge-tools__search-result:hover { border-color: var(--nkt-line-strong); background: rgba(255, 255, 255, .05); }
.native-knowledge-tools__search-result:disabled { cursor: not-allowed; }
.native-knowledge-tools__search-result-topline { align-items: center; display: flex; gap: 7px; }
.native-knowledge-tools__search-result-topline span { color: var(--nkt-accent); font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
.native-knowledge-tools__search-result strong { font-size: 13px; }
.native-knowledge-tools__search-result small { color: var(--nkt-muted); font-size: 11px; line-height: 1.45; }
.native-knowledge-tools__settings-stack, .native-knowledge-tools__automation-stack { display: grid; gap: 12px; }
.native-knowledge-tools__settings-card h3, .native-knowledge-tools__automation-card h3 { font-size: 13px; margin: 0; }
.native-knowledge-tools__settings-card > p, .native-knowledge-tools__automation-card > p { color: var(--nkt-muted); font-size: 11px; line-height: 1.5; margin: 6px 0 0; }
.native-knowledge-tools__fieldset { border: 0; margin: 14px 0 0; padding: 0; }
.native-knowledge-tools__choice { align-items: center; color: var(--nkt-ink); display: flex; font-size: 12px; gap: 8px; margin-top: 9px; }
.native-knowledge-tools__choice input { accent-color: var(--nkt-accent); }
.native-knowledge-tools__settings-summary { display: grid; gap: 7px; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 14px; }
.native-knowledge-tools__settings-summary div { border-top: 1px solid var(--nkt-line); padding-top: 7px; }
.native-knowledge-tools__settings-summary span { color: var(--nkt-dim); display: block; font-size: 10px; }
.native-knowledge-tools__settings-summary strong { display: block; font-size: 12px; margin-top: 2px; }
.native-knowledge-tools__automation-item { border-top: 1px solid var(--nkt-line); display: grid; gap: 9px; padding: 13px 0; }
.native-knowledge-tools__automation-item:first-child { border-top: 0; padding-top: 0; }
.native-knowledge-tools__automation-head { align-items: start; display: flex; gap: 10px; justify-content: space-between; }
.native-knowledge-tools__automation-head strong { font-size: 13px; }
.native-knowledge-tools__automation-head small, .native-knowledge-tools__automation-meta { color: var(--nkt-muted); display: block; font-size: 11px; line-height: 1.45; margin-top: 4px; }
.native-knowledge-tools__automation-badge { border: 1px solid var(--nkt-line-strong); border-radius: 999px; color: var(--nkt-muted); font-size: 9px; font-weight: 800; padding: 4px 7px; white-space: nowrap; }
.native-knowledge-tools__automation-badge.is-enabled { border-color: rgba(138, 216, 178, .36); color: var(--nkt-success); }
.native-knowledge-tools__automation-badge.is-disabled { color: var(--nkt-accent); }
.native-knowledge-tools__automation-actions { display: flex; flex-wrap: wrap; gap: 7px; }
.native-knowledge-tools__run-list { display: grid; gap: 7px; list-style: none; margin: 10px 0 0; padding: 0; }
.native-knowledge-tools__run-list li { align-items: start; border-top: 1px solid var(--nkt-line); display: grid; gap: 3px; grid-template-columns: minmax(0, 1fr) auto; padding: 8px 0 0; }
.native-knowledge-tools__run-list strong { font-size: 11px; }
.native-knowledge-tools__run-list small { color: var(--nkt-muted); font-size: 10px; line-height: 1.4; }
.native-knowledge-tools__run-status { color: var(--nkt-muted); font-size: 10px; }
.native-knowledge-tools__run-status.is-failed { color: var(--nkt-danger); }
@media (max-width: 680px) {
  .native-knowledge-tools { border-left: 0; width: 100%; }
  .native-knowledge-tools__header, .native-knowledge-tools__body { padding-left: 16px; padding-right: 16px; }
  .native-knowledge-tools__status { margin-left: 16px; margin-right: 16px; }
  .native-knowledge-tools__tabs { padding-left: 8px; padding-right: 8px; }
  .native-knowledge-tools__tab-label { display: none; }
  .native-knowledge-tools__tab-short { display: inline; }
}
@media (prefers-reduced-motion: reduce) {
  .native-knowledge-tools *, .native-knowledge-tools *::before, .native-knowledge-tools *::after { scroll-behavior: auto !important; transition: none !important; }
}
`;

export default function NativeKnowledgeTools(props: NativeKnowledgeToolsProps) {
  const model = useNativeKnowledgeTools({
    target: props.target,
    initialTab: props.initialTab,
    bridge: props.bridge
  });

  return (
    <>
      <style>{panelStyles}</style>
      <aside className="native-knowledge-tools" aria-label="Room補助パネル">
        <header className="native-knowledge-tools__header">
          <div className="native-knowledge-tools__header-row">
            <div>
              <span className="native-knowledge-tools__eyebrow">Room toolkit</span>
              <h2 className="native-knowledge-tools__title">Knowledge tools</h2>
              <p className="native-knowledge-tools__lede">知識・検索・基本設定・既存automationを、今開いているRoomの補助画面として扱います。</p>
            </div>
            {props.onClose ? <button className="native-knowledge-tools__close" type="button" onClick={props.onClose} aria-label="補助パネルを閉じる">×</button> : null}
          </div>
          <div className="native-knowledge-tools__target" aria-label="固定した対象">
            <strong>{props.workspaceName ?? "選択中のWorkspace"}</strong>
            <span aria-hidden="true">/</span>
            <strong>{props.roomName ?? "選択中のRoom"}</strong>
            <span className="native-knowledge-tools__target-mark">対象固定</span>
          </div>
        </header>

        <TabNavigation model={model} />

        {!model.target ? <div className="native-knowledge-tools__status is-note" role="status">WorkspaceとRoomを選択すると、このパネルを利用できます。</div> : null}
        {model.target && model.readOnly ? <div className="native-knowledge-tools__status is-note" role="status">既存bridgeを確認できないため、読み取り専用で待機しています。</div> : null}
        {model.tab === "knowledge" ? <KnowledgeView model={model} onUseResource={props.onUseResource} /> : null}
        {model.tab === "search" ? <SearchView model={model} onOpenSearchResult={props.onOpenSearchResult} /> : null}
        {model.tab === "settings" ? <SettingsView model={model} /> : null}
        {model.tab === "automation" ? <AutomationView model={model} /> : null}
      </aside>
    </>
  );
}

function TabNavigation({ model }: { model: NativeKnowledgeToolsState }) {
  const moveTab = (current: NativeKnowledgeToolsTab, delta: number) => {
    const index = tabDefinitions.findIndex((tab) => tab.id === current);
    const next = tabDefinitions[(index + delta + tabDefinitions.length) % tabDefinitions.length] ?? tabDefinitions[0];
    if (!next) return;
    model.setTab(next.id);
    if (typeof document !== "undefined") document.getElementById(`native-knowledge-tools-tab-${next.id}`)?.focus();
  };

  return (
    <nav className="native-knowledge-tools__tabs" aria-label="補助パネルの種類" role="tablist">
      {tabDefinitions.map((tab) => (
        <button
          className="native-knowledge-tools__tab"
          id={`native-knowledge-tools-tab-${tab.id}`}
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={model.tab === tab.id}
          aria-controls={`native-knowledge-tools-panel-${tab.id}`}
          tabIndex={model.tab === tab.id ? 0 : -1}
          onClick={() => model.setTab(tab.id)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") moveTab(tab.id, 1);
            if (event.key === "ArrowLeft" || event.key === "ArrowUp") moveTab(tab.id, -1);
          }}
        >
          <span className="native-knowledge-tools__tab-label">{tab.label}</span>
          <span className="native-knowledge-tools__tab-short">{tab.shortLabel}</span>
        </button>
      ))}
    </nav>
  );
}

function KnowledgeView({
  model,
  onUseResource
}: {
  model: NativeKnowledgeToolsState;
  onUseResource?: NativeKnowledgeToolsProps["onUseResource"];
}) {
  return (
    <div className="native-knowledge-tools__body" id="native-knowledge-tools-panel-knowledge" role="tabpanel" aria-labelledby="native-knowledge-tools-tab-knowledge">
      <div className="native-knowledge-tools__toolbar">
        <div>
          <h3 className="native-knowledge-tools__section-title">確認できる資源</h3>
          <p className="native-knowledge-tools__section-note">Roomの知識とWorkspace共通の知識を分けて表示します。Skillの最適化画面はここへ追加しません。</p>
        </div>
        <button className="native-knowledge-tools__quiet-button" type="button" onClick={() => void model.reloadResources()} disabled={model.resourcesLoading || !model.target}>更新</button>
      </div>

      {model.resourcesError ? <div className="native-knowledge-tools__status is-error" role="alert">{model.resourcesError}</div> : null}
      {model.resourcesLoading ? <div className="native-knowledge-tools__status" role="status">KnowledgeとSkillを読み込んでいます…</div> : null}

      <div className="native-knowledge-tools__resource-groups">
        <ResourceGroup title="このRoomのKnowledge" resources={model.roomResources} selectedResourceId={model.selectedResourceId} onOpen={model.openResource} />
        <ResourceGroup title="Workspace共通Knowledge" resources={model.workspaceResources} selectedResourceId={model.selectedResourceId} onOpen={model.openResource} />
        <ResourceGroup title="Skill" resources={model.skills} selectedResourceId={model.selectedResourceId} onOpen={model.openResource} />
      </div>

      {model.resourceError ? <div className="native-knowledge-tools__status is-error" role="alert">{model.resourceError}</div> : null}
      {model.resourceLoading ? <div className="native-knowledge-tools__status" role="status">本文と変更履歴を読み込んでいます…</div> : null}
      {model.selectedResource ? <ResourceDetailView model={model} onUseResource={onUseResource} /> : <div className="native-knowledge-tools__status is-note" role="status">資源を選ぶと本文、版、出所、根拠、許可された操作を表示します。</div>}
    </div>
  );
}

function ResourceGroup({
  title,
  resources,
  selectedResourceId,
  onOpen
}: {
  title: string;
  resources: NativeKnowledgeToolsState["roomResources"];
  selectedResourceId?: string;
  onOpen: (resourceId: string) => Promise<void>;
}) {
  return (
    <section className="native-knowledge-tools__resource-group" aria-label={title}>
      <h3>{title}</h3>
      {resources.length === 0 ? <p className="native-knowledge-tools__empty">まだありません</p> : (
        <div className="native-knowledge-tools__resource-list">
          {resources.map((resource) => (
            <button
              className="native-knowledge-tools__resource-item"
              key={resource.id}
              type="button"
              aria-pressed={selectedResourceId === resource.id}
              onClick={() => void onOpen(resource.id)}
            >
              <span className="native-knowledge-tools__resource-topline">
                <span className="native-knowledge-tools__resource-title">{resource.title}</span>
                <span className={`native-knowledge-tools__resource-state ${resourceStateClass(resource)}`}>{resourceStateLabel(resource)}</span>
              </span>
              <span className="native-knowledge-tools__resource-meta">
                <span className="native-knowledge-tools__resource-kind">{resource.kind === "skill" ? "Skill" : "Knowledge"}</span>
                <span>{resource.scope.kind === "room" ? "このRoom" : "Workspace共通"}</span>
                <span>v{resource.version}</span>
                <span>{resource.creationSource}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ResourceDetailView({
  model,
  onUseResource
}: {
  model: NativeKnowledgeToolsState;
  onUseResource?: NativeKnowledgeToolsProps["onUseResource"];
}) {
  const detail = model.selectedResource;
  const draft = model.draft;
  if (!detail || !draft) return null;
  const resource = detail.resource;
  const busy = model.resourceBusy !== null;
  const archived = resource.lifecycleState === "archived";
  const canEdit = model.resourceCanEdit && !archived;
  const reasonMissing = !draft.reason.trim();
  const version = detail.version.version ?? resource.version;
  const resourceKind = isNativeKnowledgeResourceKind(resource.kind) ? resource.kind : undefined;

  return (
    <article className="native-knowledge-tools__detail" aria-label={`${resource.title}の詳細`}>
      <div className="native-knowledge-tools__detail-head">
        <div>
          <h3>{resource.title}</h3>
          <p>{resource.kind === "skill" ? "Skill" : "Knowledge"} · {resource.scope.kind === "room" ? "このRoom" : "Workspace共通"}</p>
        </div>
        <span className={`native-knowledge-tools__resource-state ${resourceStateClass(resource)}`}>{resourceStateLabel(resource)}</span>
      </div>

      <dl className="native-knowledge-tools__meta-grid">
        <div><dt>本文版</dt><dd>v{version}</dd></div>
        <div><dt>出所</dt><dd>{resource.creationSource}</dd></div>
        <div><dt>根拠状態</dt><dd>{resource.evidenceState}</dd></div>
        <div><dt>AI更新</dt><dd>{resource.aiProtection === "fixed" ? "固定" : "許可"}</dd></div>
        <div><dt>更新日時</dt><dd>{formatNativeDate(resource.updatedAt)}</dd></div>
        <div><dt>本文hash</dt><dd>{detail.version.contentHash ? `${detail.version.contentHash.slice(0, 14)}…` : "bridge未返却"}</dd></div>
      </dl>

      <label className="native-knowledge-tools__field">
        <span>タイトル</span>
        <input value={draft.title} onChange={(event) => model.updateDraft({ title: event.currentTarget.value })} readOnly={!canEdit} maxLength={20_000} aria-label="資源タイトル" />
      </label>
      <label className="native-knowledge-tools__field">
        <span>本文</span>
        <textarea value={draft.content} onChange={(event) => model.updateDraft({ content: event.currentTarget.value })} readOnly={!canEdit} aria-label="資源本文" />
      </label>
      <label className="native-knowledge-tools__field">
        <span>変更理由（保存・状態変更に必要）</span>
        <input value={draft.reason} onChange={(event) => model.updateDraft({ reason: event.currentTarget.value })} readOnly={model.readOnly} maxLength={4_000} placeholder="例: 現在の運用に合わせて確認" aria-label="変更理由" />
      </label>

      {archived ? <p className="native-knowledge-tools__readonly">保管済みの資源は本文を編集できません。有効化または復元後に編集できます。</p> : null}
      {!archived && !model.resourceCanEdit ? <p className="native-knowledge-tools__readonly">編集bridgeがないため、本文は読み取り専用です。Serverの権限も確認してください。</p> : null}
      {draft.dirty ? <p className="native-knowledge-tools__draft-note" role="status">未保存の下書きを保持しています。状態変更の前に保存または取消を選んでください。</p> : null}

      <div className="native-knowledge-tools__actions">
        <button className="native-knowledge-tools__primary-button" type="button" onClick={() => void model.saveResource()} disabled={busy || !canEdit || !draft.title.trim() || !draft.content.trim() || reasonMissing}>{model.resourceBusy === "save" ? "保存中…" : "本文を保存"}</button>
        <button className="native-knowledge-tools__quiet-button" type="button" onClick={model.cancelDraft} disabled={busy || !draft.dirty}>取消</button>
        {resource.kind === "knowledge" ? <button className="native-knowledge-tools__quiet-button" type="button" onClick={() => void model.toggleFixed()} disabled={busy || !model.resourceCanFix || draft.dirty}>{resource.aiProtection === "fixed" ? "AI更新の固定を解除" : "AI更新を固定"}</button> : null}
        <button className="native-knowledge-tools__danger-button" type="button" onClick={() => void model.toggleArchived()} disabled={busy || !model.resourceCanArchive || draft.dirty}>{skillArchiveLabel(resource)}</button>
        {onUseResource && resourceKind ? <button className="native-knowledge-tools__quiet-button" type="button" onClick={() => void onUseResource({ resourceId: resource.id, kind: resourceKind, title: resource.title, version, scopeKind: resource.scope.kind, ...(resource.scope.kind === "room" ? { roomId: resource.scope.roomId } : {}) })} disabled={busy}>仕事で使う</button> : null}
      </div>

      <ResourceHistory detail={detail} />
    </article>
  );
}

function ResourceHistory({ detail }: { detail: NativeKnowledgeResourceDetail }) {
  return (
    <section className="native-knowledge-tools__history" aria-label="変更履歴と根拠">
      <h4>変更履歴と根拠</h4>
      {detail.versions.length === 0 && detail.evidence.length === 0 ? <p className="native-knowledge-tools__empty">履歴または根拠はまだありません。</p> : null}
      {detail.versions.length > 0 ? (
        <ul className="native-knowledge-tools__history-list">
          {detail.versions.slice(0, 12).map((version, index) => (
            <li key={`version-${index}-${recordText(version, ["version", "created_at"])}`}>
              <strong>v{recordText(version, ["version"]) || "?"} · {recordText(version, ["change_kind", "changeKind"]) || "更新"}</strong>
              {recordText(version, ["reason", "summary"]) || "理由は未返却"}
            </li>
          ))}
        </ul>
      ) : null}
      {detail.evidence.length > 0 ? (
        <ul className="native-knowledge-tools__history-list" aria-label="根拠一覧">
          {detail.evidence.slice(0, 12).map((evidence, index) => (
            <li key={`evidence-${index}-${recordText(evidence, ["resource_version", "resourceVersion"])}`}>
              <strong>根拠 · v{recordText(evidence, ["resource_version", "resourceVersion"]) || "?"} · {recordText(evidence, ["kind"]) || "記録"}</strong>
              {recordText(evidence, ["summary", "description"]) || "概要は未返却"}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function SearchView({
  model,
  onOpenSearchResult
}: {
  model: NativeKnowledgeToolsState;
  onOpenSearchResult?: NativeKnowledgeToolsProps["onOpenSearchResult"];
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void model.runSearch();
  };

  return (
    <div className="native-knowledge-tools__body" id="native-knowledge-tools-panel-search" role="tabpanel" aria-labelledby="native-knowledge-tools-tab-search">
      <form className="native-knowledge-tools__search" onSubmit={submit}>
        <div className="native-knowledge-tools__search-row">
          <label htmlFor="native-knowledge-tools-search-input">このRoomを検索</label>
          <button className="native-knowledge-tools__primary-button" type="submit" disabled={model.searchLoading || !model.target || !model.searchQuery.trim()}>検索</button>
        </div>
        <input className="native-knowledge-tools__search-input" id="native-knowledge-tools-search-input" value={model.searchQuery} onChange={(event) => model.setSearchQuery(event.currentTarget.value)} placeholder="仕事、履歴、成果物、Knowledgeを検索" />
        <p className="native-knowledge-tools__section-note">検索範囲は現在のRoomだけです。内部Sessionの選択や表示は行いません。</p>
      </form>
      {model.searchError ? <div className="native-knowledge-tools__status is-error" role="alert">{model.searchError}</div> : null}
      {model.searchLoading ? <div className="native-knowledge-tools__status" role="status">Room内を検索しています…</div> : null}
      {!model.searchLoading && model.searchQuery.trim() && model.searchResults.length === 0 ? <div className="native-knowledge-tools__status is-note" role="status">該当する記録はありません。</div> : null}
      {model.searchResults.length > 0 ? (
        <ul className="native-knowledge-tools__search-result-list" aria-label="Room内検索結果">
          {model.searchResults.map((result) => {
            const openable = Boolean(result.resource || onOpenSearchResult);
            return (
              <li key={result.key}>
                <button className="native-knowledge-tools__search-result" type="button" disabled={!openable} onClick={() => {
                  if (result.resource) void model.openSearchResult(result);
                  else if (onOpenSearchResult) void onOpenSearchResult(result);
                }}>
                  <span className="native-knowledge-tools__search-result-topline"><span>{searchKindLabel(result.kind)}</span>{result.rank === undefined ? null : <small>関連度 {result.rank}</small>}</span>
                  <strong>{result.title}</strong>
                  <small>{result.summary || "概要なし"}{openable ? " · 開く" : " · この結果を開く入口がありません"}</small>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function SettingsView({ model }: { model: NativeKnowledgeToolsState }) {
  const draft = model.settingsDraft;
  const settings = model.settings;
  const submitLanguage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void model.saveLanguageSettings();
  };
  const submitLearning = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void model.saveLearningSettings();
  };

  return (
    <div className="native-knowledge-tools__body" id="native-knowledge-tools-panel-settings" role="tabpanel" aria-labelledby="native-knowledge-tools-tab-settings">
      {model.settingsError ? <div className="native-knowledge-tools__status is-error" role="alert">{model.settingsError}</div> : null}
      {model.settingsLoading && !settings ? <div className="native-knowledge-tools__status" role="status">基本設定を読み込んでいます…</div> : null}
      {!model.settingsLoading && !settings ? <div className="native-knowledge-tools__status is-note" role="status">基本設定を取得できません。既存の接続設定とServerの状態を確認してください。</div> : null}
      {settings && draft ? <div className="native-knowledge-tools__settings-stack">
        <form className="native-knowledge-tools__settings-card" onSubmit={submitLanguage}>
          <h3>表示と言語</h3>
          <p>Workspaceに保存する表示言語とAgentの出力言語です。</p>
          <label className="native-knowledge-tools__field" htmlFor="native-knowledge-tools-ui-locale"><span>表示言語</span><select id="native-knowledge-tools-ui-locale" value={draft.uiLocale} onChange={(event) => updateSettings(model, { uiLocale: event.currentTarget.value as SupportedLocale })} disabled={model.settingsBusy !== null || !model.settingsCanEdit}>{supportedLocales.map((locale) => <option key={locale} value={locale}>{localeLabels[locale]}</option>)}</select></label>
          <label className="native-knowledge-tools__field" htmlFor="native-knowledge-tools-output-locale"><span>出力言語</span><select id="native-knowledge-tools-output-locale" value={draft.outputLocale} onChange={(event) => updateSettings(model, { outputLocale: event.currentTarget.value as SupportedLocale })} disabled={model.settingsBusy !== null || !model.settingsCanEdit}>{supportedLocales.map((locale) => <option key={locale} value={locale}>{localeLabels[locale]}</option>)}</select></label>
          <div className="native-knowledge-tools__actions"><button className="native-knowledge-tools__primary-button" type="submit" disabled={model.settingsBusy !== null || !model.settingsCanEdit}>{model.settingsBusy === "language" ? "保存中…" : "言語を保存"}</button></div>
        </form>

        <form className="native-knowledge-tools__settings-card" onSubmit={submitLearning}>
          <h3>学習の基本状態</h3>
          <p>高度なEngine・model・予算編集はここでは行わず、現在の有効状態だけを管理します。</p>
          <label className="native-knowledge-tools__choice"><input type="checkbox" checked={draft.learningEnabled} onChange={(event) => updateSettings(model, { learningEnabled: event.currentTarget.checked })} disabled={model.settingsBusy !== null || !model.settingsCanEdit} /> <span>Workspaceの学習を有効にする</span></label>
          <fieldset className="native-knowledge-tools__fieldset"><legend>適用範囲</legend>
            <label className="native-knowledge-tools__choice"><input type="radio" name="native-knowledge-tools-learning-scope" value="workspace" checked={draft.learningScope === "workspace"} onChange={() => updateSettings(model, { learningScope: "workspace", scopedLearningEnabled: settings.learning.workspace?.enabled ?? settings.learning.effective.enabled })} disabled={model.settingsBusy !== null || !model.settingsCanEdit} /> <span>Workspace標準</span></label>
            <label className="native-knowledge-tools__choice"><input type="radio" name="native-knowledge-tools-learning-scope" value="room" checked={draft.learningScope === "room"} onChange={() => updateSettings(model, { learningScope: "room", scopedLearningEnabled: settings.learning.room?.enabled ?? settings.learning.effective.enabled })} disabled={model.settingsBusy !== null || !model.settingsCanEdit} /> <span>このRoomの上書き</span></label>
          </fieldset>
          <label className="native-knowledge-tools__choice"><input type="checkbox" checked={draft.scopedLearningEnabled} onChange={(event) => updateSettings(model, { scopedLearningEnabled: event.currentTarget.checked })} disabled={model.settingsBusy !== null || !model.settingsCanEdit} /> <span>{draft.learningScope === "room" ? "このRoomで学習処理を有効にする" : "Workspace標準の学習処理を有効にする"}</span></label>
          <div className="native-knowledge-tools__settings-summary">
            <div><span>現在の適用元</span><strong>{settings.learning.room ? "Room上書き" : "Workspace標準"}</strong></div>
            <div><span>現在の状態</span><strong>{settings.learning.effective.enabled ? "有効" : "停止"}</strong></div>
            <div><span>使用量</span><strong>{settings.learning.effective.tokensUsed.toLocaleString()} tokens</strong></div>
            <div><span>確保中</span><strong>{settings.learning.effective.tokensReserved.toLocaleString()} tokens</strong></div>
          </div>
          <div className="native-knowledge-tools__actions"><button className="native-knowledge-tools__primary-button" type="submit" disabled={model.settingsBusy !== null || !model.settingsCanEdit}>{model.settingsBusy === "learning" ? "保存中…" : "学習状態を保存"}</button>{settings.learning.room ? <button className="native-knowledge-tools__quiet-button" type="button" onClick={() => void model.removeRoomLearningOverride()} disabled={model.settingsBusy !== null || !model.settingsCanEdit}>{model.settingsBusy === "override" ? "解除中…" : "Room上書きを解除"}</button> : null}</div>
        </form>
      </div> : null}
    </div>
  );
}

function AutomationView({ model }: { model: NativeKnowledgeToolsState }) {
  return (
    <div className="native-knowledge-tools__body" id="native-knowledge-tools-panel-automation" role="tabpanel" aria-labelledby="native-knowledge-tools-tab-automation">
      <div className="native-knowledge-tools__toolbar">
        <div><h3 className="native-knowledge-tools__section-title">既存automation</h3><p className="native-knowledge-tools__section-note">このRoomに紐づく予定・状態・最近の実行結果だけを表示します。</p></div>
        <button className="native-knowledge-tools__quiet-button" type="button" onClick={() => void model.reloadAutomation()} disabled={model.automationLoading || !model.target}>更新</button>
      </div>
      {model.automationError ? <div className="native-knowledge-tools__status is-error" role="alert">{model.automationError}</div> : null}
      {model.automationLoading ? <div className="native-knowledge-tools__status" role="status">automationを読み込んでいます…</div> : null}
      <section className="native-knowledge-tools__automation-card" aria-labelledby="native-knowledge-tools-automation-list-title">
        <h3 id="native-knowledge-tools-automation-list-title">予定</h3>
        <p>停止するのは予約だけです。実行中の仕事はRoomの仕事制御から停止します。</p>
        <div className="native-knowledge-tools__automation-stack">
          {model.automationJobs.length === 0 ? <div className="native-knowledge-tools__empty">既存の予定はありません。</div> : model.automationJobs.map((job) => <AutomationItem key={job.id} job={job} model={model} />)}
        </div>
      </section>
      <section className="native-knowledge-tools__automation-card" aria-labelledby="native-knowledge-tools-automation-history-title">
        <h3 id="native-knowledge-tools-automation-history-title">最近の実行履歴</h3>
        {model.automationRuns.length === 0 ? <div className="native-knowledge-tools__empty">実行履歴はありません。</div> : <ul className="native-knowledge-tools__run-list">{model.automationRuns.slice(0, 30).map((run) => <li key={run.id}><div><strong>{run.kind}</strong><small>{formatNativeDate(run.started_at)}{run.completed_at ? ` → ${formatNativeDate(run.completed_at)}` : ""}</small>{run.error ? <small className="native-knowledge-tools__run-status is-failed">{run.error}</small> : null}</div><span className={`native-knowledge-tools__run-status ${run.status === "failed" || run.status === "blocked" ? "is-failed" : ""}`}>{automationRunStatusLabel(run.status)}</span></li>)}</ul>}
      </section>
    </div>
  );
}

function AutomationItem({ job, model }: { job: AutomationJobRecord; model: NativeKnowledgeToolsState }) {
  const enabled = job.status === "enabled";
  const archived = job.status === "archived";
  const busy = model.automationBusyJobId === job.id;
  return <article className="native-knowledge-tools__automation-item">
    <div className="native-knowledge-tools__automation-head"><div><strong>{job.title}</strong><small>{automationKindLabel(job.kind)} · {job.schedule}</small></div><span className={`native-knowledge-tools__automation-badge ${enabled ? "is-enabled" : archived ? "" : "is-disabled"}`}>{automationStatusLabel(job)}</span></div>
    <div className="native-knowledge-tools__automation-meta">次回: {formatNativeDate(job.next_run_at)} · 最終: {formatNativeDate(job.last_run_at)}{job.failure_count ? ` · 失敗 ${job.failure_count}回` : ""}</div>
    {job.last_error ? <div className="native-knowledge-tools__automation-meta">最新エラー: {job.last_error}</div> : null}
    <div className="native-knowledge-tools__automation-actions"><button className="native-knowledge-tools__quiet-button" type="button" onClick={() => void model.toggleAutomation(job)} disabled={busy || archived || !model.automationCanManage}>{busy ? "反映中…" : enabled ? "予定を停止" : "予定を再開"}</button></div>
  </article>;
}

function updateSettings(model: NativeKnowledgeToolsState, patch: Partial<NativeKnowledgeToolsSettingsDraft>): void {
  model.updateSettingsDraft(patch);
}

function resourceStateLabel(resource: { lifecycleState: string; evidenceState: string }): string {
  if (resource.lifecycleState === "archived") return "保管済み";
  if (resource.evidenceState === "provisional") return "暫定";
  if (resource.evidenceState === "contradicted" || resource.evidenceState === "review_required") return "確認要";
  return "有効";
}

function resourceStateClass(resource: { lifecycleState: string; evidenceState: string }): string {
  if (resource.lifecycleState === "archived") return "is-archived";
  if (resource.evidenceState === "provisional") return "is-provisional";
  if (resource.evidenceState === "contradicted" || resource.evidenceState === "review_required") return "is-conflict";
  return "";
}

function skillArchiveLabel(resource: { kind: string; lifecycleState: string }): string {
  if (resource.kind === "skill") return resource.lifecycleState === "archived" ? "Skillを有効化" : "Skillを無効化";
  return resource.lifecycleState === "archived" ? "復元" : "保管";
}

function searchKindLabel(kind: NativeRoomSearchResult["kind"]): string {
  if (kind === "knowledge") return "Knowledge";
  if (kind === "session") return "仕事の履歴";
  if (kind === "message") return "メッセージ";
  if (kind === "artifact") return "成果物";
  return "監査履歴";
}

function automationKindLabel(kind: AutomationJobRecord["kind"]): string {
  const labels: Record<AutomationJobRecord["kind"], string> = {
    memory_review: "Memory確認",
    learning_evaluation: "学習評価",
    skill_curator: "Skill整理",
    wiki_reindex: "Wiki再索引",
    daily_digest: "日次まとめ",
    custom_instruction: "指定処理",
    resource_translation: "資源翻訳"
  };
  return labels[kind];
}

function automationStatusLabel(job: AutomationJobRecord): string {
  if (job.status === "archived") return "保管済み";
  if (job.management_state === "manager_stopped" || job.status === "disabled") return "停止中";
  if (job.authorization_state !== "ready") return "再認可待ち";
  return "稼働中";
}

function automationRunStatusLabel(status: string): string {
  if (status === "completed") return "完了";
  if (status === "failed") return "失敗";
  if (status === "blocked") return "保留";
  return "実行中";
}

function formatNativeDate(value?: string): string {
  if (!value) return "未定";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function recordText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return "";
}

export { panelStyles, formatNativeDate, resourceStateLabel, resourceStateClass };
export type { NativeWorkspaceTarget };
