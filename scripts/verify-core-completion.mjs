// Kept as a compatibility entrypoint for callers from the earlier Core plan.
// That scorecard depended on the removed SQLite WorkspaceStore and is no longer
// a valid completion source after the PostgreSQL-only migration.
await import("./verify-phase13-completion.mjs");
