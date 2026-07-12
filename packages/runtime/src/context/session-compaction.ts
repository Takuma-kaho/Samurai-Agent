import { SessionCompactionRecordSchema, type MessageRecord, type SessionCompactionRecord } from "@samurai-agent/core-schemas";

export function compactSession(messages: MessageRecord[], input: { sessionId: string; tokenBudget: number; recentCount?: number; now?: string }): SessionCompactionRecord {
  if (messages.length === 0) throw new Error("session_compaction_messages_required");
  const recentCount = input.recentCount ?? 20;
  const classified = { objectives: [] as string[], decisions: [] as string[], open_work: [] as string[], constraints: [] as string[] };
  for (const message of messages) {
    const content = message.content.trim();
    const target = classify(content);
    if (target && !classified[target].includes(content)) classified[target].push(content);
  }
  const semanticFactLimit = 200;
  for (const key of Object.keys(classified) as Array<keyof typeof classified>) classified[key] = classified[key].slice(-semanticFactLimit);
  let recent = messages.slice(-recentCount).map(({ id, role, content }) => ({ id, role, content }));
  const build = () => ({ session_id: input.sessionId, source_message_count: messages.length, source_last_message_id: messages.at(-1)!.id, ...classified, recent_messages: recent, estimated_tokens: 0, token_budget: input.tokenBudget, omitted_message_count: messages.length - recent.length, created_at: input.now ?? new Date().toISOString() });
  let record = build(); let tokens = estimate(record);
  while (tokens > input.tokenBudget && recent.length > 0) { recent = recent.slice(1); record = build(); tokens = estimate(record); }
  // Semantic facts are retained before conversational tail. Fail explicitly instead of silently truncating them.
  if (tokens > input.tokenBudget) throw new Error(`session_compaction_budget_too_small:${tokens}:${input.tokenBudget}`);
  return SessionCompactionRecordSchema.parse({ ...record, estimated_tokens: tokens });
}

export function renderSessionCompaction(recordInput: SessionCompactionRecord): string {
  const record = SessionCompactionRecordSchema.parse(recordInput);
  return [section("Objectives", record.objectives), section("Decisions", record.decisions), section("Open work", record.open_work), section("Constraints", record.constraints), section("Recent messages", record.recent_messages.map((item) => `${item.role}: ${item.content}`))].filter(Boolean).join("\n\n");
}

function classify(content: string): "objectives" | "decisions" | "open_work" | "constraints" | undefined {
  const text = content.toLowerCase();
  if (/^(objective|goal|目的|目標)[:：]/.test(text)) return "objectives";
  if (/^(decision|decided|決定|判断)[:：]/.test(text)) return "decisions";
  if (/^(todo|open|pending|未完|残作業|次)[:：]/.test(text)) return "open_work";
  if (/^(constraint|must|禁止|制約|必須)[:：]/.test(text)) return "constraints";
  return undefined;
}
function estimate(value: unknown): number { return Math.ceil(JSON.stringify(value).length / 4); }
function section(title: string, values: string[]): string { return values.length ? `${title}:\n${values.map((value) => `- ${value}`).join("\n")}` : ""; }
