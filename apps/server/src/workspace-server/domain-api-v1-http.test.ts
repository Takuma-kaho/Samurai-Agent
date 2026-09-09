import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server as HttpServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  accountIdFromPublicKey,
  createAccountSignaturePayload,
  PostgresWorkspaceAdminDatabase,
  PostgresWorkspaceDatabase,
  WorkspaceServerStore
} from "@samurai-agent/workspace-server";
import { createWorkspaceServerHttp } from "./http-server";

type R15DatabaseConfig = {
  databaseUrl: string;
  databaseAdminUrl: string;
  runtimeRole: string;
};

type R15Account = {
  id: string;
  publicKey: string;
  privateKey: string;
};

type HttpResult = {
  status: number;
  body: unknown;
};

// Only the disposable/CI fixture used by the existing Server verification
// scripts is accepted. Never fall back to a developer or production database.
const r15Database = readR15DatabaseConfig();

describe.skipIf(!r15Database)("R15 V1 Generated Surface HTTP integration", () => {
  it("persists a confirmation request, exposes it over GET, and rejects forged responses", { timeout: 120_000 }, async () => {
    const databaseConfig = r15Database!;
    const suffix = randomUUID().replaceAll("-", "");
    const workspaceId = `workspace_r15_http_${suffix}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-r15-http-"));
    const account = accountIdentity();
    const database = new PostgresWorkspaceDatabase({
      databaseUrl: databaseConfig.databaseUrl,
      runtimeRole: databaseConfig.runtimeRole
    });
    const adminDatabase = new PostgresWorkspaceAdminDatabase({
      databaseAdminUrl: databaseConfig.databaseAdminUrl,
      runtimeRole: databaseConfig.runtimeRole
    });
    let server: Awaited<ReturnType<typeof createWorkspaceServerHttp>> | undefined;
    let cleanupError: unknown;

    try {
      await adminDatabase.migrate();
      await database.assertReady();
      const store = new WorkspaceServerStore({
        database,
        mode: "hosted",
        storageRoot: root,
        invitationTokenSecret: "x".repeat(32)
      });
      await store.registerAccount({ id: account.id, publicKey: account.publicKey, displayName: "R15 HTTP owner" });
      const createdWorkspace = await store.createWorkspace({
        id: workspaceId,
        name: "R15 HTTP integration",
        ownerAccountId: account.id,
        operationId: `r15_http_workspace_create_${suffix}`,
        hostingMode: "hosted",
        databasePlacement: "shared"
      });
      const roomId = createdWorkspace.defaultRoom.id;

      server = await createWorkspaceServerHttp({
        mode: "hosted",
        databaseUrl: databaseConfig.databaseUrl,
        databaseRuntimeRole: databaseConfig.runtimeRole,
        invitationTokenSecret: "x".repeat(32),
        storageRoot: path.join(root, "server"),
        selfHostBootstrapMode: "empty",
        initialAdminDisplayName: "R15 HTTP owner",
        port: 0,
        bindAddress: "127.0.0.1",
        corsOrigins: [],
        publicNetwork: false
      });
      const port = await listenOnEphemeralPort(server.httpServer);
      const serverUrl = `http://127.0.0.1:${port}`;

      const interactionListPath = `/api/v1/workspaces/${workspaceId}/interaction-requests?room_id=${encodeURIComponent(roomId)}`;
      const unsigned = await fetch(new URL(interactionListPath, serverUrl), {
        signal: AbortSignal.timeout(15_000)
      });
      expect(unsigned.status).toBe(401);

      const surfaceCreated = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_surface_create_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/domain/operations/generated_surface.create`,
        body: {
          context: { room_id: roomId },
          input: confirmationSurfaceInput()
        }
      });
      expect(surfaceCreated.status, JSON.stringify(surfaceCreated.body)).toBe(201);
      const surfaceCreatedBody = objectValue(surfaceCreated.body, "surface create response");
      const surfaceResult = objectValue(surfaceCreatedBody.result, "surface create result");
      const surface = objectValue(surfaceResult.definition, "surface definition");
      const revision = objectValue(surfaceResult.revision, "surface revision");
      const surfaceId = stringValue(surface, "id");
      const revisionId = stringValue(revision, "id");

      const directArtifactAction = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        // Desktop generates UUID operation IDs. The Generated Surface target
        // must scope that UI identity before passing it to Completion.
        operationId: randomUUID(),
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/generated-surfaces/${surfaceId}/actions/save-artifact/run`,
        body: {
          room_id: roomId,
          revision_id: revisionId,
          action_payload: {}
        }
      });
      expect(directArtifactAction.status, JSON.stringify(directArtifactAction.body)).toBe(201);
      const directArtifactBody = objectValue(directArtifactAction.body, "direct artifact action response");
      expect(objectValue(directArtifactBody.interaction, "direct artifact interaction")).toMatchObject({
        kind: "action",
        command_id: "artifact.create"
      });
      expect(objectValue(directArtifactBody.target_result, "direct artifact target result")).toMatchObject({
        artifact: { title: "R15 direct Surface Artifact" }
      });

      const actionResponse = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_surface_action_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/generated-surfaces/${surfaceId}/actions/approve/run`,
        body: {
          room_id: roomId,
          revision_id: revisionId,
          action_payload: {}
        }
      });
      expect(actionResponse.status).toBe(202);
      const actionBody = objectValue(actionResponse.body, "surface action response");
      expect(actionBody.status).toBe("approval_required");
      expect(actionBody.replayed).toBe(false);
      const request = objectValue(actionBody.request, "interaction request");
      const requestId = stringValue(request, "id");
      expect(request).toMatchObject({
        workspaceId,
        roomId,
        version: 1,
        kind: "approval",
        status: "pending",
        surfaceId,
        revisionId,
        requestedAccountId: account.id,
        options: [
          { id: "approve", decision: "approve" },
          { id: "deny", decision: "deny" }
        ]
      });
      expect(objectValue(request.actionTarget, "interaction action target")).toMatchObject({
        kind: "generated_surface_action",
        room_id: roomId,
        surface_id: surfaceId,
        revision_id: revisionId,
        action_id: "approve",
        command_id: "collection.action.run"
      });

      const listed = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        method: "GET",
        path: interactionListPath
      });
      expect(listed.status).toBe(200);
      const listedBody = objectValue(listed.body, "interaction list response");
      expect(listedBody.requests).toEqual([request]);

      const detailPath = `/api/v1/workspaces/${workspaceId}/interaction-requests/${requestId}?room_id=${encodeURIComponent(roomId)}`;
      const detail = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        method: "GET",
        path: detailPath
      });
      expect(detail.status).toBe(200);
      expect(objectValue(detail.body, "interaction detail response").request).toEqual(request);

      const missingExpectedVersion = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_missing_expected_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/interaction-requests/${requestId}/respond`,
        body: { room_id: roomId, option_id: "deny" }
      });
      expect(missingExpectedVersion.status).toBe(400);
      expect(errorCode(missingExpectedVersion)).toBe("expected_version_invalid");

      const missingOptionId = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_missing_option_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/interaction-requests/${requestId}/respond`,
        body: { room_id: roomId, expected_version: 1 }
      });
      expect(missingOptionId.status).toBe(400);
      expect(errorCode(missingOptionId)).toBe("option_id_required");

      const unknownConfirmed = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_unknown_confirmed_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/interaction-requests/${requestId}/respond`,
        body: { room_id: roomId, expected_version: 1, option_id: "deny", confirmed: true }
      });
      expect(unknownConfirmed.status).toBe(400);
      expect(errorCode(unknownConfirmed)).toBe("workspace_interaction_request_response_invalid");

      const stillPending = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        method: "GET",
        path: detailPath
      });
      expect(stillPending.status).toBe(200);
      expect(objectValue(objectValue(stillPending.body, "pending detail response").request, "pending request")).toMatchObject({
        id: requestId,
        version: 1,
        status: "pending"
      });

      const denied = await signedJsonRequest({
        serverUrl,
        account,
        workspaceId,
        operationId: `r15_http_deny_${suffix}`,
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/interaction-requests/${requestId}/respond`,
        body: { room_id: roomId, expected_version: 1, option_id: "deny" }
      });
      expect(denied.status).toBe(200);
      expect(objectValue(denied.body, "denied response")).toMatchObject({
        replayed: false,
        request: { id: requestId, version: 2, status: "denied", outcome: { optionId: "deny", decision: "deny" } }
      });
    } finally {
      if (server) await server.close().catch((error) => { cleanupError ??= error; });
      await cleanupWorkspace(adminDatabase, workspaceId, account.id).catch((error) => { cleanupError ??= error; });
      await database.close().catch((error) => { cleanupError ??= error; });
      await adminDatabase.close().catch((error) => { cleanupError ??= error; });
      await rm(root, { recursive: true, force: true }).catch((error) => { cleanupError ??= error; });
    }
    if (cleanupError) throw cleanupError;
  });
});

function readR15DatabaseConfig(): R15DatabaseConfig | undefined {
  const databaseUrl = process.env.SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_URL?.trim();
  const databaseAdminUrl = process.env.SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_ADMIN_URL?.trim();
  const runtimeRole = process.env.SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_RUNTIME_ROLE?.trim();
  if (!databaseUrl || !databaseAdminUrl || !runtimeRole) return undefined;
  return { databaseUrl, databaseAdminUrl, runtimeRole };
}

function accountIdentity(): R15Account {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return {
    id: accountIdFromPublicKey(publicKeyPem),
    publicKey: publicKeyPem,
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  };
}

function confirmationSurfaceInput(): Record<string, unknown> {
  return {
    bundle: {
      title: "R15 confirmation surface",
      html: '<main><button type="button" data-action-id="approve">Approve</button></main>',
      actions: [{
        id: "save-artifact",
        label: "Save artifact",
        command_id: "artifact.create",
        input_schema: {},
        payload_template: {
          title: "R15 direct Surface Artifact",
          content: "Created by a direct Generated Surface action.",
          kind: "markdown",
          input_locale: "en",
          output_locale: "en",
          metadata: { source: "r15-http" }
        },
        requires_confirmation: false
      }, {
        id: "approve",
        label: "Approve",
        command_id: "collection.action.run",
        input_schema: {},
        payload_template: {
          collection_id: "r15_collection",
          action_id: "publish",
          payload: {}
        },
        requires_confirmation: true
      }]
    },
    request: {
      user_intent: "R15 HTTP confirmation request",
      source_resource_refs: [],
      allowed_domain_commands: ["artifact.create", "collection.action.run"],
      selected_knowledge_refs: [],
      selected_skill_refs: [],
      client_capabilities: { generated_surface: true },
      expected_lifetime: "pinned",
      fallback_chain: ["built_in_surface", "artifact", "text"]
    }
  };
}

async function signedJsonRequest(input: {
  serverUrl: string;
  account: R15Account;
  workspaceId: string;
  operationId?: string;
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}): Promise<HttpResult> {
  const url = new URL(input.path, input.serverUrl);
  const requestId = `r15_request_${randomUUID()}`;
  const timestamp = String(Date.now());
  const body = input.body === undefined
    ? {}
    : JSON.parse(JSON.stringify(input.body)) as Record<string, unknown>;
  const payload = createAccountSignaturePayload({
    method: input.method,
    path: url.pathname,
    workspaceId: input.workspaceId,
    ...(input.operationId ? { operationId: input.operationId } : {}),
    requestId,
    timestamp,
    body
  });
  const signature = sign(null, Buffer.from(payload), createPrivateKey(input.account.privateKey)).toString("base64url");
  const response = await fetch(url, {
    method: input.method,
    headers: {
      "x-samurai-account-id": input.account.id,
      "x-samurai-request-id": requestId,
      "x-samurai-timestamp": timestamp,
      "x-samurai-signature": signature,
      "x-samurai-workspace-id": input.workspaceId,
      ...(input.operationId ? { "x-samurai-operation-id": input.operationId } : {}),
      ...(input.body ? { "content-type": "application/json" } : {})
    },
    ...(input.body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000)
  });
  const text = await response.text();
  let bodyValue: unknown;
  if (text) {
    try {
      bodyValue = JSON.parse(text);
    } catch {
      bodyValue = { invalid_json: text };
    }
  }
  return { status: response.status, body: bodyValue };
}

async function listenOnEphemeralPort(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("r15_http_ephemeral_port_unavailable");
  return address.port;
}

async function cleanupWorkspace(adminDatabase: PostgresWorkspaceAdminDatabase, workspaceId: string, accountId: string): Promise<void> {
  await adminDatabase.withAdmin(async (sql) => {
    const tables = (await sql.query<{ table_name: string }>(`
      SELECT DISTINCT columns.table_name
      FROM information_schema.columns AS columns
      JOIN information_schema.tables AS tables
        ON tables.table_schema = columns.table_schema AND tables.table_name = columns.table_name
      WHERE columns.table_schema = 'public'
        AND columns.column_name = 'workspace_id'
        AND tables.table_type = 'BASE TABLE'
        AND columns.table_name <> 'workspaces'
      ORDER BY columns.table_name
    `)).rows.map((row) => row.table_name);

    await sql.query("BEGIN");
    try {
      for (let pass = 0; pass <= tables.length; pass += 1) {
        let deleted = false;
        for (const table of tables) {
          const quotedTable = `"${table.replaceAll('"', '""')}"`;
          await sql.query("SAVEPOINT r15_cleanup");
          try {
            const result = await sql.query(`DELETE FROM ${quotedTable} WHERE workspace_id = $1`, [workspaceId]);
            deleted ||= (result.rowCount ?? 0) > 0;
            await sql.query("RELEASE SAVEPOINT r15_cleanup");
          } catch {
            await sql.query("ROLLBACK TO SAVEPOINT r15_cleanup");
            await sql.query("RELEASE SAVEPOINT r15_cleanup");
          }
        }
        if (!deleted) break;
      }
      await sql.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await sql.query("DELETE FROM account_operations WHERE account_id = $1", [accountId]);
      await sql.query("DELETE FROM accounts WHERE id = $1", [accountId]);
      await sql.query("COMMIT");
    } catch (error) {
      await sql.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_invalid`);
  return value as Record<string, unknown>;
}

function stringValue(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || !value[key]) throw new Error(`${key}_missing`);
  return value[key] as string;
}

function errorCode(response: HttpResult): unknown {
  return objectValue(objectValue(response.body, "error response").error, "error payload").code;
}
