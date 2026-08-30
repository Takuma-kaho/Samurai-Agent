// Kept as a compatibility entrypoint for callers of the legacy Core completion
// command. The current PostgreSQL-focused Phase 13 checks are the source of truth.
await import("./verify-phase13-completion.mjs");
