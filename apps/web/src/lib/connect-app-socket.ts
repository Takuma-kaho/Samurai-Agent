import type { Ref } from "vue";
import { io } from "socket.io-client";
import type { ActivityInboxItem, ApprovalRequest, BackendEventRecord, BackendRunRecord, OperationRecord, PolicyDecisionRecord, SessionRecord, SettingsRecord, WorkspaceChangeRecord } from "@samurai-agent/core-schemas";
import { getApiBaseUrl } from "./api";

export function connectAppSocket(input: {
  activeSession: Ref<SessionRecord | null>;
  activity: Ref<ActivityInboxItem[]>;
  approvalRequests: Ref<ApprovalRequest[]>;
  operations: Ref<OperationRecord[]>;
  policyDecisions: Ref<PolicyDecisionRecord[]>;
  backendRuns: Ref<BackendRunRecord[]>;
  backendEvents: Ref<BackendEventRecord[]>;
  workspaceChanges: Ref<WorkspaceChangeRecord[]>;
  settings: Ref<SettingsRecord>;
  acceptSession: (session: SessionRecord) => boolean;
  promoteSession: (session: SessionRecord) => void;
  applyStreamingRun: (run: BackendRunRecord) => void;
  applyStreamingEvent: (event: BackendEventRecord) => void;
  persistSettings: (settings: SettingsRecord) => void;
  reloadActiveSession: () => Promise<void>;
}) {
  const socket = io(getApiBaseUrl());
  socket.on("session.created", (session: SessionRecord) => { if (input.acceptSession(session)) input.promoteSession(session); });
  socket.on("activity.updated", (items: ActivityInboxItem[]) => { input.activity.value = items; });
  socket.on("approval.requested", (item: ApprovalRequest) => { input.approvalRequests.value = replaceFirst(input.approvalRequests.value, item); });
  socket.on("operation.created", (item: OperationRecord) => { input.operations.value = replaceFirst(input.operations.value, item); });
  socket.on("policy.decided", (item: PolicyDecisionRecord) => { input.policyDecisions.value = replaceFirst(input.policyDecisions.value, item); });
  const receiveRun = (run: BackendRunRecord) => { input.backendRuns.value = replaceFirst(input.backendRuns.value, run); input.applyStreamingRun(run); };
  socket.on("backend.run.created", receiveRun);
  socket.on("backend.run.updated", receiveRun);
  socket.on("backend.event.created", (event: BackendEventRecord) => { input.backendEvents.value = replaceOrAppend(input.backendEvents.value, event).sort((a, b) => a.sequence - b.sequence); input.applyStreamingEvent(event); });
  socket.on("workspace.change.created", (item: WorkspaceChangeRecord) => { input.workspaceChanges.value = replaceFirst(input.workspaceChanges.value, item); });
  socket.on("settings.updated", (settings: SettingsRecord) => { input.settings.value = settings; input.persistSettings(settings); });
  socket.on("artifact.created", () => { void input.reloadActiveSession(); });
  socket.on("memory.candidate.created", () => { void input.reloadActiveSession(); });
  return socket;
}

function replaceFirst<T extends { id: string }>(items: T[], item: T): T[] { return [item, ...items.filter((candidate) => candidate.id !== item.id)]; }
function replaceOrAppend<T extends { id: string }>(items: T[], item: T): T[] { return [...items.filter((candidate) => candidate.id !== item.id), item]; }
