import { ref } from "vue";
import type { BackendEventRecord } from "@samurai-agent/core-schemas";

export type WorkActivityKind = "files_read" | "code_searched" | "command_run" | "browser_checked" | "artifact_created" | "workspace_prepared" | "memory_prepared" | "skill_prepared" | "waiting";
export type WorkActivityItem = { kind: WorkActivityKind; label: string; count?: number };
export type PendingAgentStreamItem =
  | { id: string; kind: "reasoning_text" | "assistant_text"; receivedText: string; displayedText: string }
  | { id: string; kind: "activity"; activity: WorkActivityItem };

export function useAgentStream(classifyEvent: (event: BackendEventRecord) => WorkActivityItem | undefined) {
  const agentResponsePending = ref(false);
  const pendingAgentReceivedContent = ref("");
  const pendingAgentDisplayedContent = ref("");
  const pendingAgentActivity = ref<WorkActivityItem[]>([]);
  const pendingAgentStreamItems = ref<PendingAgentStreamItem[]>([]);
  const pendingAgentRunId = ref<string | undefined>();
  let typingTimer: number | undefined;

  function resetPendingAgentResponse() {
    stopPendingAgentTyping();
    agentResponsePending.value = false;
    pendingAgentReceivedContent.value = "";
    pendingAgentDisplayedContent.value = "";
    pendingAgentActivity.value = [];
    pendingAgentStreamItems.value = [];
    pendingAgentRunId.value = undefined;
  }

  function stopPendingAgentTyping() {
    if (typingTimer === undefined) return;
    window.clearTimeout(typingTimer);
    typingTimer = undefined;
  }

  function flushPendingAgentTyping() {
    stopPendingAgentTyping();
    pendingAgentDisplayedContent.value = pendingAgentReceivedContent.value;
    pendingAgentStreamItems.value = pendingAgentStreamItems.value.map((item) => item.kind === "activity" ? item : { ...item, displayedText: item.receivedText });
  }

  function schedulePendingAgentTyping() {
    if (typingTimer === undefined) typingTimer = window.setTimeout(tickPendingAgentTyping, 16);
  }

  function tickPendingAgentTyping() {
    typingTimer = undefined;
    if (!agentResponsePending.value) return;
    const received = pendingAgentReceivedContent.value;
    const displayed = pendingAgentDisplayedContent.value;
    if (displayed.length < received.length) {
      const remaining = received.length - displayed.length;
      const step = remaining > 160 ? 8 : remaining > 60 ? 4 : 1;
      pendingAgentDisplayedContent.value = received.slice(0, displayed.length + step);
    }
    const activeItem = pendingAgentStreamItems.value.find((item) => item.kind !== "activity" && item.displayedText.length < item.receivedText.length);
    if (activeItem?.kind !== "activity" && activeItem) {
      const remaining = activeItem.receivedText.length - activeItem.displayedText.length;
      const step = remaining > 160 ? 8 : remaining > 60 ? 4 : 1;
      pendingAgentStreamItems.value = pendingAgentStreamItems.value.map((item) => item.id === activeItem.id && item.kind !== "activity" ? { ...item, displayedText: item.receivedText.slice(0, item.displayedText.length + step) } : item);
    }
    if (pendingAgentDisplayedContent.value.length < received.length || pendingAgentStreamItems.value.some((item) => item.kind !== "activity" && item.displayedText.length < item.receivedText.length)) {
      typingTimer = window.setTimeout(tickPendingAgentTyping, 18);
    }
  }

  function pendingAgentDisplayedPlainText(): string {
    if (pendingAgentStreamItems.value.length === 0) return pendingAgentDisplayedContent.value;
    return pendingAgentStreamItems.value.flatMap((item) => item.kind === "activity" ? [] : [item.displayedText]).filter(Boolean).join("\n\n");
  }

  function appendPendingAgentText(kind: "reasoning_text" | "assistant_text", text: string) {
    if (!text) return;
    pendingAgentReceivedContent.value += text;
    const last = pendingAgentStreamItems.value.at(-1);
    if (last?.kind === kind) {
      pendingAgentStreamItems.value = pendingAgentStreamItems.value.map((item) => item.id === last.id && item.kind !== "activity" ? { ...item, receivedText: item.receivedText + text } : item);
    } else {
      pendingAgentStreamItems.value = [...pendingAgentStreamItems.value, { id: `stream-text-${Date.now()}-${pendingAgentStreamItems.value.length}`, kind, receivedText: text, displayedText: "" }];
    }
    schedulePendingAgentTyping();
  }

  function appendPendingAgentActivity(activity: WorkActivityItem, event: BackendEventRecord) {
    pendingAgentActivity.value = [...pendingAgentActivity.value.filter((item) => item.kind !== activity.kind), activity];
    pendingAgentStreamItems.value = appendStreamActivity(pendingAgentStreamItems.value, activity, `stream-activity-${event.id}`);
  }

  function codexStyleStreamItemsForEvents(events: BackendEventRecord[]): PendingAgentStreamItem[] {
    const items: PendingAgentStreamItem[] = [];
    const appendText = (kind: "reasoning_text" | "assistant_text", text: string, id: string) => {
      if (!text) return;
      const last = items.at(-1);
      if (last?.kind === kind) {
        items[items.length - 1] = { ...last, receivedText: `${last.receivedText}${text}`, displayedText: `${last.displayedText}${text}` };
      } else {
        items.push({ id, kind, receivedText: text, displayedText: text });
      }
    };
    for (const event of events) {
      if (event.event_type === "agent_reasoning" && typeof event.payload.text === "string") appendText("reasoning_text", event.payload.text, `saved-reasoning-${event.id}`);
      else if (event.event_type === "host_progress" && typeof event.payload.text === "string") {
        if (event.payload.display_kind === "reasoning_summary") appendText("reasoning_text", event.payload.text, `saved-host-progress-${event.id}`);
        else items.splice(0, items.length, ...appendStreamActivity(items, { kind: "workspace_prepared", label: event.payload.text }, `saved-host-activity-${event.id}`));
      } else if (event.event_type === "text_delta" && typeof event.payload.text === "string") appendText("assistant_text", event.payload.text, `saved-text-${event.id}`);
      else {
        const activity = classifyEvent(event);
        if (activity) items.splice(0, items.length, ...appendStreamActivity(items, activity, `saved-activity-${event.id}`));
      }
    }
    return items;
  }

  return {
    agentResponsePending, pendingAgentReceivedContent, pendingAgentDisplayedContent, pendingAgentActivity,
    pendingAgentStreamItems, pendingAgentRunId, resetPendingAgentResponse, stopPendingAgentTyping,
    flushPendingAgentTyping, pendingAgentDisplayedPlainText, appendPendingAgentText,
    appendPendingAgentActivity, codexStyleStreamItemsForEvents
  };
}

function appendStreamActivity(items: PendingAgentStreamItem[], activity: WorkActivityItem, id: string): PendingAgentStreamItem[] {
  const last = items.at(-1);
  if (last?.kind === "activity") {
    if (last.activity.kind === activity.kind && normalizeLabel(last.activity.label) === normalizeLabel(activity.label)) {
      const count = (last.activity.count ?? 1) + 1;
      return items.map((item) => item.id === last.id && item.kind === "activity" ? { ...item, activity: { ...activity, count, label: count > 1 ? `${normalizeLabel(activity.label)} ${count}件` : normalizeLabel(activity.label) } } : item);
    }
    return [...items, { id: `${id}-reasoning-bridge`, kind: "reasoning_text", receivedText: "作業結果を確認し、次の手順に進んでいます。", displayedText: "作業結果を確認し、次の手順に進んでいます。" }, { id, kind: "activity", activity }];
  }
  return [...items, { id, kind: "activity", activity }];
}

function normalizeLabel(label: string): string {
  return label.replace(/\s+\d+件$/, "").trim();
}
