/**
 * B shard: hand-reviewed Handler contracts for automation, gateway, image,
 * browser, chat, external send, MCP, and sandbox operations.
 *
 * The cases below are static review fixtures. They do not derive expected
 * method calls from the production Handlers.
 */

export type HandlerArgExpectation = { readonly $handler_matrix: "function" };

export interface BHandlerCallExpectation {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface BHandlerNestedBranch {
  /** JSON path inside the parsed public DTO. An empty path means the DTO root. */
  readonly path: readonly string[];
  /** Frozen static-catalog anyOf/oneOf branch index. */
  readonly branch: number;
  /** Human-readable branch identity checked against the parsed DTO. */
  readonly label: string;
}

export interface BHandlerCaseExpectation {
  readonly id: string;
  readonly input: Record<string, unknown>;
  readonly branches: readonly string[];
  readonly context?: {
    readonly sessionId?: string;
    readonly runId?: string;
    readonly envelopeId?: string;
    readonly surfaceOperation?: { readonly id: string; readonly kind: string };
  };
  readonly nestedBranches?: readonly BHandlerNestedBranch[];
  readonly calls: readonly BHandlerCallExpectation[];
}

export interface BHandlerExpectation {
  readonly requiredBranches: readonly string[];
  readonly cases: readonly BHandlerCaseExpectation[];
}

export const fn = { $handler_matrix: "function" } as const;
export const call = (method: string, ...args: unknown[]): BHandlerCallExpectation => ({ method, args });

const now = "2026-07-17T00:00:00.000Z";
const handlerContext = {
  inputSource: "runtime_api",
  workspaceId: "handler-matrix-workspace",
  actorId: "handler-matrix-actor",
  correlationId: "handler-matrix",
  sessionId: "session_fixture",
  runId: "run_fixture"
};
const locales = ["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"] as const;
const gatewayChannels = ["telegram", "slack", "line", "email", "mobile", "webhook", "local_cli", "cron"] as const;
const externalChannels = ["webhook", "email", "slack", "telegram", "line"] as const;
const imageMimeTypes = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] as const;
const automationJobKinds = ["memory_review", "learning_evaluation", "skill_curator", "wiki_reindex", "daily_digest", "resource_translation", "custom_instruction"] as const;

const session = {
  id: "session_fixture",
  session_key: "session_fixture",
  title: "Fixture session",
  ui_locale: "en",
  output_locale: "en",
  created_at: now,
  updated_at: now
};
const envelope = {
  id: "envelope_fixture",
  source: "web",
  actor_identity: "owner",
  session_key: "session_fixture",
  user_intent: "Fixture intent",
  attachments: [],
  input_locale: "en",
  output_locale: "en",
  metadata: {},
  received_at: now
};
const operation = {
  id: "operation_fixture",
  session_id: "session_fixture",
  capability_id: "fixture",
  operation: "fixture",
  actor_identity: "owner",
  instruction_source: "owner_instruction",
  instruction_authority: "owner",
  channel: "test",
  input_hash: "fixture_hash",
  target_resource_refs: [],
  proposed_effects: [],
  status: "completed",
  created_at: now,
  updated_at: now
};
const rollbackPoint = {
  id: "rollback_fixture",
  operation_id: "operation_fixture",
  affected_resources: [],
  before_snapshot: {},
  after_snapshot: {},
  reversible: true,
  irreversible_effects: [],
  created_at: now,
  expires_at: "2099-01-01T00:00:00.000Z"
};
const automationJob = {
  id: "automation_fixture",
  title: "Fixture automation",
  kind: "daily_digest",
  status: "enabled",
  schedule: "every 24 hours",
  target_instruction: "Run the fixture automation.",
  delivery_target: { channel: "activity" },
  next_run_at: now,
  locked_until: "2099-01-01T00:00:00.000Z",
  failure_count: 0,
  max_attempts: 3,
  created_at: now,
  updated_at: now
};
const automationJobRef = (id: string, label: string) => ({ kind: "automation_job", id, uri: `automation-jobs/${id}`, label });
const fixtureAutomationJobRef = automationJobRef("automation_fixture", "Fixture automation");
const generatedAutomationJob = (kind: string, index: number) => ({
  id: "$generated:automation-id",
  title: `Automation ${kind}`,
  kind,
  status: index === 1 ? "disabled" : "enabled",
  schedule: index === 0 ? "once" : "every 24 hours",
  target_instruction: `Run ${kind}.`,
  delivery_target: index === 0 ? { channel: "activity", destination: "fixture" } : { channel: "activity" },
  next_run_at: index === 0 ? "2026-07-18T00:00:00.000Z" : "$generated:time",
  failure_count: 0,
  max_attempts: index === 0 ? 5 : 3,
  created_at: "$generated:time",
  updated_at: "$generated:time"
});
const scheduledContext = {
  source: "cron",
  actor_identity: "owner_scheduled",
  instruction_source: "scheduled_context",
  channel: "cron",
  session_key: "cron:automation:automation_fixture"
};
const scheduledMemoryReviewContext = {
  source: "cron",
  actor_identity: "owner_scheduled",
  instruction_source: "scheduled_context",
  channel: "cron",
  session_key: "cron:memory-review"
};
const startedAutomationRun = {
  id: "$generated:automationrun-id",
  kind: "daily_digest",
  source: "automation_job",
  status: "started",
  started_at: now
};
const scheduledAutomationRun = { ...startedAutomationRun, session_id: "session_fixture" };
const completedAutomationRun = {
  ...scheduledAutomationRun,
  backend_run_id: "backend_run_fixture",
  status: "completed",
  operation_id: "operation_fixture",
  completed_at: "$generated:time"
};
const startedMemoryReviewRun = {
  id: "$generated:automation_run-id",
  kind: "memory_review",
  source: "cron",
  status: "started",
  started_at: "$generated:time"
};
const scheduledMemoryReviewRun = { ...startedMemoryReviewRun, session_id: "session_fixture" };
const completedMemoryReviewRun = {
  ...scheduledMemoryReviewRun,
  status: "completed",
  operation_id: "operation_fixture",
  completed_at: "$generated:time"
};
const memoryReviewTrace = {
  reflectionRun: {
    id: "reflection_run_fixture",
    kind: "background_review",
    session_id: "session_fixture",
    status: "completed",
    input_summary: "Fixture memory review",
    output_summary: "No changes",
    started_at: now,
    completed_at: now
  },
  suggestions: []
};
const browserPage = {
  url: "https://example.com/fixture",
  title: "Fixture browser",
  html: "<main>fixture</main>",
  text: "Fixture browser text",
  adapter: "fixture_browser"
};
const browserInteraction = {
  url: "https://example.com/fixture",
  title: "Fixture browser",
  adapterId: "fixture_browser",
  action: "navigate",
  text: "Fixture browser text"
};
const externalSend = {
  id: "external_send_fixture",
  channel: "webhook",
  status: "approved",
  target: {},
  title: "Fixture external send",
  body: "Fixture body",
  created_at: now,
  updated_at: now
};
const externalSendRef = { kind: "external_send", id: "external_send_fixture", uri: "external-sends/external_send_fixture", label: "Fixture external send" };
const imageArtifactRef = { kind: "artifact", id: "image_artifact_fixture", uri: "artifacts/image_artifact_fixture.png", label: "Fixture image" };
const imageArtifact = {
  id: "image_artifact_fixture",
  title: "Fixture image",
  kind: "image",
  locale: "en",
  source_locales: ["en"],
  file_ref: imageArtifactRef,
  metadata: { current_revision_id: "image_revision_fixture" },
  source_operation_id: "operation_fixture",
  created_by: "fixture",
  created_at: now,
  updated_at: now
};
const generatedImageArtifactRef = { kind: "artifact", id: "generated_image_fixture", uri: "artifacts/generated_image_fixture.png", label: "Generated image" };
const generatedImageArtifact = {
  id: "generated_image_fixture",
  title: "Generated image",
  kind: "image",
  locale: "en",
  source_locales: ["en"],
  file_ref: generatedImageArtifactRef,
  metadata: {},
  source_operation_id: "operation_fixture",
  created_by: "image_provider",
  created_at: now,
  updated_at: now
};
const imageRevisionRef = { kind: "artifact_revision", id: "image_revision_fixture", uri: "artifacts/image_artifact_fixture/revisions/image_revision_fixture", label: "Fixture image revision" };
const imageRevision = {
  id: "image_revision_fixture",
  artifact_id: "image_artifact_fixture",
  revision: 2,
  parent_revision_id: "image_revision_parent",
  source_ref: imageArtifactRef,
  file_ref: imageRevisionRef,
  blob_ref: { kind: "file", id: "blobs/image_revision_fixture", uri: "blobs/image_revision_fixture", label: "Fixture image blob" },
  content_hash: "image_hash",
  content_bytes: 4,
  created_at: now
};
const configRef = { kind: "file", id: "gateway/mcp.json", uri: "gateway/mcp.json", label: "MCP config" };
const secretRef = { id: "secret_fixture", source: "env", provider: "fixture", key: "FIXTURE_SECRET", label: "Fixture secret", scope: "workspace", created_at: now };
const pendingPairing = {
  id: "pairing_fixture",
  channel: "telegram",
  source_identity: "fixture-user",
  source_label: "Fixture user",
  status: "pending",
  pairing_code: "ABCDEF",
  session_key: "gateway:fixture-user",
  metadata: {},
  requested_at: now,
  expires_at: "2099-01-01T00:00:00.000Z",
  updated_at: now
};
const approvedPairing = { ...pendingPairing, status: "approved", pairing_code: undefined, resolved_at: now };
const expiredPairing = { ...pendingPairing, status: "expired", pairing_code: undefined, resolved_at: now };

const automationMutation = (operationName: string, proposedEffects: readonly string[], extra: Record<string, unknown> = {}) => ({
  session,
  envelope,
  operationName,
  proposedEffects,
  execute: fn,
  ...extra
});
const browserMutation = (operationName: string, url: string) => ({
  session,
  envelope,
  operationName,
  proposedEffects: [`${operationName} ${url} without mutating external state.`],
  execute: fn
});
const artifactMutation = (operationName: string, inputSummary: string, proposedEffects: readonly string[], extra: Record<string, unknown> = {}) => ({
  trustedContext: handlerContext,
  inputSummary,
  operationName,
  proposedEffects,
  execute: fn,
  ...extra
});
const externalMutation = (operationName: string, proposedEffects: readonly string[], extra: Record<string, unknown> = {}) => ({
  session,
  envelope,
  operationName,
  proposedEffects,
  execute: fn,
  ...extra
});

const imageExtension = (mimeType: string) => ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" } as Record<string, string>)[mimeType]!;

/**
 * The literals cover every frozen-catalog top-level key, required key, enum
 * value, and input union branch. Callback entries are the sole matcher form.
 */
export const bHandlerExpectations = {
  "automation.job.release_lock": {
    requiredBranches: ["now:explicit", "now:default"],
    cases: [
      { id: "explicit-now", input: { job_id: "automation_fixture", now }, branches: ["now:explicit"], calls: [call("releaseAutomationJobLock", "automation_fixture", now)] },
      { id: "default-now", input: { job_id: "automation_fixture" }, branches: ["now:default"], calls: [call("releaseAutomationJobLock", "automation_fixture", undefined)] }
    ]
  },
  "automation.job.requeue": {
    requiredBranches: ["next_run_at:explicit", "next_run_at:default"],
    cases: [
      { id: "explicit-next-run", input: { job_id: "automation_fixture", next_run_at: "2026-07-18T00:00:00.000Z" }, branches: ["next_run_at:explicit"], calls: [call("requeueAutomationJob", "automation_fixture", "2026-07-18T00:00:00.000Z")] },
      { id: "default-next-run", input: { job_id: "automation_fixture" }, branches: ["next_run_at:default"], calls: [call("requeueAutomationJob", "automation_fixture", undefined)] }
    ]
  },
  "automation.job.run": {
    requiredBranches: ["lock:acquired", "kind:daily_digest"],
    cases: [{
      id: "daily-digest",
      input: { job_id: "automation_fixture", now },
      branches: ["lock:acquired", "kind:daily_digest"],
      calls: [
        call("getAutomationJob", "automation_fixture"),
        call("acquireAutomationJobLock", "automation_fixture", { lockedUntil: "2026-07-17T00:15:00.000Z", now }),
        call("createAutomationRun", startedAutomationRun),
        call("ensureScheduledAutomationSession", scheduledContext, "Fixture automation"),
        call("updateAutomationRun", scheduledAutomationRun),
        call("createScheduledAutomationEnvelope", scheduledContext, "Run the fixture automation."),
        call("automationJobRef", automationJob),
        call("runScheduledAutomationMutation", {
          session,
          envelope,
          context: scheduledContext,
          operationName: "automation.job.run",
          inputRef: fixtureAutomationJobRef,
          proposedEffects: ["Run automation job Fixture automation."],
          execute: fn
        }),
        call("runAutomationInstruction", automationJob, session, scheduledContext),
        call("updateAutomationRun", completedAutomationRun),
        call("saveAutomationJobRecord", {
          ...automationJob,
          status: "enabled",
          last_run_at: "$generated:time",
          next_run_at: "$generated:time",
          retry_after_at: undefined,
          locked_until: undefined,
          failure_count: 0,
          last_error: undefined,
          updated_at: "$generated:time"
        })
      ]
    }]
  },
  "automation.job.save": {
    requiredBranches: [
      ...automationJobKinds.map((kind) => `kind:${kind}`),
      "status:enabled",
      "status:disabled",
      "next_run_at:explicit",
      "next_run_at:generated"
    ],
    cases: automationJobKinds.map((kind, index) => {
      const generated = generatedAutomationJob(kind, index);
      const input = {
        kind,
        title: `Automation ${kind}`,
        schedule: index === 0 ? "once" : "every 24 hours",
        target_instruction: `Run ${kind}.`,
        ...(index === 0 ? { delivery_target: { channel: "activity", destination: "fixture" }, enabled: true, max_attempts: 5, next_run_at: "2026-07-18T00:00:00.000Z" } : {}),
        ...(index === 1 ? { enabled: false } : {})
      };
      return {
        id: `kind-${kind}`,
        input,
        branches: [`kind:${kind}`, index === 1 ? "status:disabled" : "status:enabled", index === 0 ? "next_run_at:explicit" : "next_run_at:generated"],
        calls: [
          call("automationJobContract", "automation.job.save"),
          call("ensureAutomationSession"),
          call("createAutomationEnvelope", `Save automation job: Automation ${kind}`),
          call("runAutomationJobMutation", automationMutation("automation.job.save", ["Save an automation job definition."])),
          call("saveAutomationJobRecord", generated),
          call("automationJobRef", generated),
          call("createAutomationRollback", operation, [automationJobRef("$generated:automation-id", `Automation ${kind}`)], {}, { automation_job: generated })
        ]
      };
    })
  },
  "automation.job.set_status": {
    requiredBranches: ["status:enabled", "status:disabled"],
    cases: [
      {
        id: "enable",
        input: { job_id: "automation_fixture", status: "enabled" },
        branches: ["status:enabled"],
        calls: [
          call("getAutomationJob", "automation_fixture"),
          call("automationJobContract", "automation.job.set_status"),
          call("ensureAutomationSession"),
          call("createAutomationEnvelope", "Resume automation: Fixture automation"),
          call("automationJobRef", automationJob),
          call("runAutomationJobMutation", automationMutation("automation.job.set_status", ["Change an Automation job between enabled and disabled."], { targetResourceRefs: [fixtureAutomationJobRef] })),
          call("saveAutomationJobRecord", { ...automationJob, status: "enabled", locked_until: "2099-01-01T00:00:00.000Z", updated_at: "$generated:time" }),
          call("automationJobRef", { ...automationJob, status: "enabled", locked_until: "2099-01-01T00:00:00.000Z", updated_at: "$generated:time" }),
          call("createAutomationRollback", operation, [fixtureAutomationJobRef], { automation_job: automationJob }, { automation_job: { ...automationJob, status: "enabled", locked_until: "2099-01-01T00:00:00.000Z", updated_at: "$generated:time" } })
        ]
      },
      {
        id: "disable",
        input: { job_id: "automation_fixture", status: "disabled" },
        branches: ["status:disabled"],
        calls: [
          call("getAutomationJob", "automation_fixture"),
          call("automationJobContract", "automation.job.set_status"),
          call("ensureAutomationSession"),
          call("createAutomationEnvelope", "Pause automation: Fixture automation"),
          call("automationJobRef", automationJob),
          call("runAutomationJobMutation", automationMutation("automation.job.set_status", ["Change an Automation job between enabled and disabled."], { targetResourceRefs: [fixtureAutomationJobRef] })),
          call("saveAutomationJobRecord", { ...automationJob, status: "disabled", locked_until: undefined, updated_at: "$generated:time" }),
          call("automationJobRef", { ...automationJob, status: "disabled", locked_until: undefined, updated_at: "$generated:time" }),
          call("createAutomationRollback", operation, [fixtureAutomationJobRef], { automation_job: automationJob }, { automation_job: { ...automationJob, status: "disabled", updated_at: "$generated:time" } })
        ]
      }
    ]
  },
  "automation.memory_review.run": {
    requiredBranches: ["scheduled:memory-review"],
    cases: [{
      id: "scheduled",
      input: {},
      branches: ["scheduled:memory-review"],
      calls: [
        call("createAutomationRun", startedMemoryReviewRun),
        call("ensureScheduledAutomationSession", scheduledMemoryReviewContext, "Scheduled memory review"),
        call("updateAutomationRun", scheduledMemoryReviewRun),
        call("createScheduledAutomationEnvelope", scheduledMemoryReviewContext, "Run scheduled memory review."),
        call("runScheduledAutomationMutation", {
          session,
          envelope,
          context: scheduledMemoryReviewContext,
          operationName: "automation.memory_review.run",
          inputRef: { kind: "automation_run", id: "$generated:automation_run-id", uri: "automation-runs/$generated:automation_run-id", label: "Automation run" },
          proposedEffects: ["Run scheduled memory review and deterministic curator without external effects."],
          execute: fn
        }),
        call("runScheduledMemoryReview", session),
        call("updateAutomationRun", completedMemoryReviewRun)
      ]
    }]
  },
  "browser.interact": {
    requiredBranches: ["action:navigate", "action:click", "action:input"],
    cases: [
      { id: "navigate", input: { url: "https://example.com/fixture" }, branches: ["action:navigate"], calls: [call("ensureBrowserSession"), call("createBrowserEnvelope", session, "browser.interact: https://example.com/fixture"), call("runBrowserMutation", browserMutation("browser.interact", "https://example.com/fixture")), call("interactWithBrowser", { url: "https://example.com/fixture", action: "navigate" }), call("stableBrowserHash", "https://example.com/fixture")] },
      { id: "click", input: { url: "https://example.com/fixture", action: "click", selector: "#save" }, branches: ["action:click"], calls: [call("ensureBrowserSession"), call("createBrowserEnvelope", session, "browser.interact: https://example.com/fixture"), call("runBrowserMutation", browserMutation("browser.interact", "https://example.com/fixture")), call("interactWithBrowser", { url: "https://example.com/fixture", action: "click", selector: "#save" }), call("stableBrowserHash", "https://example.com/fixture")] },
      { id: "input", input: { url: "https://example.com/fixture", action: "input", selector: "#name", value: "Fixture" }, branches: ["action:input"], calls: [call("ensureBrowserSession"), call("createBrowserEnvelope", session, "browser.interact: https://example.com/fixture"), call("runBrowserMutation", browserMutation("browser.interact", "https://example.com/fixture")), call("interactWithBrowser", { url: "https://example.com/fixture", action: "input", selector: "#name", value: "Fixture" }), call("stableBrowserHash", "https://example.com/fixture")] }
    ]
  },
  "browser.navigate": {
    requiredBranches: ["page:read"],
    cases: [{ id: "page", input: { url: "https://example.com/fixture" }, branches: ["page:read"], calls: [call("ensureBrowserSession"), call("createBrowserEnvelope", session, "browser.navigate: https://example.com/fixture"), call("runBrowserMutation", browserMutation("browser.navigate", "https://example.com/fixture")), call("readBrowserPage", "https://example.com/fixture"), call("stableBrowserHash", "https://example.com/fixture")] }]
  },
  "chat.turn.run": {
    requiredBranches: ["session:existing", "surface:present"],
    cases: [
      {
        id: "existing-surface-full-input",
        input: {
          content: "Fixture chat",
          agent_id: "agent_fixture",
          backend_id: "backend_fixture",
          input_locale: "ja",
          output_locale: "en",
          attachments: [{ kind: "artifact", id: "artifact_fixture", uri: "artifacts/artifact_fixture.md", label: "Fixture artifact" }],
          temporary_context: [{ id: "temporary_fixture", kind: "desktop_screenshot", label: "Fixture screenshot", source_name: "screen.png", mime_type: "image/png", data_url: "data:image/png;base64,AAAA", file_path: "screens/screen.png", created_at: now, expires_at: "2099-01-01T00:00:00.000Z", metadata: { fixture: true } }],
          metadata: { fixture: "chat" }
        },
        context: { sessionId: "session_fixture", idempotencyKey: "handler-matrix-chat-turn", surfaceOperation: { id: "surface_operation_fixture", kind: "message.submit" } },
        branches: ["session:existing", "surface:present"],
        calls: [call("runChatTurn", {
          ...handlerContext,
          idempotencyKey: "handler-matrix-chat-turn",
          surfaceOperation: { id: "surface_operation_fixture", kind: "message.submit" }
        }, {
          sessionId: "session_fixture",
          content: "Fixture chat",
          idempotencyKey: "handler-matrix-chat-turn",
          agent_id: "agent_fixture",
          backend_id: "backend_fixture",
          input_locale: "ja",
          output_locale: "en",
          attachments: [{ kind: "artifact", id: "artifact_fixture", uri: "artifacts/artifact_fixture.md", label: "Fixture artifact" }],
          temporary_context: [{ id: "temporary_fixture", kind: "desktop_screenshot", label: "Fixture screenshot", source_name: "screen.png", mime_type: "image/png", data_url: "data:image/png;base64,AAAA", file_path: "screens/screen.png", created_at: now, expires_at: "2099-01-01T00:00:00.000Z", metadata: { fixture: true } }],
          metadata: { fixture: "chat", surface_operation_id: "surface_operation_fixture", surface_operation_kind: "message.submit" }
        })]
      }
    ]
  },
  "external.send": {
    requiredBranches: ["body:body", "body:content", "body:user_intent", "body:fallback", ...externalChannels.map((channel) => `channel:${channel}`)],
    cases: externalChannels.map((channel, index) => {
      const input = {
        channel,
        ...(index === 0 ? { body: "Body wins", target: { url: "https://example.com/hook" }, title: "Webhook send" } : {}),
        ...(index === 1 ? { content: "Content wins", title: "Email send" } : {}),
        ...(index === 2 ? { user_intent: "Intent wins", title: "Slack send" } : {}),
        ...(index === 4 ? { body: "Line body", title: "Line send" } : {})
      };
      const title = index === 0 ? "Webhook send" : index === 1 ? "Email send" : index === 2 ? "Slack send" : index === 4 ? "Line send" : "External send request";
      const body = index === 0 ? "Body wins" : index === 1 ? "Content wins" : index === 2 ? "Intent wins" : index === 4 ? "Line body" : "External send requested by backend.";
      const target = index === 0 ? { url: "https://example.com/hook" } : {};
      const draft = { id: "external_send_fixture", channel, status: "draft", target, title, body, created_at: now, updated_at: now };
      return {
        id: `channel-${channel}`,
        input,
        branches: [`channel:${channel}`, index === 0 ? "body:body" : index === 1 ? "body:content" : index === 2 ? "body:user_intent" : index === 3 ? "body:fallback" : "body:body"],
        calls: [
          call("ensureExternalSendSession"),
          call("createExternalSendEnvelope", session, `Prepare external send: ${title}`),
          call("externalSendNow"),
          call("createExternalSendId"),
          call("runExternalSendMutation", externalMutation("external.send", ["Create an outbound send draft without dispatching."])),
          call("saveExternalSend", { ...draft, operation_id: "operation_fixture" }),
          call("createExternalSendRollback", operation, [{ kind: "external_send", id: "external_send_fixture", uri: "external-sends/external_send_fixture", label: title }], {}, { external_send: { ...draft, operation_id: "operation_fixture" } })
        ]
      };
    })
  },
  "external.send.prepare": {
    requiredBranches: externalChannels.map((channel) => `channel:${channel}`),
    cases: externalChannels.map((channel, index) => {
      const title = index === 0 ? "Prepared webhook" : "";
      const body = index === 0 ? "Prepared body" : "";
      const target = index === 0 ? { url: "https://example.com/hook" } : {};
      const draft = { id: "external_send_fixture", channel, status: "draft", target, title, body, created_at: now, updated_at: now };
      return {
        id: `channel-${channel}`,
        input: { channel, ...(index === 0 ? { title, body, target } : {}) },
        branches: [`channel:${channel}`],
        calls: [
          call("ensureExternalSendSession"),
          call("createExternalSendEnvelope", session, `Prepare external send: ${title}`),
          call("externalSendNow"),
          call("createExternalSendId"),
          call("runExternalSendMutation", externalMutation("external.send.prepare", ["Create an outbound send draft without dispatching."])),
          call("saveExternalSend", { ...draft, operation_id: "operation_fixture" }),
          call("createExternalSendRollback", operation, [{ kind: "external_send", id: "external_send_fixture", uri: "external-sends/external_send_fixture", label: title }], {}, { external_send: { ...draft, operation_id: "operation_fixture" } })
        ]
      };
    })
  },
  "external.send.dispatch": {
    requiredBranches: ["dry_run:false", "dry_run:true", "dry_run:default", "dispatch:sent", "dispatch:dry-run"],
    cases: [
      {
        id: "sent",
        input: { send_id: "external_send_fixture", dry_run: false },
        branches: ["dry_run:false", "dispatch:sent"],
        calls: [
          call("getExternalSend", "external_send_fixture"),
          call("ensureExternalSendSession"),
          call("createExternalSendEnvelope", session, "Dispatch external send: Fixture external send"),
          call("runExternalSendMutation", externalMutation("external.send.dispatch", ["Dispatch a prepared outbound send to an external channel."], { inputRef: externalSendRef, targetResourceRefs: [externalSendRef] })),
          call("dispatchExternalSend", externalSend, false),
          call("externalSendNow"),
          call("saveExternalSend", { ...externalSend, status: "dispatched", operation_id: "operation_fixture", dispatch_result: { dispatched: true, adapter: "fixture_adapter", dry_run: false, message: "Fixture sent", transport: "webhook", status: 202 }, updated_at: now, dispatched_at: now })
        ]
      },
      {
        id: "explicit-dry-run",
        input: { send_id: "external_send_fixture", dry_run: true },
        branches: ["dry_run:true", "dispatch:dry-run"],
        calls: [
          call("getExternalSend", "external_send_fixture"),
          call("ensureExternalSendSession"),
          call("createExternalSendEnvelope", session, "Dispatch external send: Fixture external send"),
          call("runExternalSendMutation", externalMutation("external.send.dispatch", ["Dispatch a prepared outbound send to an external channel."], { inputRef: externalSendRef, targetResourceRefs: [externalSendRef] })),
          call("dispatchExternalSend", externalSend, true),
          call("externalSendNow"),
          call("saveExternalSend", { ...externalSend, status: "approved", operation_id: "operation_fixture", dispatch_result: { dispatched: false, adapter: "fixture_adapter", dry_run: true, message: "Fixture dry run", transport: "webhook", status: 202 }, updated_at: now, dispatched_at: undefined })
        ]
      },
      {
        id: "default-dry-run",
        input: { send_id: "external_send_fixture" },
        branches: ["dry_run:default"],
        calls: [
          call("getExternalSend", "external_send_fixture"),
          call("ensureExternalSendSession"),
          call("createExternalSendEnvelope", session, "Dispatch external send: Fixture external send"),
          call("runExternalSendMutation", externalMutation("external.send.dispatch", ["Dispatch a prepared outbound send to an external channel."], { inputRef: externalSendRef, targetResourceRefs: [externalSendRef] })),
          call("externalSendDefaultDryRun"),
          call("dispatchExternalSend", externalSend, true),
          call("externalSendNow"),
          call("saveExternalSend", { ...externalSend, status: "approved", operation_id: "operation_fixture", dispatch_result: { dispatched: false, adapter: "fixture_adapter", dry_run: true, message: "Fixture dry run", transport: "webhook", status: 202 }, updated_at: now, dispatched_at: undefined })
        ]
      }
    ]
  },
  "gateway.inbound.route": {
    requiredBranches: gatewayChannels.map((channel) => `channel:${channel}`),
    cases: gatewayChannels.map((channel, index) => {
      const inputLocale = locales[index]!;
      const outputLocale = locales[(index + 1) % locales.length]!;
      const full = index === 0;
      const input = {
        channel,
        source_identity: `source-${channel}`,
        body: `Fixture ${channel}`,
        input_locale: inputLocale,
        output_locale: outputLocale,
        ...(full ? { account_id: "account_fixture", backend_id: "backend_fixture", metadata: { fixture: channel }, route: "fixture-route", source_label: "Fixture source", thread_id: "thread_fixture" } : {})
      };
      return {
        id: `channel-${channel}`,
        input,
        branches: [`channel:${channel}`],
        calls: [call("routeGatewayInbound", {
          channel,
          sourceIdentity: `source-${channel}`,
          body: `Fixture ${channel}`,
          sourceLabel: full ? "Fixture source" : undefined,
          accountId: full ? "account_fixture" : undefined,
          threadId: full ? "thread_fixture" : undefined,
          route: full ? "fixture-route" : undefined,
          metadata: full ? { fixture: channel } : {},
          backendId: full ? "backend_fixture" : undefined,
          inputLocale: inputLocale,
          outputLocale: outputLocale
        })]
      };
    })
  },
  "gateway.mcp_config.save": {
    requiredBranches: ["transport:stdio", "transport:http"],
    cases: [
      {
        id: "stdio",
        input: {
          id: "mcp_stdio_fixture", server_name: "stdio-fixture", enabled: true, allowed_tools: ["search"], config_ref: configRef, secret_refs: [secretRef], metadata: { fixture: "stdio" },
          transport: "stdio",
          stdio: { command: "node", args: ["server.js"], cwd: "/tmp/mcp", env: { MODE: "test" }, secret_env: { TOKEN: "secret_fixture" }, secret_files: [{ secret_ref_id: "secret_fixture", filename: "token.txt", env: "TOKEN_FILE", mode: 384 }], framing: "content_length", initialize: false, timeout_ms: 1000 }
        },
        branches: ["transport:stdio"],
        nestedBranches: [{ path: [], branch: 0, label: "stdio" }],
        calls: [call("saveGatewayMcpConfig", {
          id: "mcp_stdio_fixture", serverName: "stdio-fixture", enabled: true, allowedTools: ["search"], configRef, secretRefs: [secretRef], metadata: { fixture: "stdio" },
          transport: "stdio",
          stdio: { command: "node", args: ["server.js"], cwd: "/tmp/mcp", environment: { MODE: "test" }, secretEnvironment: { TOKEN: "secret_fixture" }, secretFiles: [{ secretRefId: "secret_fixture", filename: "token.txt", environmentName: "TOKEN_FILE", mode: 384 }], framing: "content_length", initialize: false, timeoutMs: 1000 }
        })]
      },
      {
        id: "http",
        input: {
          id: "mcp_http_fixture", server_name: "http-fixture", enabled: false, allowed_tools: ["fetch"], config_ref: configRef, secret_refs: [secretRef], metadata: { fixture: "http" },
          transport: "http",
          http: { endpoint_url: "https://example.com/mcp", headers: { Accept: "application/json" }, secret_headers: { Authorization: "secret_fixture" }, timeout_ms: 2000 }
        },
        branches: ["transport:http"],
        nestedBranches: [{ path: [], branch: 1, label: "http" }],
        calls: [call("saveGatewayMcpConfig", {
          id: "mcp_http_fixture", serverName: "http-fixture", enabled: false, allowedTools: ["fetch"], configRef, secretRefs: [secretRef], metadata: { fixture: "http" },
          transport: "http",
          http: { endpointUrl: "https://example.com/mcp", headers: { Accept: "application/json" }, secretHeaders: { Authorization: "secret_fixture" }, timeoutMs: 2000 }
        })]
      }
    ]
  },
  "gateway.pairing_policy.save": {
    requiredBranches: [
      ...gatewayChannels.map((channel) => `channel:${channel}`),
      "status:enabled",
      "status:disabled",
      "trust:pairing_required",
      "trust:auto_approve",
      "trust:blocked"
    ],
    cases: gatewayChannels.map((channel, index) => {
      const status = index % 2 === 0 ? "enabled" : "disabled";
      const trustMode = (["pairing_required", "auto_approve", "blocked"] as const)[index % 3]!;
      const full = index === 0;
      const input = {
        channel,
        status,
        trust_mode: trustMode,
        allowlist: ["*"],
        ...(full ? { allowed_tools: ["browser.navigate"], pairing_ttl_ms: 60000, duplicate_window_ms: 120000, rate_limit_window_ms: 60000, rate_limit_max: 5, metadata: { fixture: true } } : {})
      };
      return {
        id: `channel-${channel}`,
        input,
        branches: [`channel:${channel}`, `status:${status}`, `trust:${trustMode}`],
        calls: [call("saveGatewayPairingPolicy", {
          channel,
          status,
          trustMode,
          allowlist: ["*"],
          allowedTools: full ? ["browser.navigate"] : undefined,
          pairingTtlMs: full ? 60000 : undefined,
          duplicateWindowMs: full ? 120000 : undefined,
          rateLimitWindowMs: full ? 60000 : undefined,
          rateLimitMax: full ? 5 : undefined,
          metadata: full ? { fixture: true } : undefined,
        })]
      };
    })
  },
  "gateway.pairing.approve": {
    requiredBranches: ["pending:approve"],
    cases: [{
      id: "approve",
      input: { pairing_id: "pairing_fixture" },
      branches: ["pending:approve"],
      calls: [
        call("requireGatewayPairing", "pairing_fixture"),
        call("saveGatewayPairing", { ...pendingPairing, status: "approved", pairing_code: undefined, resolved_at: "$generated:time", updated_at: "$generated:time" }),
        call("emitGatewayPairingUpdated", { ...pendingPairing, status: "approved", pairing_code: undefined, resolved_at: "$generated:time", updated_at: "$generated:time" })
      ]
    }]
  },
  "gateway.pairing.expire": {
    requiredBranches: ["now:explicit", "now:generated"],
    cases: [
      { id: "explicit-now", input: { now }, branches: ["now:explicit"], calls: [call("expireGatewayPairings", now), call("emitGatewayPairingUpdated", expiredPairing)] },
      { id: "generated-now", input: {}, branches: ["now:generated"], calls: [call("expireGatewayPairings", "$generated:time"), call("emitGatewayPairingUpdated", expiredPairing)] }
    ]
  },
  "gateway.pairing.reject": {
    requiredBranches: ["pending:reject"],
    cases: [{
      id: "reject",
      input: { pairing_id: "pairing_fixture" },
      branches: ["pending:reject"],
      calls: [
        call("requireGatewayPairing", "pairing_fixture"),
        call("saveGatewayPairing", { ...pendingPairing, status: "rejected", pairing_code: undefined, resolved_at: "$generated:time", updated_at: "$generated:time" }),
        call("emitGatewayPairingUpdated", { ...pendingPairing, status: "rejected", pairing_code: undefined, resolved_at: "$generated:time", updated_at: "$generated:time" })
      ]
    }]
  },
  "gateway.pairing.revoke": {
    requiredBranches: ["approved:revoke"],
    cases: [{
      id: "revoke",
      input: { pairing_id: "pairing_fixture" },
      branches: ["approved:revoke"],
      calls: [
        call("requireGatewayPairing", "pairing_fixture"),
        call("saveGatewayPairing", { ...approvedPairing, status: "revoked", pairing_code: undefined, revoked_at: "$generated:time", resolved_at: now, updated_at: "$generated:time" }),
        call("emitGatewayPairingUpdated", { ...approvedPairing, status: "revoked", pairing_code: undefined, revoked_at: "$generated:time", resolved_at: now, updated_at: "$generated:time" })
      ]
    }]
  },
  "gateway.pairing.rotate": {
    requiredBranches: ["pending:rotate"],
    cases: [{
      id: "rotate",
      input: { pairing_id: "pairing_fixture" },
      branches: ["pending:rotate"],
      calls: [
        call("requireGatewayPairing", "pairing_fixture"),
        call("saveGatewayPairing", { ...pendingPairing, pairing_code: "$generated:pairing-code", expires_at: "$generated:time", updated_at: "$generated:time" }),
        call("emitGatewayPairingUpdated", { ...pendingPairing, pairing_code: "$generated:pairing-code", expires_at: "$generated:time", updated_at: "$generated:time" })
      ]
    }]
  },
  "gateway.routing_policy.save": {
    requiredBranches: [
      ...gatewayChannels.map((channel) => `channel:${channel}`),
      "status:enabled",
      "status:disabled",
      "strategy:account_thread",
      "strategy:account_main",
      "strategy:channel_main"
    ],
    cases: gatewayChannels.map((channel, index) => {
      const status = index % 2 === 0 ? "enabled" : "disabled";
      const strategy = (["account_thread", "account_main", "channel_main"] as const)[index % 3]!;
      const full = index === 0;
      const input = {
        channel,
        status,
        session_key_strategy: strategy,
        default_route: "fixture-route",
        ...(full ? { default_account_id: "account_fixture", default_thread_id: "thread_fixture", metadata: { fixture: true } } : {})
      };
      return {
        id: `channel-${channel}`,
        input,
        branches: [`channel:${channel}`, `status:${status}`, `strategy:${strategy}`],
        calls: [call("saveGatewayRoutingPolicy", {
          channel,
          status,
          sessionKeyStrategy: strategy,
          defaultAccountId: full ? "account_fixture" : undefined,
          defaultThreadId: full ? "thread_fixture" : undefined,
          defaultRoute: "fixture-route",
          metadata: full ? { fixture: true } : undefined,
        })]
      };
    })
  },
  "gateway.sandbox.delete": {
    requiredBranches: ["sandbox:delete"],
    cases: [{ id: "delete", input: { sandbox_id: "sandbox_fixture" }, branches: ["sandbox:delete"], calls: [call("deleteGatewaySandbox", { sandboxId: "sandbox_fixture" })] }]
  },
  "gateway.sandbox.recreate": {
    requiredBranches: ["sandbox:recreate"],
    cases: [{ id: "recreate", input: { sandbox_id: "sandbox_fixture" }, branches: ["sandbox:recreate"], calls: [call("recreateGatewaySandbox", { sandboxId: "sandbox_fixture" })] }]
  },
  "gateway.sandbox.sync": {
    requiredBranches: ["direction:seed_to_sandbox", "direction:pull_from_sandbox", "direction:mirror", "direction:default", "dry_run:true", "dry_run:false"],
    cases: [
      { id: "seed", input: { sandbox_id: "sandbox_fixture", direction: "seed_to_sandbox", dry_run: false }, branches: ["direction:seed_to_sandbox", "dry_run:false"], calls: [call("syncGatewaySandbox", "sandbox_fixture", { direction: "seed_to_sandbox", dryRun: false })] },
      { id: "pull", input: { sandbox_id: "sandbox_fixture", direction: "pull_from_sandbox" }, branches: ["direction:pull_from_sandbox", "dry_run:true"], calls: [call("syncGatewaySandbox", "sandbox_fixture", { direction: "pull_from_sandbox", dryRun: true })] },
      { id: "mirror", input: { sandbox_id: "sandbox_fixture", direction: "mirror" }, branches: ["direction:mirror"], calls: [call("syncGatewaySandbox", "sandbox_fixture", { direction: "mirror", dryRun: true })] },
      { id: "default", input: { sandbox_id: "sandbox_fixture" }, branches: ["direction:default"], calls: [call("syncGatewaySandbox", "sandbox_fixture", { direction: undefined, dryRun: true })] }
    ]
  },
  "gateway.state.repair": {
    requiredBranches: ["dry_run:true", "dry_run:false", "now:explicit", "now:default"],
    cases: [
      { id: "explicit", input: { dry_run: false, now }, branches: ["dry_run:false", "now:explicit"], calls: [call("repairGatewayState", { dryRun: false, now })] },
      { id: "default", input: {}, branches: ["dry_run:true", "now:default"], calls: [call("repairGatewayState", { dryRun: true, now: undefined })] }
    ]
  },
  "image.edit": {
    requiredBranches: [...imageMimeTypes.map((mimeType) => `mime:${mimeType}`), "base_revision:explicit", "base_revision:current", "summary:explicit", "summary:default"],
    cases: imageMimeTypes.map((mimeType, index) => {
      const full = index !== 0;
      const input = {
        artifact_id: "image_artifact_fixture",
        data_base64: "QUJDRA==",
        height: 32,
        mime_type: mimeType,
        prompt: `Edit ${mimeType}`,
        provider: "fixture_provider",
        source_run_id: "run_fixture",
        width: 64,
        ...(full ? { base_revision_id: "base_revision_fixture", change_summary: `Saved ${mimeType}`, provenance: { fixture: mimeType } } : {})
      };
      const provenance = { operation: "edit", prompt: `Edit ${mimeType}`, provider: "fixture_provider", source_run_id: "run_fixture", mime_type: mimeType, width: 64, height: 32, source_asset_id: "image_artifact_fixture", ...(full ? { fixture: mimeType } : {}) };
      return {
        id: `mime-${mimeType}`,
        input,
        branches: [`mime:${mimeType}`, full ? "base_revision:explicit" : "base_revision:current", full ? "summary:explicit" : "summary:default"],
        calls: [
          call("getArtifact", "image_artifact_fixture"),
          call("artifactContract", "image.edit"),
          call("decodeImageBase64", "QUJDRA=="),
          call("runArtifactMutation", artifactMutation("image.edit", "Save edited image: Fixture image", ["Save an edited image result as a new Artifact revision while preserving the original asset."], { targetResourceRefs: [imageArtifactRef] })),
          call("createArtifactRevision", { artifactId: "image_artifact_fixture", content: new Uint8Array([1, 2, 3]), extension: imageExtension(mimeType), baseRevisionId: full ? "base_revision_fixture" : "image_revision_fixture", producerRunId: "run_fixture", editorSource: "image_provider", changeSummary: full ? `Saved ${mimeType}` : "Saved image provider edit.", provenance }),
          call("createArtifactRollback", operation, [imageArtifactRef, imageRevisionRef], { artifact: imageArtifact }, { artifact: imageArtifact })
        ]
      };
    })
  },
  "image.generate": {
    requiredBranches: [...locales.map((locale) => `input_locale:${locale}`), ...locales.map((locale) => `output_locale:${locale}`), ...imageMimeTypes.map((mimeType) => `mime:${mimeType}`), "title:default", "title:explicit"],
    cases: locales.map((inputLocale, index) => {
      const outputLocale = locales[(index + 1) % locales.length]!;
      const mimeType = imageMimeTypes[index % imageMimeTypes.length]!;
      const explicit = index !== 0;
      const title = explicit ? `Generated ${inputLocale}` : "Generated image";
      const preview = explicit ? `Preview ${inputLocale}` : undefined;
      const provenance = { operation: "generate", prompt: `Generate ${inputLocale}`, provider: "fixture_provider", source_run_id: "run_fixture", mime_type: mimeType, width: 64, height: 32, ...(explicit ? { fixture: inputLocale } : {}) };
      return {
        id: `locale-${inputLocale}`,
        input: {
          data_base64: "QUJDRA==", height: 32, input_locale: inputLocale, mime_type: mimeType, output_locale: outputLocale, prompt: `Generate ${inputLocale}`, provider: "fixture_provider", source_run_id: "run_fixture", width: 64,
          ...(explicit ? { title, preview, provenance: { fixture: inputLocale } } : {})
        },
        branches: [`input_locale:${inputLocale}`, `output_locale:${outputLocale}`, `mime:${mimeType}`, explicit ? "title:explicit" : "title:default"],
        calls: [
          call("artifactContract", "image.generate"),
          call("decodeImageBase64", "QUJDRA=="),
          call("artifactDefaultLocales"),
          call("runArtifactMutation", artifactMutation("image.generate", `Save generated image: ${title}`, ["Save a generated image provider result as an Artifact."])),
          call("createArtifactDraft", { operation, title, content: { bytes: new Uint8Array([1, 2, 3]), mime_type: mimeType, extension: imageExtension(mimeType), preview }, kind: "image", locale: outputLocale, sourceLocales: [inputLocale], createdBy: "handler-matrix-actor", metadata: { image_operation: "generate", ...provenance } }),
          call("createArtifactRevision", { artifactId: "generated_image_fixture", content: new Uint8Array([1, 2, 3]), extension: imageExtension(mimeType), producerRunId: "run_fixture", editorSource: "image_provider", changeSummary: "Saved generated image provider result.", provenance }),
          call("createArtifactRollback", operation, [generatedImageArtifactRef, imageRevisionRef], {}, { artifact_id: "generated_image_fixture" })
        ]
      };
    })
  },
  "mcp.call": {
    requiredBranches: ["metadata:explicit", "metadata:default"],
    cases: [
      { id: "explicit", input: { server_name: "fixture-server", tool_name: "fixture-tool", input: { query: "fixture" }, metadata: { tool_call_id: "tool_call_fixture" } }, branches: ["metadata:explicit"], calls: [call("executeMcpCall", { inputSource: "runtime_api", workspaceId: "handler-matrix-workspace", actorId: "handler-matrix-actor", correlationId: "handler-matrix", sessionId: "session_fixture", runId: "run_fixture" }, { serverName: "fixture-server", toolName: "fixture-tool", input: { query: "fixture" }, toolCallId: "tool_call_fixture" })] },
      { id: "defaults", input: { server_name: "fixture-server", tool_name: "fixture-tool" }, branches: ["metadata:default"], calls: [call("executeMcpCall", { inputSource: "runtime_api", workspaceId: "handler-matrix-workspace", actorId: "handler-matrix-actor", correlationId: "handler-matrix", sessionId: "session_fixture", runId: "run_fixture" }, { serverName: "fixture-server", toolName: "fixture-tool", input: {}, toolCallId: undefined })] }
    ]
  },
  "sandbox.exec": {
    requiredBranches: ["options:explicit", "options:default"],
    cases: [
      { id: "explicit", input: { command: "node", args: ["-v"], cwd: "/tmp/workspace", env: { MODE: "test" }, stdin: "fixture", secret_env: { TOKEN: "secret_fixture" }, secret_files: [{ secret_ref_id: "secret_fixture", filename: "token.txt", env: "TOKEN_FILE", mode: 384 }], timeout_ms: 1000, metadata: { tool_call_id: "tool_call_fixture" } }, branches: ["options:explicit"], calls: [call("executeSandboxExec", { inputSource: "runtime_api", workspaceId: "handler-matrix-workspace", actorId: "handler-matrix-actor", correlationId: "handler-matrix", sessionId: "session_fixture", runId: "run_fixture" }, { command: "node", args: ["-v"], cwd: "/tmp/workspace", environment: { MODE: "test" }, stdin: "fixture", secretEnvironment: { TOKEN: "secret_fixture" }, secretFiles: [{ secretRefId: "secret_fixture", filename: "token.txt", environmentName: "TOKEN_FILE", mode: 384 }], timeoutMs: 1000, toolCallId: "tool_call_fixture" })] },
      { id: "defaults", input: { command: "pwd" }, branches: ["options:default"], calls: [call("executeSandboxExec", { inputSource: "runtime_api", workspaceId: "handler-matrix-workspace", actorId: "handler-matrix-actor", correlationId: "handler-matrix", sessionId: "session_fixture", runId: "run_fixture" }, { command: "pwd", args: [], cwd: undefined, environment: {}, stdin: undefined, secretEnvironment: {}, secretFiles: [], timeoutMs: undefined, toolCallId: undefined })] }
    ]
  }
} as const satisfies Record<string, BHandlerExpectation>;

export const bHandlerOperationIds = Object.keys(bHandlerExpectations).sort();
export const bHandlerOperationCount = bHandlerOperationIds.length;
export const bHandlerCaseCount = Object.values(bHandlerExpectations).reduce((count, expectation) => count + expectation.cases.length, 0);
