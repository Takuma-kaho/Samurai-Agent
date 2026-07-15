import assert from "node:assert/strict";
import type { JsonValue } from "@samurai-agent/core-schemas";
import { assertTrustedRuntimePayload } from "../../apps/server/src/domain-ingress";

const store = {
  async getSession(id: string) {
    return id === "known-session" ? { id } : undefined;
  }
};

for (const key of ["workspace_id", "actor_id", "actor_identity", "correlation_id", "source", "input_source"] as const) {
  await assert.rejects(
    assertTrustedRuntimePayload(store, { [key]: "forged" } as Record<string, JsonValue>, requestError),
    new RegExp(`untrusted_domain_context:${key}`)
  );
}
await assert.rejects(
  assertTrustedRuntimePayload(store, { session_id: "forged-session" }, requestError),
  /Session not found: forged-session/
);
assert.deepEqual(
  await assertTrustedRuntimePayload(store, { session_id: "known-session", content: "trusted" }, requestError),
  { session_id: "known-session", content: "trusted" }
);

process.stdout.write(`${JSON.stringify({
  status: "passed",
  gates: ["IN04", "IN05", "IN06"],
  workspace_spoof_rejected: true,
  actor_spoof_rejected: true,
  source_spoof_rejected: true,
  correlation_spoof_rejected: true,
  session_spoof_rejected: true
})}\n`);

function requestError(code: "bad_request" | "not_found", message: string): Error {
  return Object.assign(new Error(message), { code });
}
