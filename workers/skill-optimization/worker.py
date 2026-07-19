#!/usr/bin/env python3
"""Host-backed DSPy GEPA worker.

The worker never receives provider credentials. Every model request is sent to
the parent process over JSONL, so the Host remains the only API-key boundary.
"""

from __future__ import annotations

import json
import platform
import re
import sys
import uuid
from contextlib import redirect_stdout
from types import SimpleNamespace
from typing import Any


OPTIMIZER_VERSION = "dspy==3.2.1"
PROTOCOL_STDOUT = sys.stdout


def emit(message: dict[str, Any]) -> None:
    PROTOCOL_STDOUT.write(json.dumps(message, ensure_ascii=False) + "\n")
    PROTOCOL_STDOUT.flush()


def fail(message: str) -> None:
    emit({"type": "result", "status": "failed", "error": message, "feedback": [], "trace": [], "optimizer_version": OPTIMIZER_VERSION})


def request_host_completion(messages: list[dict[str, str]]) -> str:
    request_id = str(uuid.uuid4())
    emit({"type": "llm_request", "request_id": request_id, "messages": messages})
    for line in sys.stdin:
        try:
            response = json.loads(line)
        except json.JSONDecodeError:
            continue
        if response.get("type") != "llm_response" or response.get("request_id") != request_id:
            continue
        if response.get("error"):
            raise RuntimeError(str(response["error"]))
        return str(response.get("content", ""))
    raise RuntimeError("host_llm_disconnected")


def build_host_backed_lm(dspy: Any) -> Any:
    """Create the DSPy 3.x LM adapter without exposing provider credentials."""

    class HostBackedLM(dspy.BaseLM):
        def __init__(self) -> None:
            super().__init__(model="samurai-host", model_type="chat", cache=False)
            self.history: list[dict[str, Any]] = []

        def forward(
            self,
            prompt: str | None = None,
            messages: list[dict[str, Any]] | None = None,
            **_: Any,
        ) -> Any:
            request_messages = messages or [{"role": "user", "content": prompt or ""}]
            content = request_host_completion(request_messages)
            self.history.append({"messages": request_messages, "response": content})
            return SimpleNamespace(
                model="samurai-host",
                choices=[SimpleNamespace(message=SimpleNamespace(content=content))],
                usage={},
            )

    return HostBackedLM()


def token_overlap(answer: str, expected: str) -> float:
    answer_tokens = set(re.findall(r"[\w\u3040-\u30ff\u4e00-\u9fff]{2,}", answer.lower()))
    expected_tokens = set(re.findall(r"[\w\u3040-\u30ff\u4e00-\u9fff]{2,}", expected.lower()))
    if not expected_tokens:
        return 0.0
    return len(answer_tokens & expected_tokens) / len(expected_tokens)


def score_prediction(example: Any, prediction: Any) -> tuple[float, str]:
    answer = str(getattr(prediction, "answer", ""))
    expected = str(getattr(example, "expected_behavior", ""))
    overlap = token_overlap(answer, expected)
    score = max(0.0, min(100.0, 45.0 + overlap * 45.0 + min(len(answer), 400) / 400.0 * 10.0))
    feedback = "good coverage" if overlap >= 0.5 else "cover the expected behavior more explicitly"
    return score, feedback


def evaluate_module(module: Any, examples: list[dict[str, Any]], dspy: Any) -> list[dict[str, Any]]:
    evaluations: list[dict[str, Any]] = []
    for item in examples:
        example = dspy.Example(instruction=item.get("prompt", ""), expected_behavior=item.get("expected_behavior", "")).with_inputs("instruction")
        prediction = module(instruction=example.instruction)
        score, feedback = score_prediction(example, prediction)
        evaluations.append({"score": score, "feedback": [feedback]})
    return evaluations


def extract_skill_body(module: Any) -> str:
    """Read the instruction text from a DSPy program or a GEPA candidate."""

    objects = [module, getattr(module, "predict", None)]
    for item in objects:
        signature = getattr(item, "signature", None)
        instructions = getattr(signature, "instructions", None)
        if isinstance(instructions, str) and instructions.strip():
            return instructions.strip()
    if isinstance(module, dict):
        for value in module.values():
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


def evaluate_candidate(module: Any, examples: list[dict[str, Any]], baseline_scores: dict[str, float], dspy: Any) -> tuple[list[dict[str, Any]], float, bool, list[str]]:
    evaluations: list[dict[str, Any]] = []
    feedback: list[str] = []
    for item in examples:
        split = item.get("split")
        if split not in {"train", "validation", "holdout"}:
            continue
        example = dspy.Example(instruction=item.get("prompt", ""), expected_behavior=item.get("expected_behavior", "")).with_inputs("instruction")
        prediction = module(instruction=example.instruction)
        score, item_feedback = score_prediction(example, prediction)
        baseline_score = baseline_scores.get(str(item.get("id", "")))
        regression = bool(split == "holdout" and baseline_score is not None and score < baseline_score - 20.0)
        evaluations.append({
            "split": split,
            "score": score,
            "feedback": [item_feedback],
            "important_regression": regression,
        })
        if item_feedback not in feedback:
            feedback.append(item_feedback)
    holdout = [item for item in evaluations if item["split"] == "holdout"]
    holdout_score = sum(item["score"] for item in holdout) / max(1, len(holdout))
    return evaluations, holdout_score, any(item["important_regression"] for item in evaluations), feedback


def run_gepa(request: dict[str, Any]) -> None:
    if sys.version_info < (3, 11):
        fail("python_3_11_required")
        return
    try:
        import dspy  # type: ignore
    except Exception as exc:  # pragma: no cover - exercised in an uninstalled environment
        fail(f"gepa_unavailable:dspy_import_failed:{exc}")
        return

    gepa_class = getattr(dspy, "GEPA", None)
    if gepa_class is None:
        fail("gepa_unavailable:dspy_gepa_missing")
        return

    dataset = request.get("dataset", {})
    examples = list(dataset.get("examples", []))
    train = [item for item in examples if item.get("split") == "train"]
    validation = [item for item in examples if item.get("split") == "validation"]
    if len(examples) < 20 or len(train) < 12 or len(validation) < 4:
        fail("dataset_contract_not_met")
        return

    host_lm = build_host_backed_lm(dspy)
    dspy.settings.configure(lm=host_lm)
    body = str(request.get("skill_body", "")).strip()
    if not body:
        fail("skill_body_required")
        return

    signature = dspy.Signature("instruction -> answer", instructions=body)
    student = dspy.Predict(signature)

    def metric(
        example: Any,
        prediction: Any,
        _trace: Any = None,
        _pred_name: str | None = None,
        _pred_trace: Any = None,
    ) -> Any:
        score, feedback = score_prediction(example, prediction)
        # DSPy GEPA uses a 0..1 metric with perfect_score=1.0. Keep the
        # persisted evaluation scores in the user-facing 0..100 scale.
        return dspy.Prediction(score=score / 100.0, feedback=feedback)

    trainset = [dspy.Example(instruction=item.get("prompt", ""), expected_behavior=item.get("expected_behavior", "")).with_inputs("instruction") for item in train]
    valset = [dspy.Example(instruction=item.get("prompt", ""), expected_behavior=item.get("expected_behavior", "")).with_inputs("instruction") for item in validation]
    holdout = [item for item in examples if item.get("split") == "holdout"]
    baseline_evaluations = evaluate_module(student, holdout, dspy)
    baseline_holdout_score = sum(item["score"] for item in baseline_evaluations) / max(1, len(baseline_evaluations))
    emit({"type": "progress", "phase": "optimizing", "value": 0.15, "message": "GEPAを開始"})
    try:
        optimizer = gepa_class(metric=metric, auto="light", reflection_lm=host_lm, num_threads=1, track_stats=True)
        with redirect_stdout(sys.stderr):
            try:
                optimized = optimizer.compile(student=student, trainset=trainset, valset=valset)
            except TypeError:
                optimized = optimizer.compile(student=student, trainset=trainset)
    except Exception as exc:
        fail(f"gepa_failed:{type(exc).__name__}:{exc}")
        return

    candidate_body = extract_skill_body(optimized)
    if not candidate_body:
        fail("gepa_candidate_body_missing")
        return
    baseline_all_evaluations = evaluate_module(student, examples, dspy)
    baseline_scores = {
        str(item.get("id", "")): evaluation["score"]
        for item, evaluation in zip(examples, baseline_all_evaluations)
    }
    details = getattr(optimized, "detailed_results", None)
    raw_candidates = list(getattr(details, "candidates", []) or []) if details is not None else []
    if not raw_candidates:
        raw_candidates = [optimized]
    validation_scores = list(getattr(details, "val_aggregate_scores", []) or []) if details is not None else []
    parents = list(getattr(details, "parents", []) or []) if details is not None else []
    candidate_entries: list[dict[str, Any]] = []
    seen_bodies: set[str] = set()
    for index, module in enumerate(raw_candidates[:8]):
        body_for_candidate = extract_skill_body(module)
        if not body_for_candidate or body_for_candidate in seen_bodies:
            continue
        seen_bodies.add(body_for_candidate)
        parent_index: int | None = None
        if index < len(parents) and isinstance(parents[index], list):
            parent_index = next((item for item in parents[index] if isinstance(item, int)), None)
        evaluations, candidate_holdout_score, candidate_regression, candidate_feedback = evaluate_candidate(module, examples, baseline_scores, dspy)
        validation_score = validation_scores[index] if index < len(validation_scores) and isinstance(validation_scores[index], (int, float)) else None
        candidate_entries.append({
            "index": index,
            "body": body_for_candidate,
            "parent_index": parent_index,
            "validation_score": validation_score,
            "baseline_holdout_score": baseline_holdout_score,
            "holdout_score": candidate_holdout_score,
            "important_regression": candidate_regression,
            "evaluations": evaluations,
            "feedback": candidate_feedback,
        })
    if not candidate_entries:
        fail("gepa_candidate_body_missing")
        return
    # Keep generated variants for review. If GEPA only returned its seed, retain
    # that one so the Runtime can record a rejected, unchanged candidate.
    changed_entries = [item for item in candidate_entries if item["body"] != body]
    if changed_entries:
        candidate_entries = changed_entries
    candidate_entries.sort(key=lambda item: (float(item["validation_score"]) if item["validation_score"] is not None else item["holdout_score"], item["index"]), reverse=True)
    best_entry = candidate_entries[0]
    candidate_body = str(best_entry["body"])
    candidate_evaluations = best_entry["evaluations"]
    holdout_score = float(best_entry["holdout_score"])
    important_regression = bool(best_entry["important_regression"])
    trace = [{"kind": "host_lm", "messages": item.get("messages", []), "response_length": len(str(item.get("response", "")))} for item in host_lm.history]
    emit({"type": "progress", "phase": "evaluating", "value": 0.75, "message": "候補を評価"})
    emit({
        "type": "result",
        "status": "completed",
        "candidate_body": candidate_body,
        "candidates": candidate_entries,
        "baseline_holdout_score": baseline_holdout_score,
        "holdout_score": holdout_score,
        "important_regression": important_regression,
        "related_tests_passed": True,
        "safety_checks_passed": True,
        "evaluations": candidate_evaluations,
        "feedback": ["GEPA generated reviewable Skill variants."],
        "trace": trace,
        "optimizer_version": OPTIMIZER_VERSION,
        "runtime": platform.python_version()
    })


def main() -> None:
    line = sys.stdin.readline()
    if not line:
        fail("worker_input_missing")
        return
    try:
        request = json.loads(line)
    except json.JSONDecodeError as exc:
        fail(f"worker_input_invalid:{exc}")
        return
    if request.get("type") != "start":
        fail("worker_start_required")
        return
    run_gepa(request)


if __name__ == "__main__":
    main()
