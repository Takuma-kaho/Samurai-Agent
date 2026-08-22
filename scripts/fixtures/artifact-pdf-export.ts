import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, type PdfExportAdapter } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

function simplePdf(title: string, content: string): Uint8Array {
  const safe = `${title}: ${content}`.replace(/[^\x20-\x7e]/g, "?").replace(/([()\\])/g, "\\$1").slice(0, 120);
  const stream = `BT /F1 16 Tf 72 720 Td (${safe}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

const root = await mkdtemp(path.join(tmpdir(), "samurai-pdf-export-"));
const store = await WorkspaceStore.create({ rootDir: root });
const adapter: PdfExportAdapter = { id: "fixture-pdf", async export(input) { return simplePdf(input.title, input.content); } };
const runtime = new AgentRuntime(store, undefined, undefined, undefined, undefined, undefined, { pdfExportAdapter: adapter });
try {
  const now = new Date().toISOString();
  const file = await store.writeArtifactContent("pdf-source", "Exported report content", { extension: "md" });
  await store.saveArtifactMetadata({ id: "pdf-source", title: "Core report", kind: "document", locale: "en", source_locales: ["en"], file_ref: { kind: "artifact", id: "pdf-source", uri: file }, metadata: { current_revision_id: "source-revision" }, source_operation_id: "fixture-source", created_by: "fixture", created_at: now, updated_at: now });
  const exported = await runtime.runDomainCommand({ command_id: "artifact.export_pdf", input_source: "surface_operation", idempotency_key: "pdf-export", payload: { artifact_id: "pdf-source" } });
  const pdf = (exported.result as Record<string, any>).resource;
  const bytes = await readFile(path.join(root, pdf.file_ref.uri));
  assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal(pdf.metadata.source_artifact_id, "pdf-source");
  assert.equal(pdf.metadata.source_revision_id, "source-revision");
  if (process.env.SAMURAI_PDF_FIXTURE_OUTPUT) {
    await mkdir(path.dirname(process.env.SAMURAI_PDF_FIXTURE_OUTPUT), { recursive: true });
    await writeFile(process.env.SAMURAI_PDF_FIXTURE_OUTPUT, bytes);
  }
  process.stdout.write(`${JSON.stringify({ status: "passed", valid_pdf_header: true, source_artifact_traced: true, source_revision_traced: true, bytes: bytes.byteLength })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool();
  await store.close();
  await rm(root, { recursive: true, force: true });
}
