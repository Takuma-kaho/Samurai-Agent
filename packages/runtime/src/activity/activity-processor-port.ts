import type {
  ActivityProcessorInput,
  ActivityProcessorResult
} from "@samurai-agent/core-schemas";

/** Read-only, version-addressed future-learning boundary. */
export interface ActivityProcessorPort {
  readonly id: string;
  readonly version: string;
  /** Optional, versioned processor policy used for one durable Attempt. */
  readonly promptOrPolicyVersion?: string;
  process(input: ActivityProcessorInput, options: { cancelSignal: AbortSignal }): Promise<ActivityProcessorResult>;
}

/** Processors are registered by composition/tests only; Core07 registers none. */
export class ActivityProcessorRegistry {
  private readonly processors = new Map<string, ActivityProcessorPort>();

  register(processor: ActivityProcessorPort): void {
    const key = processorKey(processor.id, processor.version);
    if (this.processors.has(key)) throw new Error("activity_processor_already_registered");
    this.processors.set(key, processor);
  }

  get(processorId: string, processorVersion: string): ActivityProcessorPort | undefined {
    return this.processors.get(processorKey(processorId, processorVersion));
  }
}

export class DeterministicFakeActivityProcessor implements ActivityProcessorPort {
  readonly id: string;
  readonly version: string;

  constructor(input: { id?: string; version?: string } = {}) {
    this.id = input.id ?? "core07.fake";
    this.version = input.version ?? "v1";
  }

  async process(input: ActivityProcessorInput, options: { cancelSignal: AbortSignal }): Promise<ActivityProcessorResult> {
    if (options.cancelSignal.aborted) throw new Error("workspace_job_cancelled");
    return {
      processor_id: this.id,
      processor_version: this.version,
      output_schema_version: "core07.fake-output/v1",
      output: {
        activity_id: input.activity.id,
        activity_status: input.activity.status,
        resource_usage_count: input.resource_usage.length
      },
      summary: `Activity ${input.activity.id} processed deterministically.`,
      diagnostics: []
    };
  }
}

function processorKey(id: string, version: string): string {
  return `${id}\u0000${version}`;
}
