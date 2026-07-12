import type { ResourceRef } from "@samurai-agent/core-schemas";

export type PresentationMode = "text" | "artifact" | "built_in_surface" | "generated_surface" | "none";

export interface PresentationPlannerInput {
  userIntent: string;
  resultKind?: "plain" | "document" | "table" | "form" | "chart" | "timeline" | "collection" | "custom";
  hasResult?: boolean;
  operationPossible?: boolean;
  reusable?: boolean;
  privacy?: "standard" | "sensitive";
  generationCost?: "low" | "high";
  client: {
    builtInKinds: string[];
    generatedSurface: boolean;
  };
  resourceRefs?: ResourceRef[];
}

export interface PresentationDecision {
  mode: PresentationMode;
  reason: string;
  confidence: number;
  resource_refs: ResourceRef[];
  requested_kind?: string;
  fallback_chain: PresentationMode[];
}

const noVisualPattern = /(?:文章だけ|テキストだけ|画面はいらない|表示不要|no\s+ui|text\s+only)/i;
const noResultPattern = /^(?:了解|ありがとう|ok|thanks|承知)(?:です|しました|ございます)?[。.!！]?$/i;
const artifactPattern = /(?:文書|提案書|報告書|レポート|議事録|ファイル|export|download|document|report|deliverable)/i;

export function planPresentation(input: PresentationPlannerInput): PresentationDecision {
  const intent = input.userIntent.trim();
  const refs = input.resourceRefs ?? [];
  if (input.hasResult === false || noResultPattern.test(intent)) {
    return decision("none", "No visual or durable result is needed for this acknowledgement.", 0.99, refs, ["text"]);
  }
  if (noVisualPattern.test(intent)) {
    return decision("text", "The user explicitly requested a chat-only response.", 0.99, refs, []);
  }
  if (input.resultKind === "document" || artifactPattern.test(intent) && input.reusable !== false) {
    return decision("artifact", "The result is a reusable deliverable rather than an interactive workspace view.", 0.94, refs, ["text"], input.resultKind);
  }
  const builtInKind = input.resultKind && input.client.builtInKinds.includes(input.resultKind) ? input.resultKind : undefined;
  if (builtInKind) {
    return decision("built_in_surface", `The client has a trusted built-in renderer for ${builtInKind}.`, 0.97, refs, ["artifact", "text"], builtInKind);
  }
  const structured = input.resultKind && input.resultKind !== "plain";
  if (structured && input.operationPossible && input.client.generatedSurface && input.privacy !== "sensitive" && input.generationCost !== "high") {
    return decision("generated_surface", "The task benefits from interaction and no compatible built-in renderer exists.", 0.88, refs, ["artifact", "text"], input.resultKind);
  }
  if (structured && input.reusable) {
    return decision("artifact", "Structured output cannot be rendered safely by this client, so a durable artifact is used.", 0.86, refs, ["text"], input.resultKind);
  }
  return decision("text", "A concise chat response is sufficient and avoids unnecessary UI.", 0.9, refs, []);
}

function decision(mode: PresentationMode, reason: string, confidence: number, refs: ResourceRef[], fallback: PresentationMode[], requestedKind?: string): PresentationDecision {
  return { mode, reason, confidence, resource_refs: refs, fallback_chain: fallback, ...(requestedKind ? { requested_kind: requestedKind } : {}) };
}
