export const gatewayDeliveryMigration = {
  version: 2,
  name: "gateway_delivery_outbox",
  statements: [
    `CREATE TABLE IF NOT EXISTS gateway_deliveries (
        id TEXT PRIMARY KEY, inbound_id TEXT, session_key TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, attempt INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
        next_attempt_at TEXT, lease_until TEXT, receipt_json TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT,
        FOREIGN KEY (inbound_id) REFERENCES gateway_inbound_messages(id)
      )`,
    `CREATE INDEX IF NOT EXISTS idx_gateway_deliveries_due ON gateway_deliveries(status, next_attempt_at, lease_until)`
  ]
} as const;
