import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { SkillOptimizationDataset } from "@samurai-agent/core-schemas";

export interface HostSkillOptimizationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PythonSkillOptimizationInput {
  run_id: string;
  skill_id: string;
  skill_body: string;
  dataset: SkillOptimizationDataset;
  python_command?: string;
  worker_script: string;
  cwd: string;
  host_complete: (messages: HostSkillOptimizationMessage[]) => Promise<{ content: string; feedback?: string }>;
  on_progress?: (progress: { phase: string; value: number; message?: string }) => void;
}

export interface PythonSkillOptimizationEvaluation {
  split: "train" | "validation" | "holdout";
  score: number;
  feedback: string[];
  important_regression: boolean;
}

export interface PythonSkillOptimizationCandidate {
  index: number;
  body: string;
  parent_index?: number;
  validation_score?: number;
  baseline_holdout_score?: number;
  holdout_score?: number;
  important_regression?: boolean;
  evaluations: PythonSkillOptimizationEvaluation[];
  feedback: string[];
}

export interface PythonSkillOptimizationResult {
  status: "completed" | "failed" | "cancelled";
  candidate_body?: string;
  candidates?: PythonSkillOptimizationCandidate[];
  baseline_holdout_score?: number;
  holdout_score?: number;
  important_regression?: boolean;
  related_tests_passed?: boolean;
  safety_checks_passed?: boolean;
  evaluations?: PythonSkillOptimizationEvaluation[];
  feedback: string[];
  trace: Array<Record<string, unknown>>;
  error?: string;
  optimizer_version: string;
}

export function startPythonSkillOptimization(input: PythonSkillOptimizationInput): {
  promise: Promise<PythonSkillOptimizationResult>;
  cancel: () => void;
} {
  const command = input.python_command ?? process.env.SAMURAI_SKILL_OPTIMIZATION_PYTHON ?? "python3";
  const child = spawn(command, [input.worker_script], {
    cwd: input.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PYTHONUNBUFFERED: "1",
      SAMURAI_SKILL_OPTIMIZATION_PROTOCOL: "jsonl",
      ...(process.env.SAMURAI_SKILL_OPTIMIZATION_PYTHONPATH ? { PYTHONPATH: process.env.SAMURAI_SKILL_OPTIMIZATION_PYTHONPATH } : {})
    }
  });
  let settled = false;
  let stderr = "";
  let resolvePromise!: (result: PythonSkillOptimizationResult) => void;
  const promise = new Promise<PythonSkillOptimizationResult>((resolve) => {
    resolvePromise = resolve;
  });
  const finish = (result: PythonSkillOptimizationResult) => {
    if (settled) return;
    settled = true;
    resolvePromise(result);
  };
  const lineReader = createInterface({ input: child.stdout });
  lineReader.on("line", (line) => {
    void handleWorkerMessage(child, line, input, finish);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-2000);
  });
  child.on("error", (error) => finish(failedResult(`gepa_unavailable:${error.message}`)));
  child.on("close", (code, signal) => {
    lineReader.close();
    if (settled) return;
    finish(failedResult(code === null ? `gepa_worker_${signal ?? "stopped"}` : `gepa_worker_exit_${code}${stderr ? `:${stderr.trim()}` : ""}`));
  });
  child.stdin.write(`${JSON.stringify({ type: "start", run_id: input.run_id, skill_id: input.skill_id, skill_body: input.skill_body, dataset: input.dataset, optimizer: "gepa", optimizer_version: "dspy==3.2.1" })}\n`);
  return {
    promise,
    cancel: () => {
      if (!settled) {
        child.kill("SIGTERM");
        finish({ status: "cancelled", feedback: [], trace: [], optimizer_version: "dspy==3.2.1" });
      }
    }
  };
}

async function handleWorkerMessage(
  child: ChildProcessWithoutNullStreams,
  line: string,
  input: PythonSkillOptimizationInput,
  finish: (result: PythonSkillOptimizationResult) => void
): Promise<void> {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (message.type === "progress") {
    input.on_progress?.({ phase: String(message.phase ?? "optimizing"), value: Number(message.value ?? 0), ...(typeof message.message === "string" ? { message: message.message } : {}) });
    return;
  }
  if (message.type === "llm_request") {
    try {
      const response = await input.host_complete(Array.isArray(message.messages) ? message.messages.filter(isHostMessage) : []);
      child.stdin.write(`${JSON.stringify({ type: "llm_response", request_id: String(message.request_id ?? ""), content: response.content, ...(response.feedback ? { feedback: response.feedback } : {}) })}\n`);
    } catch (error) {
      child.stdin.write(`${JSON.stringify({ type: "llm_response", request_id: String(message.request_id ?? ""), error: error instanceof Error ? error.message : String(error) })}\n`);
    }
    return;
  }
  if (message.type === "result") {
    finish({
      status: message.status === "completed" ? "completed" : "failed",
      ...(typeof message.candidate_body === "string" ? { candidate_body: message.candidate_body } : {}),
      ...(Array.isArray(message.candidates) ? { candidates: message.candidates.filter(isCandidate) } : {}),
      ...(typeof message.baseline_holdout_score === "number" ? { baseline_holdout_score: message.baseline_holdout_score } : {}),
      ...(typeof message.holdout_score === "number" ? { holdout_score: message.holdout_score } : {}),
      ...(typeof message.important_regression === "boolean" ? { important_regression: message.important_regression } : {}),
      ...(typeof message.related_tests_passed === "boolean" ? { related_tests_passed: message.related_tests_passed } : {}),
      ...(typeof message.safety_checks_passed === "boolean" ? { safety_checks_passed: message.safety_checks_passed } : {}),
      ...(Array.isArray(message.evaluations) ? { evaluations: message.evaluations.filter(isEvaluation) } : {}),
      feedback: Array.isArray(message.feedback) ? message.feedback.filter((item): item is string => typeof item === "string") : [],
      trace: Array.isArray(message.trace) ? message.trace.filter(isRecord) : [],
      ...(typeof message.error === "string" ? { error: message.error } : {}),
      optimizer_version: typeof message.optimizer_version === "string" ? message.optimizer_version : "dspy==3.2.1"
    });
  }
}

function failedResult(error: string): PythonSkillOptimizationResult {
  return { status: "failed", feedback: [], trace: [], error, optimizer_version: "dspy==3.2.1" };
}

function isHostMessage(value: unknown): value is HostSkillOptimizationMessage {
  return isRecord(value) && (value.role === "system" || value.role === "user" || value.role === "assistant") && typeof value.content === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEvaluation(value: unknown): value is NonNullable<PythonSkillOptimizationResult["evaluations"]>[number] {
  return isRecord(value)
    && (value.split === "train" || value.split === "validation" || value.split === "holdout")
    && typeof value.score === "number"
    && Array.isArray(value.feedback)
    && value.feedback.every((item) => typeof item === "string")
    && typeof value.important_regression === "boolean";
}

function isCandidate(value: unknown): value is NonNullable<PythonSkillOptimizationResult["candidates"]>[number] {
  return isRecord(value)
    && typeof value.index === "number"
    && typeof value.body === "string"
    && (value.parent_index === undefined || typeof value.parent_index === "number")
    && (value.validation_score === undefined || typeof value.validation_score === "number")
    && (value.baseline_holdout_score === undefined || typeof value.baseline_holdout_score === "number")
    && (value.holdout_score === undefined || typeof value.holdout_score === "number")
    && (value.important_regression === undefined || typeof value.important_regression === "boolean")
    && Array.isArray(value.evaluations)
    && value.evaluations.every(isEvaluation)
    && Array.isArray(value.feedback)
    && value.feedback.every((item) => typeof item === "string");
}
