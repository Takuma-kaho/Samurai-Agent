import type { Express } from "express";
import type { WorkspaceStore } from "@samurai-agent/workspace-store";

export function registerBackendEventRoutes(app: Express, store: WorkspaceStore): void {
  app.get("/api/backend-runs/:runId/events", async (req, res, next) => {
    try {
      const run = await store.getBackendRun(req.params.runId);
      if (!run) {
        res.status(404).json({ error: "backend_run_not_found" });
        return;
      }
      const afterSequence = typeof req.query.after_sequence === "string" && Number.isInteger(Number(req.query.after_sequence))
        ? Math.max(0, Number(req.query.after_sequence))
        : undefined;
      const limit = typeof req.query.limit === "string" && Number.isInteger(Number(req.query.limit))
        ? Math.max(1, Math.min(Number(req.query.limit), 1_000))
        : undefined;
      res.json(await store.listBackendEvents({ runId: req.params.runId, afterSequence, limit }));
    } catch (error) {
      next(error);
    }
  });
}
