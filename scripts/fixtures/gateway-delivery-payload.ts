import assert from "node:assert/strict";
import type { ArtifactRecord } from "../../packages/core-schemas/src/index";
import { buildGatewayReplyPayloads } from "../../packages/runtime/src/index";

const now = new Date(0).toISOString();
const artifact = (id: string, kind: "pdf" | "image" | "markdown"): ArtifactRecord => ({ id, title: id, kind, locale: "en", source_locales: ["en"], file_ref: { kind: "artifact", id, uri: `artifacts/${id}.${kind === "pdf" ? "pdf" : kind === "image" ? "png" : "md"}` }, metadata: {}, source_operation_id: "fixture", created_by: "fixture", created_at: now, updated_at: now });
const text = `${"long response ".repeat(700)}終端🙂`;
const payloads = buildGatewayReplyPayloads(text, [artifact("report", "pdf"), artifact("preview", "image"), artifact("notes", "markdown")], "slack");
assert.equal(payloads.map((payload) => payload.text).join(""), text);
assert.deepEqual(payloads.map((payload) => payload.sequence), payloads.map((_, index) => index + 1));
assert.equal(payloads.every((payload) => payload.total === payloads.length), true);
const attachments = payloads.at(-1)?.artifacts as Array<Record<string, unknown>>;
assert.deepEqual(attachments.map((item) => item.kind).sort(), ["image", "pdf"]);
assert.equal(payloads.slice(0, -1).every((payload) => payload.artifacts === undefined), true);
process.stdout.write(`${JSON.stringify({ status: "passed", ordered_chunks: true, lossless_text: true, no_duplicate_attachment: true, pdf_payload: true, image_payload: true })}\n`);
