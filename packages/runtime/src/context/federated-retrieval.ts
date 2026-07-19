import type { ResourceRef } from "@samurai-agent/core-schemas";

export type RetrievalResourceKind = "session" | "memory" | "wiki" | "artifact" | "collection";
export interface RetrievalCandidate { ref: ResourceRef; kind: RetrievalResourceKind; title: string; content: string; updated_at: string; pinned?: boolean; trust?: number; scope?: string; }
export interface RankedRetrievalResult { ref: ResourceRef; kind: RetrievalResourceKind; title: string; score: number; reasons: string[]; matched_terms: string[]; source: { updated_at: string; scope?: string; trust: number; pinned: boolean }; }

export function rankRetrievedResources(query: string, candidates: RetrievalCandidate[], input: { limit?: number; scope?: string; now?: string } = {}): RankedRetrievalResult[] {
  const queryTerms = terms(query); if (queryTerms.length === 0) return [];
  const now = Date.parse(input.now ?? new Date().toISOString());
  return candidates.map((candidate) => {
    const titleTerms = new Set(terms(candidate.title)); const bodyTerms = new Set(terms(candidate.content));
    const matched = queryTerms.filter((term) => titleTerms.has(term) || bodyTerms.has(term));
    const titleMatches = queryTerms.filter((term) => titleTerms.has(term)).length;
    const bodyMatches = matched.length - titleMatches;
    const coverage = matched.length / queryTerms.length; const trust = clamp(candidate.trust ?? 0.5); const pinned = candidate.pinned === true;
    const ageDays = Math.max(0, (now - Date.parse(candidate.updated_at)) / 86_400_000); const recency = 1 / (1 + ageDays / 30);
    const scopeMatch = !input.scope || !candidate.scope ? 0 : candidate.scope === input.scope ? 1 : -1;
    const score = coverage * 50 + titleMatches * 8 + bodyMatches * 2 + trust * 8 + recency * 5 + (pinned ? 7 : 0) + scopeMatch * 6 + kindWeight(candidate.kind);
    const reasons = [`query_coverage:${coverage.toFixed(3)}`, `trust:${trust.toFixed(2)}`, `recency:${recency.toFixed(3)}`, `resource_type:${candidate.kind}`];
    if (titleMatches) reasons.push(`title_matches:${titleMatches}`); if (pinned) reasons.push("pinned"); if (scopeMatch) reasons.push(scopeMatch > 0 ? "scope_match" : "scope_mismatch");
    return { ref: candidate.ref, kind: candidate.kind, title: candidate.title, score: Number(score.toFixed(6)), reasons, matched_terms: matched, source: { updated_at: candidate.updated_at, scope: candidate.scope, trust, pinned } };
  }).filter((result) => result.matched_terms.length > 0).sort((a, b) => b.score - a.score || a.ref.kind.localeCompare(b.ref.kind) || a.ref.id.localeCompare(b.ref.id)).slice(0, input.limit ?? 10);
}

function terms(value: string): string[] {
  const normalized = value.normalize("NFKC").toLowerCase(); const words = normalized.match(/[a-z0-9]+|[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]+/gu) ?? [];
  const output = new Set<string>(); for (const word of words) { output.add(word); if (/^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]+$/u.test(word) && word.length > 1) for (let i=0;i<word.length-1;i++) output.add(word.slice(i,i+2)); }
  return [...output];
}
function kindWeight(kind: RetrievalResourceKind): number { return ({ memory: 5, wiki: 4, session: 3, artifact: 2, collection: 1 })[kind]; }
function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
