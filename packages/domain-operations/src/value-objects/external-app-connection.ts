import { ExternalAppConnectionRecordSchema } from "@samurai-agent/core-schemas";
import { runtimeWriteValueSchema } from "./runtime-write.js";

export const externalAppConnectionValueSchema = ExternalAppConnectionRecordSchema;
export const externalAppConnectionWriteValueSchema = runtimeWriteValueSchema(ExternalAppConnectionRecordSchema);
