import assert from "node:assert/strict"
import { test } from "node:test"
import { baseBody, createBridgeKit } from "./testkit.mjs"

const user = content => ({ role: "user", content })
const assistant = content => ({ role: "assistant", content })
const body = (messages, overrides) => baseBody({ tools: [], stream: false, messages, ...overrides })

test("a native output-format request carries the assistant seed after the original task", async t => {
  const kit = await createBridgeKit({ runTui: async () => ({ text: '{"answer":"lemon"}' }) })
  t.after(() => kit.dispose())
  const question = "Name the yellow fruit."
  const seed = 'The JSON answer starts here: {"answer":'
  const response = await kit.request(body([
    user("Previous question"), assistant("Previous reply"), user(question),
    assistant([{ type: "thinking", thinking: "Private scratch work" }, { type: "text", text: seed }]),
  ], { response_format: { type: "json_object" } }))
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse((await response.json()).content[0].text), { answer: "lemon" })
  assert.equal(kit.tuiRuns.length, 1)
  const { prompt } = kit.tuiRuns[0]
  assert.ok(prompt.includes(question) && prompt.indexOf(seed) > prompt.indexOf(question))
  assert.match(prompt, /single valid JSON object/)
  assert.doesNotMatch(prompt, /Private scratch work/)
})

test("orphan, tool-use and mixed tool-result prefill tails are rejected before TUI launch", async t => {
  const kit = await createBridgeKit()
  t.after(() => kit.dispose())
  const call = assistant([{ type: "tool_use", id: "call_a", name: "Read", input: { path: "a" } }])
  const result = user([{ type: "tool_result", tool_use_id: "call_a", content: "done" }])
  for (const messages of [[assistant("orphan")], [user("task"), call], [user("task"), call, result, assistant("seed")]]) {
    assert.equal((await kit.request(body(messages))).status, 400)
  }
  assert.equal(kit.tuiRuns.length, 0)
})

test("AGY_BRIDGE_PREFILL=0 rejects an assistant seed without launching the TUI", async t => {
  const kit = await createBridgeKit({ env: { AGY_BRIDGE_PREFILL: "0" } })
  t.after(() => kit.dispose())
  assert.equal((await kit.request(body([user("task"), assistant("seed")]))).status, 400)
  assert.equal(kit.tuiRuns.length, 0)
})
