import assert from "node:assert/strict";
import { operationDefinitions } from "../../packages/domain-operations/src/generated/operation-index.generated";
import { handlerExpectations } from "./domain-operation-handler-expectations";
import { aHandlerExpectations } from "./domain-operation-handler-expectations-shard-a";
import { bHandlerExpectations } from "./domain-operation-handler-expectations-shard-b";
import { cHandlerExpectations } from "./domain-operation-handler-expectations-c";

const expected = operationDefinitions.map(({ id }) => id).sort();
const partitions = [
  Object.keys(handlerExpectations),
  Object.keys(aHandlerExpectations),
  Object.keys(bHandlerExpectations),
  Object.keys(cHandlerExpectations)
];
const all = partitions.flat();
const counts = new Map<string, number>();
for (const id of all) counts.set(id, (counts.get(id) ?? 0) + 1);
const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
const actual = [...counts.keys()].sort();
const missing = expected.filter((id) => !counts.has(id));
const extra = actual.filter((id) => !expected.includes(id));

assert.equal(expected.length, 167, "handler_matrix_expected_operation_count");
assert.deepEqual(duplicates, [], "handler_matrix_partition_duplicate");
assert.deepEqual(missing, [], "handler_matrix_partition_missing");
assert.deepEqual(extra, [], "handler_matrix_partition_extra");
assert.deepEqual(actual, expected, "handler_matrix_partition_set_drift");

process.stdout.write(`${JSON.stringify({
  status: "passed",
  expected_operations: expected.length,
  expected_operation_ids: expected,
  duplicate_operation_ids: duplicates,
  missing_operation_ids: missing,
  extra_operation_ids: extra,
  partition_counts: partitions.map((ids) => ids.length)
})}\n`);
