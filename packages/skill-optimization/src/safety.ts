export interface SkillOptimizationSafetyResult {
  passed: boolean;
  reasons: string[];
}

const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bsk-[a-z0-9]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
  /\b(api[_-]?key|access[_-]?token|client[_-]?secret|oauth[_-]?client[_-]?secret|refresh[_-]?token|private[_-]?key|password|cookie|credential|authorization|secret)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{8,}/i
];

export function evaluateSkillOptimizationSafety(body: string): SkillOptimizationSafetyResult {
  const reasons: string[] = [];
  const normalized = body.trim();
  if (!normalized) reasons.push("candidate_body_empty");
  if (normalized.length > 200_000) reasons.push("candidate_body_too_large");
  if (/^---\s*$/m.test(normalized)) reasons.push("candidate_body_contains_frontmatter_boundary");
  for (const pattern of secretPatterns) {
    if (pattern.test(normalized)) {
      reasons.push("candidate_body_may_contain_secret");
      break;
    }
  }
  return { passed: reasons.length === 0, reasons };
}
