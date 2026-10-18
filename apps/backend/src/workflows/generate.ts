import type { Stage } from "@wardrobe/core";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings, GenerateParams } from "../env";
import { GeminiError } from "../gemini";
import { createPipeline } from "../pipeline";

/** Gemini calls can fail transiently (rate limits, overload); retry a couple of times before giving up. */
const RETRY = { retries: { limit: 2, delay: "20 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;

/** Generates one stage's image for an import job and records the result for review. */
export class GenerateStage extends WorkflowEntrypoint<Bindings, GenerateParams> {
  async run(event: Readonly<WorkflowEvent<GenerateParams>>, step: WorkflowStep) {
    const { jobId, stage } = event.payload;
    const pipeline = createPipeline(this.env);
    let result: Partial<Stage>;
    try {
      result = await step.do("generate", RETRY, () => pipeline.generate(jobId, stage).catch((error) => {
        throw error instanceof GeminiError && !error.retryable ? new NonRetryableError(error.message) : error;
      }));
    } catch (error) {
      result = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    await step.do("save result", () => pipeline.finish(jobId, stage, result));
  }
}
