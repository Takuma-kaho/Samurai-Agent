import { ExternalSendRecordSchema } from "@samurai-agent/core-schemas";
import { runtimeWriteValueSchema } from "./runtime-write.js";

export const externalSendWriteValueSchema = runtimeWriteValueSchema(ExternalSendRecordSchema);
