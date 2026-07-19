import assert from "node:assert/strict";
import { planPresentation, type PresentationMode, type PresentationPlannerInput } from "../../packages/runtime/src/presentation/planner";

type Case = { name: string; expected: PresentationMode; input: PresentationPlannerInput };
const client = { builtInKinds: ["table", "form", "chart", "timeline", "collection"], generatedSurface: true };
const baseCases: Case[] = [
  { name: "ack", expected: "none", input: { userIntent: "ありがとう", hasResult: true, client } },
  { name: "empty result", expected: "none", input: { userIntent: "処理して", hasResult: false, client } },
  { name: "text only ja", expected: "text", input: { userIntent: "文章だけで説明して", resultKind: "table", operationPossible: true, client } },
  { name: "text only en", expected: "text", input: { userIntent: "text only please", resultKind: "chart", client } },
  { name: "plain", expected: "text", input: { userIntent: "違いを説明して", resultKind: "plain", client } },
  { name: "report", expected: "artifact", input: { userIntent: "調査レポートを作って", resultKind: "document", reusable: true, client } },
  { name: "proposal", expected: "artifact", input: { userIntent: "提案書を作って", reusable: true, client } },
  { name: "table", expected: "built_in_surface", input: { userIntent: "一覧で編集したい", resultKind: "table", operationPossible: true, client } },
  { name: "form", expected: "built_in_surface", input: { userIntent: "入力フォームを出して", resultKind: "form", operationPossible: true, client } },
  { name: "chart", expected: "built_in_surface", input: { userIntent: "推移をグラフで", resultKind: "chart", client } },
  { name: "timeline", expected: "built_in_surface", input: { userIntent: "履歴を時系列で", resultKind: "timeline", client } },
  { name: "collection", expected: "built_in_surface", input: { userIntent: "案件を管理したい", resultKind: "collection", operationPossible: true, client } },
  { name: "custom interactive", expected: "generated_surface", input: { userIntent: "独自の比較操作面がほしい", resultKind: "custom", operationPossible: true, generationCost: "low", client } },
  { name: "custom no operation", expected: "artifact", input: { userIntent: "独自形式で保存", resultKind: "custom", operationPossible: false, reusable: true, client } },
  { name: "custom privacy", expected: "artifact", input: { userIntent: "機密情報を独自表示", resultKind: "custom", operationPossible: true, reusable: true, privacy: "sensitive", client } },
  { name: "custom expensive", expected: "artifact", input: { userIntent: "巨大な独自画面", resultKind: "custom", operationPossible: true, reusable: true, generationCost: "high", client } },
  { name: "custom unsupported client", expected: "artifact", input: { userIntent: "独自画面", resultKind: "custom", operationPossible: true, reusable: true, client: { ...client, generatedSurface: false } } },
  { name: "table unsupported", expected: "artifact", input: { userIntent: "表を保存", resultKind: "table", reusable: true, client: { builtInKinds: [], generatedSurface: false } } },
  { name: "chart unsupported nonreusable", expected: "text", input: { userIntent: "ざっくり傾向", resultKind: "chart", reusable: false, client: { builtInKinds: [], generatedSurface: false } } },
  { name: "generated fallback", expected: "generated_surface", input: { userIntent: "操作可能なマトリクス", resultKind: "custom", operationPossible: true, client } }
];
const normalVariants = ["", "。お願いします", "、簡潔に", " for this task", " in the current workspace"];
const acknowledgementVariants = ["ありがとう", "ありがとうです", "ありがとうございます", "thanks", "ok"];
const cases: Case[] = baseCases.flatMap((item, caseIndex) => (item.name === "ack" ? acknowledgementVariants : normalVariants).map((intent, variantIndex) => ({ ...item, name: `${item.name}-${variantIndex}`, input: { ...item.input, userIntent: item.name === "ack" ? intent : `${item.input.userIntent}${intent}`, resourceRefs: [{ kind: "benchmark", id: `${caseIndex}-${variantIndex}`, uri: `benchmark://${caseIndex}/${variantIndex}` }] } })));

let correct = 0;
let unnecessaryUi = 0;
for (const item of cases) {
  const actual = planPresentation(item.input);
  assert.ok(actual.reason.length > 0);
  assert.ok(actual.confidence >= 0 && actual.confidence <= 1);
  if (actual.mode === item.expected) correct += 1;
  if ((item.expected === "text" || item.expected === "none") && (actual.mode === "built_in_surface" || actual.mode === "generated_surface")) unnecessaryUi += 1;
}
assert.equal(correct, cases.length);
assert.equal(unnecessaryUi, 0);
const modes = [...new Set(cases.map((item) => item.expected))].sort();
const macroF1 = modes.reduce((total, mode) => {
  const tp = cases.filter((item) => item.expected === mode && planPresentation(item.input).mode === mode).length;
  const fp = cases.filter((item) => item.expected !== mode && planPresentation(item.input).mode === mode).length;
  const fn = cases.filter((item) => item.expected === mode && planPresentation(item.input).mode !== mode).length;
  const precision = tp / Math.max(1, tp + fp), recall = tp / Math.max(1, tp + fn);
  return total + (2 * precision * recall) / Math.max(Number.EPSILON, precision + recall);
}, 0) / modes.length;
assert.ok(macroF1 >= 0.9);
process.stdout.write(`${JSON.stringify({ status: "passed", cases: cases.length, correct, accuracy: correct / cases.length, macro_f1: macroF1, unnecessary_ui: unnecessaryUi, unnecessary_ui_rate: unnecessaryUi / cases.length, modes })}\n`);
