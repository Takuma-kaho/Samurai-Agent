import { GeneratedSurfaceActionDeclarationSchema, GeneratedSurfaceDefinitionSchema, GeneratedSurfaceRevisionRecordSchema, SurfaceInteractionRecordSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { domainJsonValueSchema } from "../definition/index.js";

export const generatedSurfaceSavedValueSchema = z.object({
  definition: GeneratedSurfaceDefinitionSchema,
  revision: GeneratedSurfaceRevisionRecordSchema
}).strict();

export const generatedSurfaceStateValueSchema = GeneratedSurfaceDefinitionSchema.strict();
export const generatedSurfaceInteractionValueSchema = SurfaceInteractionRecordSchema.strict();
export const generatedSurfaceActionValueSchema = z.object({
  surface: GeneratedSurfaceDefinitionSchema,
  action: GeneratedSurfaceActionDeclarationSchema,
  command: z.object({ result: domainJsonValueSchema }).strict()
}).strict();
