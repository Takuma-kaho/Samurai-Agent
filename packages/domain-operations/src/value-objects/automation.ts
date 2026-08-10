import { AutomationJobRecordSchema } from "@samurai-agent/core-schemas";
import { runtimeWriteValueSchema } from "./runtime-write.js";

// The Core09 schema includes cross-field authority validation. Its inner
// object remains strict, so do not call `.strict()` again on the refined schema.
export const automationJobValueSchema = AutomationJobRecordSchema;
export const automationJobWriteValueSchema = runtimeWriteValueSchema(AutomationJobRecordSchema);
