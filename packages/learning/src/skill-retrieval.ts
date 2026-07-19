export function preferredSessionSearchMode(input: { query: string; trigramAvailable: boolean; ftsAvailable: boolean }): "fts5_trigram" | "fts5" | "like" {
  if (input.trigramAvailable && /[\u3040-\u30ff\u3400-\u9fff]/.test(input.query)) return "fts5_trigram";
  if (input.ftsAvailable) return "fts5";
  return "like";
}
