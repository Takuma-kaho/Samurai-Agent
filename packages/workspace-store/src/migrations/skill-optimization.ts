export const skillOptimizationMigration = {
  version: 3,
  name: "skill_optimization_records",
  statements: [
    `CREATE TABLE IF NOT EXISTS skill_optimization_runs (
      id TEXT PRIMARY KEY,
      target_skill_id TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL,
      run_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_skill_optimization_runs_skill ON skill_optimization_runs(target_skill_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS skill_optimization_datasets (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      dataset_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS optimization_candidates (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      body TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES skill_optimization_runs(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_optimization_candidates_run ON optimization_candidates(run_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS optimization_evaluations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      evaluation_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (candidate_id) REFERENCES optimization_candidates(id)
    )`,
    `CREATE TABLE IF NOT EXISTS optimization_promotions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      promotion_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (candidate_id) REFERENCES optimization_candidates(id)
    )`,
    `CREATE TABLE IF NOT EXISTS skill_optimization_snapshots (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      markdown TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      restored_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS skill_optimization_locks (
      skill_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL
    )`
  ]
} as const;
