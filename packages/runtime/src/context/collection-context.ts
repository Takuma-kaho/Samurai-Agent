import { skillQueryTerms, normalizeSkillSearchText } from "./skill-context.js";

export interface CollectionContextNote {
  collection_id: string;
  file_path: string;
  content: string;
  role: "context_only";
}

export function selectCollectionNotes(notes: CollectionContextNote[], query: string): CollectionContextNote[] {
  const terms = skillQueryTerms(query);
  const scored = notes
    .filter((note) => note.content.trim().length > 0)
    .map((note, index) => ({ note, score: scoreCollectionNote(note, terms, index) }))
    .filter((entry) => terms.length === 0 || entry.score > 0)
    .sort((left, right) => right.score - left.score || left.note.file_path.localeCompare(right.note.file_path));
  return scored.slice(0, 5).map((entry) => ({
    ...entry.note,
    content: truncateContextText(entry.note.content)
  }));
}

function scoreCollectionNote(note: CollectionContextNote, terms: string[], index: number): number {
  if (terms.length === 0) {
    return Math.max(1, 5 - index);
  }
  const haystack = normalizeSkillSearchText(`${note.collection_id} ${note.file_path} ${note.content}`);
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export function truncateContextText(content: string, maxLength = 4000): string {
  return content.length > maxLength ? `${content.slice(0, maxLength).trimEnd()}\n[truncated]` : content;
}
