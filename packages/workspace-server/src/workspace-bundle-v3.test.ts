import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./auth";
import { verifyWorkspaceBundleV3 } from "./workspace-bundle-v3";

describe("Workspace Bundle v3 credential boundary", () => {
  it("rejects a credential-shaped field inside a portable record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      const workspaceId = "workspace_bundle_test";
      const files = new Map<string, string>([
        ["workspace.json", canonicalJson({
          id: workspaceId,
          name: "Bundle test",
          hosting_mode: "self_host",
          database_placement: "dedicated",
          storage_namespace: `workspaces/${workspaceId}`,
          created_by: "account_owner",
          version: 1,
          created_at: "2026-08-14T00:00:00.000Z",
          updated_at: "2026-08-14T00:00:00.000Z"
        })],
        ["accounts.jsonl", ""],
        ["rooms.jsonl", ""],
        ["memberships.jsonl", ""],
        ["room-memberships.jsonl", ""],
        ["records.jsonl", `${canonicalJson({
          workspace_id: workspaceId,
          room_id: "room_one",
          record_type: "knowledge",
          id: "record_one",
          version: 1,
          payload: { password: "must-not-export" },
          search_text: "",
          content_hash: "0".repeat(64),
          created_by: "account_owner",
          updated_by: "account_owner",
          created_at: "2026-08-14T00:00:00.000Z",
          updated_at: "2026-08-14T00:00:00.000Z"
        })}\n`],
        ["events.jsonl", ""],
        ["jobs.jsonl", ""],
        ["operations.jsonl", ""],
        ["invitations.jsonl", ""],
        ["audits.jsonl", ""],
        ["files.jsonl", ""]
      ]);
      const hashes = Object.fromEntries([...files.entries()].map(([name, content]) => [name, hash(content)]).sort(([left], [right]) => left.localeCompare(right)));
      const recordCounts = {
        rooms: 0, memberships: 0, room_memberships: 0, records: 1, events: 0,
        jobs: 0, operations: 0, invitations: 0, audits: 0, files: 0
      };
      for (const [name, content] of files) await writeFile(path.join(root, name), content, "utf8");
      await writeFile(path.join(root, "manifest.json"), canonicalJson({
        format_version: 3,
        workspace_id: workspaceId,
        exported_at: "2026-08-14T00:00:00.000Z",
        source: { hosting_mode: "self_host", database_placement: "dedicated" },
        schema_version: 21,
        files: hashes,
        record_counts: recordCounts,
        integrity_hash: hash(canonicalJson({ files: hashes, record_counts: recordCounts }))
      }), "utf8");

      await expect(verifyWorkspaceBundleV3(root)).rejects.toThrow("workspace_bundle_v3_contains_credential");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
