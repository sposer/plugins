// How a streamed reply's tool call fragments are put together: two calls
// that share an index but have their own ids are two calls, not one with
// {"a"}{"b"} arguments (plugins#930). Fragments with no id, or the same
// id, go on with the open call.
import { expect, test } from "bun:test";
import { slimSchema, toolCallFolder } from "./lib/server.mjs";

const fold = (fragments) => {
  const calls = toolCallFolder();
  for (const tc of fragments) calls.add(tc);
  return calls.list();
};
const A = { index: 0, id: "call_fixture_A", type: "function", function: { name: "fixture_alpha", arguments: '{"key":"A"}' } };
const B = (index) => ({ index, id: "call_fixture_B", type: "function", function: { name: "fixture_beta", arguments: '{"key":"B"}' } });
const both = [{ id: "call_fixture_A", name: "fixture_alpha", args: '{"key":"A"}' }, { id: "call_fixture_B", name: "fixture_beta", args: '{"key":"B"}' }];

test("two ids at one index are two calls", () => {
  const calls = fold([A, B(0)]);
  expect(calls).toEqual(both);
  for (const c of calls) expect(() => JSON.parse(c.args)).not.toThrow();
});

test("calls at their own indexes stay two calls", () => {
  expect(fold([A, B(1)])).toEqual(both);
});

test("fragments with no id, or the same id, go on with the open call", () => {
  expect(fold([
    { index: 0, id: "call_fixture_A", type: "function", function: { name: "fixture_alpha", arguments: '{"ke' } },
    { index: 0, function: { arguments: 'y":' } },
    { index: 0, id: "call_fixture_A", function: { arguments: '"A"}' } },
  ])).toEqual([{ id: "call_fixture_A", name: "fixture_alpha", args: '{"key":"A"}' }]);
});

test("slimSchema preserves nullable anyOf/oneOf enum values and scalar types", () => {
  expect(slimSchema({
    type: "object",
    properties: {
      theme: {
        description: "Preferred theme\nSecond line",
        anyOf: [{ type: "string", enum: ["light", "dark"] }, { type: "null" }],
      },
      mode: {
        oneOf: [{ const: "fast" }, { const: "safe" }, { type: "null" }],
      },
      typeList: {
        type: ["string", "null"],
        enum: ["a", "b", null],
      },
      limit: {
        anyOf: [{ type: "integer" }, { type: "null" }],
      },
      tags: {
        anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
      },
    },
  })).toEqual({
    type: "object",
    properties: {
      theme: { type: "string", description: "Preferred theme", enum: ["light", "dark"] },
      mode: { type: "string", enum: ["fast", "safe"] },
      typeList: { type: "string", enum: ["a", "b"] },
      limit: { type: "integer" },
      tags: { type: "array", items: { type: "string" } },
    },
  });
});
