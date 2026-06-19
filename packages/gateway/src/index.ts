import type { ActorIdentity, MessageEnvelope } from "@samurai-agent/core-schemas";

export interface RouteSessionInput {
  source: MessageEnvelope["source"];
  identity: ActorIdentity;
  route?: string;
}

export function routeSession(input: RouteSessionInput): string {
  return `${input.source}:${input.identity}:${input.route ?? "main"}`;
}
