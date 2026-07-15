import { ResourceTranslationRecordSchema } from "@samurai-agent/core-schemas";
import { automationJobWriteValueSchema } from "./automation.js";

export const resourceTranslationValueSchema = ResourceTranslationRecordSchema.strict();
export const resourceTranslationJobValueSchema = automationJobWriteValueSchema;
