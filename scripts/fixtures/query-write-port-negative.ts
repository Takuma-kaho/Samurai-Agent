import { z } from "zod";
import { defineQuery } from "../../packages/domain-operations/src/definition/index.js";

interface WriteOnlyPort {
  save(value: string): Promise<void>;
}

defineQuery<WriteOnlyPort>()({
  id: "negative.query.write-port",
  version: "1.0",
  availability: "always",
  title: "negative fixture",
  description: "must not compile",
  sources: ["runtime_api"],
  render: [],
  resourceKinds: [],
  proposedEffects: [],
  outputResourceKind: "none",
  uiDisplayCategory: "system",
  provenance: [],
  input: z.object({}).strict(),
  output: z.object({}).strict(),
  createHandler: (ports) => async () => {
    await ports.save("forbidden");
    return { ok: true, value: {} };
  }
});
