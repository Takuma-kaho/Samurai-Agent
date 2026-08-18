import type { TrustedDomainContext } from "../definition/index.js";
import {
  humanChangeRequestInputSchema,
  humanChangeRequestOutputSchema
} from "../value-objects/human-change-request.js";

export { humanChangeRequestInputSchema, humanChangeRequestOutputSchema };

export type HumanChangeRequestInput = import("zod").z.infer<typeof humanChangeRequestInputSchema>;
export type HumanChangeRequestOutput = import("zod").z.infer<typeof humanChangeRequestOutputSchema>;

export interface HumanChangeRequestPorts {
  requestHumanChange(
    context: TrustedDomainContext,
    input: HumanChangeRequestInput & { request_kind: HumanChangeRequestOutput["request_kind"] }
  ): Promise<HumanChangeRequestOutput>;
}
