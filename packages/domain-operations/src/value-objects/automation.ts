import { AutomationJobRecordSchema } from "@samurai-agent/core-schemas";
import { runtimeWriteValueSchema } from "./runtime-write.js";

export const automationJobValueSchema = AutomationJobRecordSchema.strict();
export const automationJobWriteValueSchema = runtimeWriteValueSchema(AutomationJobRecordSchema);
