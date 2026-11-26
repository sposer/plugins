import assert from "node:assert/strict"
import { test } from "node:test"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

const request = baseBody({ tools: [], messages: [
  { role: "user", content: "The test word is lemon." },
  { role: "assistant", content: "Noted." },
  { role: "user", content: "What is the test word?" },
] })

test("TUI mode sends text history and returns the native result to JSON and SSE clients", async t => {
  const prompts = []
  const kit = await createBridgeKit({ platform: "linux", env: { AGY_BRIDGE_MODE: "tui" },
    runTui: async (_file, { prompt, model }) => {
      prompts.push({ prompt, model })
      return { text: "lemon", inputTokens: 9, outputTokens: 2, cacheReadTokens: 7 }
    },
  })
  t.after(() => kit.dispose())
  const json = await kit.request({ ...request, stream: false })
  assert.equal(json.status, 200)
  const reply = await json.json()
  assert.deepEqual(reply.content, [{ type: "text", text: "lemon" }])
  assert.equal(reply.usage.cache_read_input_tokens, 7)
  const sse = await readSse(await kit.request(request))
  assert.deepEqual(sse.content, reply.content)
  assert.equal(sse.stopReason, "end_turn")
  assert.equal(sse.usage.output_tokens, 2)
  assert.ok(prompts.every(({ prompt, model }) => prompt.includes("The test word is lemon.") &&
    prompt.includes("What is the test word?") && model === "gemini-4-argon"))
  assert.equal(prompts.length, 2)
  assert.equal(kit.acpSpawns.length, 0)
})

test("tool requests and the default mode stay on ACP", async t => {
  const kit = await createBridgeKit({ platform: "linux", env: { AGY_BRIDGE_MODE: "tui" } })
  t.after(() => kit.dispose())
  kit.defaultPrompt = agent => agent.text("ACP reply")
  const toolRequest = await readSse(await kit.request(baseBody()))
  assert.equal(toolRequest.stopReason, "end_turn")
  assert.ok(kit.acpLog.some(event => event.method === "session/prompt"))

  delete kit.env.AGY_BRIDGE_MODE
  await readSse(await kit.request({ ...request, stream: true }))
  assert.equal(kit.acpLog.filter(event => event.method === "session/prompt").length, 2)
})

test("a failed TUI turn is not resubmitted over ACP", async t => {
  const kit = await createBridgeKit({ platform: "linux", env: { AGY_BRIDGE_MODE: "tui" },
    runTui: async () => { throw Object.assign(new Error("turn interrupted"), { statusCode: 504 }) },
  })
  t.after(() => kit.dispose())
  const response = await kit.request(request)
  assert.equal(response.status, 504)
  assert.equal(kit.acpSpawns.length, 0)
})

test("TUI and ACP share the process limit and cancellation releases a slot", async t => {
  let started
  const pending = new Promise(resolve => { started = resolve })
  const kit = await createBridgeKit({ platform: "linux", env: { AGY_BRIDGE_MODE: "tui", AGY_BRIDGE_MAX_PROCS: "1" },
    runTui: async (_file, { signal }) => {
      started()
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }))
      throw Object.assign(new Error("turn cancelled"), { statusCode: 499 })
    },
  })
  t.after(() => kit.dispose())
  const controller = new AbortController()
  t.after(() => controller.abort())
  const turn = kit.request(request, { signal: controller.signal })
  await pending
  assert.equal((await kit.request(baseBody())).status, 503)
  controller.abort()
  assert.equal((await turn).status, 499)
  kit.defaultPrompt = agent => agent.text("ACP reply")
  assert.equal((await readSse(await kit.request(baseBody()))).stopReason, "end_turn")
})
