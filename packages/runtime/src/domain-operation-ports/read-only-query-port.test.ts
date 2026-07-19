import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { domainQueryReadCapability, domainWriteCapability } from "@samurai-agent/domain-operations";
import { readOnlyQueryPort } from "./read-only-query-port.js";

describe("readOnlyQueryPort", () => {
  it("brands and freezes the port and every callable without changing invocation", async () => {
    const calls: string[] = [];
    const port = readOnlyQueryPort<{ read: (value: string) => Promise<string> }>({
      read: async (value) => {
        calls.push(value);
        return value.toUpperCase();
      }
    });

    assert.equal(Object.isFrozen(port), true);
    assert.equal(port[domainQueryReadCapability], true);
    assert.equal(domainWriteCapability in port, false);
    assert.equal(port.read[domainQueryReadCapability], true);
    assert.equal(domainWriteCapability in port.read, false);
    assert.equal(await port.read("query"), "QUERY");
    assert.deepEqual(calls, ["query"]);
  });
});
