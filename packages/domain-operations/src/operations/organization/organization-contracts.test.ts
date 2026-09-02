import { describe, expect, it } from "vitest";
import {
  operationDefinitions,
  type OrganizationRequestContext
} from "../../index.js";

const organizationOperationIds = [
  "organization.list", "organization.view", "organization.create", "organization.patch", "organization.delete",
  "organization.member.list", "organization.member.invite", "organization.member.accept", "organization.member.role.change", "organization.member.remove", "organization.member.leave",
  "organization.invitation.list", "organization.invitation.revoke", "organization.invitation.reissue", "organization.invitation.extend",
  "organization.workspace.list", "organization.workspace.create", "organization.workspace.member.grant", "organization.workspace.member.revoke", "organization.workspace.archive", "organization.workspace.restore", "organization.workspace.delete",
  "workspace.organization.move.preflight", "workspace.organization.move.commit", "workspace.organization.move.status",
  "workspace.bundle.export", "workspace.bundle.restore"
] as const;

const queryIds = new Set([
  "organization.list",
  "organization.view",
  "organization.member.list",
  "organization.invitation.list",
  "organization.workspace.list",
  "workspace.organization.move.preflight",
  "workspace.organization.move.status"
]);

describe("Organization public operation contracts", () => {
  it("registers the complete Organization operation surface", () => {
    const definitions = organizationOperationIds.map((id) => operationDefinitions.find((definition) => definition.id === id));

    expect(definitions.every(Boolean)).toBe(true);
    expect(new Set(definitions.map((definition) => definition?.id))).toEqual(new Set(organizationOperationIds));
    expect(definitions.every((definition) => definition?.version === "1.0" && definition.sources.includes("runtime_api"))).toBe(true);
    expect(definitions.filter((definition) => definition?.kind === "query").map((definition) => definition?.id)).toEqual(expect.arrayContaining([...queryIds]));
    expect(definitions.filter((definition) => definition?.kind === "query")).toHaveLength(queryIds.size);
  });

  it("declares retry and concurrency policy for every mutation", () => {
    const definitions = new Map(operationDefinitions.filter((definition) => organizationOperationIds.includes(definition.id as typeof organizationOperationIds[number])).map((definition) => [definition.id, definition]));
    const appendOrUnique = [
      "organization.create", "organization.member.invite", "organization.member.accept", "organization.invitation.reissue",
      "organization.workspace.create", "organization.workspace.member.grant", "workspace.bundle.export", "workspace.bundle.restore"
    ];
    const optimisticVersion = ["organization.patch", "organization.invitation.extend", "workspace.organization.move.commit"];
    const stateTransition = [
      "organization.delete", "organization.member.role.change", "organization.member.remove", "organization.member.leave",
      "organization.invitation.revoke", "organization.workspace.member.revoke", "organization.workspace.archive", "organization.workspace.restore", "organization.workspace.delete"
    ];

    for (const id of appendOrUnique) expect(definitions.get(id)).toMatchObject({ kind: "command", idempotency: "required", concurrency: "append_or_unique" });
    for (const id of optimisticVersion) expect(definitions.get(id)).toMatchObject({ kind: "command", idempotency: "required", concurrency: "optimistic_version" });
    for (const id of stateTransition) expect(definitions.get(id)).toMatchObject({ kind: "command", idempotency: "required", concurrency: "state_transition" });
    for (const id of queryIds) expect(definitions.get(id)).toMatchObject({ kind: "query", idempotency: "none", concurrency: "none", effect: "read_only" });
  });

  it("keeps execution context separate from the legacy TrustedDomainContext", async () => {
    const context: OrganizationRequestContext = {
      accountId: "account_1",
      operationId: "request-operation-1",
      requestId: "request_1",
      organizationId: "organization_1"
    };
    expect(context).toEqual({
      accountId: "account_1",
      operationId: "request-operation-1",
      requestId: "request_1",
      organizationId: "organization_1"
    });

    const definition = operationDefinitions.find((candidate) => candidate.id === "organization.create")!;
    const handler = definition.createHandler({} as never);
    await expect(handler.execute({} as never, { name: "Acme" })).rejects.toThrow("domain_operation_public_contract_only:organization.create");
  });
});
