export function searchTerms(query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const splitTerms = normalized.split(/\s+/).filter(Boolean);
  const compactTerms: string[] = [];
  if (splitTerms.length === 1) {
    const chars = Array.from(normalized);
    for (let index = 0; index < chars.length - 1; index += 1) compactTerms.push(chars.slice(index, index + 2).join(""));
  }
  return Array.from(new Set([normalized, ...splitTerms, ...compactTerms]));
}

export function scoreSearchFields(terms: string[], fields: Array<{ value: string; weight: number }>): number {
  let score = 0;
  for (const field of fields) {
    const haystack = field.value.toLowerCase();
    for (const term of terms) if (term && haystack.includes(term)) score += term === terms[0] ? field.weight : Math.max(1, field.weight / 3);
  }
  return score;
}

export function stateSearchBoost(state: string): number {
  if (state === "active" || state === "pinned") return 4;
  if (state === "topic" || state === "project") return 3;
  if (state === "session" || state === "provisional" || state === "proposed") return 1;
  return 0;
}

export function compareScoredSearch<T>(a: { item: T; score: number; updatedAt: string }, b: { item: T; score: number; updatedAt: string }): number {
  return b.score !== a.score ? b.score - a.score : b.updatedAt.localeCompare(a.updatedAt);
}
