import { createAgentHost, type AgentHostCompositionOptions, type AgentHost } from "@samurai-agent/runtime";

/** Single production composition point for Host dependencies. */
export function composeAgentHost(options: AgentHostCompositionOptions): AgentHost {
  return createAgentHost(options);
}

