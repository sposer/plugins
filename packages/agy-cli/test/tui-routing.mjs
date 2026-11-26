import assert from "node:assert/strict"
import { once } from "node:events"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { baseBody, createBridgeKit, MESSAGES_URL, readSse, tick } from "./testkit.mjs"

const request = baseBody({ tools: [], messages: [
  { role: "user", content: "The test word is lemon." },
  { role: "assistant", content: "Noted." },
  { role: "user", content: "What is the test word?" },
] })

test("TUI sends text history and returns the native result to JSON and SSE clients", async t => {
  const prompts = []
  const kit = await createBridgeKit({
    runTui: async (_file, { prompt }) => {
      prompts.push(prompt)
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
  assert.equal(prompts.length, 2)
  assert.ok(prompts.every(prompt => prompt.includes("The test word is lemon.") &&
    prompt.includes("What is the test word?")))
})

test("control characters in the client history reach the native editor as visible text", async t => {
  const prompts = []
  const kit = await createBridgeKit({ runTui: async (_file, { prompt }) => { prompts.push(prompt); return { text: "red" } } })
  t.after(() => kit.dispose())
  const response = await kit.request({ ...request, stream: false, messages: [
    ...request.messages.slice(0, -1), { role: "user", content: "Which colour is \x1b[31mthis\x1b[0m?\x07\x7f" },
  ] })
  assert.equal(response.status, 200)
  assert.match(prompts[0], /Which colour is ␛\[31mthis␛\[0m\?␇␡/)
  assert.doesNotMatch(prompts[0], /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/)
})

test("the cached native catalog selects exact model IDs in the PTY command", async t => {
  const launches = []
  const kit = await createBridgeKit({ onTuiLaunch: args => launches.push(args) })
  t.after(() => kit.dispose())
  const models = [
    { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", effort: "medium" },
    { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", effort: "high" },
    { id: "gemini-4-argon-max", name: "Gemini 4 Argon (Max)", effort: "max" },
    { id: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)", effort: "medium" },
    { id: "gemini-4-carbon-xhigh", name: "Gemini 4 Carbon (Extra High)", effort: "xhigh" },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", effort: "medium" },
  ]
  const dir = path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ version: 1, byAgy: {
    [kit.agyPath]: { at: Date.UTC(2026, 10, 4, 12), list: models },
  } }))

  for (const [model, effort, selected, flag] of [
    ["agy-cli/gemini-4-argon[1m]", "medium", "gemini-4-argon-medium"],
    ["gemini-4-argon", undefined, "gemini-4-argon-high"],
    ["gemini-4-argon", "low", "gemini-4-argon-medium"],
    ["gemini-4-argon", "xhigh", "gemini-4-argon-max"],
    ["gemini-4-carbon", undefined, "gemini-4-carbon-xhigh"],
    ["gpt-oss-120b", "high", "gpt-oss-120b-medium"],
    ["gemini-4-argon-medium", "high", "gemini-4-argon-medium"],
    ["native-unlisted", "high", "native-unlisted", "high"],
  ]) {
    const label = `${model} with ${effort ?? "default"} effort`
    const previous = launches.length
    await kit.request({ ...request, model, reasoning_effort: effort })
    assert.equal(launches.length, previous + 1, label)
    const args = launches.at(-1)
    const command = args[args.indexOf("-c") + 1]
    // Read only the model-selection flags; shell quoting and unrelated flags are not the contract.
    const flags = [...command.matchAll(/(?:^|\s)['"]?(--(?:model|effort))(?=['"\s=]|$)['"]?(?:(?:\s+|=)['"]?([^\s'"]+))?/g)]
      .map(([, name, value]) => [name, value]).sort()
    const expected = [["--model", selected]]
    if (flag) expected.unshift(["--effort", flag])
    assert.deepEqual(flags, expected, label)
  }
  assert.deepEqual(kit.helpSpawns, [])
  assert.deepEqual(kit.modelsSpawns, [])
})

// Calls the first bridge tool and returns its result, or ends quietly once the turn is aborted.
const callOnce = kit => async (_file, { mcp, signal }) => {
  if (!mcp) return { text: "text-only turn" }
  const call = await Promise.race([
    kit.control({ token: mcp.token, kind: "call", name: mcp.tools[0].name, arguments: { path: "lemon.txt" } }),
    once(signal, "abort").then(() => null),
  ])
  if (!call) throw Object.assign(new Error("turn cancelled"), { statusCode: 499 })
  return { text: call.result.content[0].text }
}

const withResult = (initial, content, value) => ({ ...initial, stream: false, messages: [...initial.messages,
  { role: "assistant", content }, { role: "user", content: [{ type: "tool_result", tool_use_id: content.at(-1).id, content: value }] },
] })

test("client tool results resume only the original scoped TUI, and other requests replay their history", async t => {
  const kit = await createBridgeKit({
    runTui: async (_file, { mcp, signal }) => {
      const { result: { tools } } = await kit.control({ token: mcp.token, kind: "list" })
      const call = await Promise.race([
        kit.control({ token: mcp.token, kind: "call", name: tools[0].name, arguments: { path: "lemon.txt" } }),
        once(signal, "abort").then(() => null),
      ])
      return { text: call ? call.result.content[0].text : "ended" }
    },
  })
  t.after(() => kit.dispose())
  const initial = baseBody()
  const scope = { headers: { "X-Magpie-Session": "original" } }
  const reply = await readSse(await kit.request(initial, scope))
  assert.equal(reply.stopReason, "tool_use")
  const [call] = reply.content
  assert.equal(call.type, "tool_use")
  assert.equal(call.name, initial.tools[0].name)
  assert.deepEqual(call.input, { path: "lemon.txt" })
  const followUp = { ...initial, stream: false, messages: [...initial.messages, { role: "assistant", content: reply.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "lemon found" }] },
  ] }
  const viaRequest = (body, session) => kit.fetch(new Request(MESSAGES_URL, {
    method: "POST", headers: { "X-Magpie-Session": session }, body: JSON.stringify(body),
  }))
  // Another session's copy of the history runs in its own turn; the owner's turn keeps waiting.
  const foreign = await viaRequest(followUp, "another")
  assert.equal(foreign.status, 200)
  const replayed = await foreign.json()
  assert.equal(replayed.stop_reason, "tool_use")
  assert.notEqual(replayed.content.at(-1).id, call.id)
  assert.equal(kit.tuiRuns.length, 2)
  assert.match(kit.tuiRuns[1].prompt, /lemon found/)
  assert.equal(kit.tuiRuns[0].signal.aborted, false)
  const mixed = { ...followUp, messages: [...initial.messages,
    { role: "assistant", content: [{ ...call, id: "toolu_foreign" }] }, followUp.messages.at(-1),
  ] }
  assert.equal((await kit.request(mixed, scope)).status, 400)
  // Claude clients may normalize/default arguments while keeping our call ID.
  const normalized = structuredClone(followUp)
  normalized.messages.at(-2).content[0].input = { path: "lemon.txt", encoding: "utf8" }
  const finished = await viaRequest(normalized, "original")
  assert.equal(finished.status, 200)
  assert.deepEqual((await finished.json()).content, [{ type: "text", text: "lemon found" }])
  assert.equal(kit.tuiRuns.length, 2)
  // A result repeated after its turn finished is replayed, not refused.
  const repeated = await viaRequest(followUp, "original")
  assert.equal(repeated.status, 200)
  assert.equal(kit.tuiRuns.length, 3)
  assert.match(kit.tuiRuns[2].prompt, /lemon found/)
})

test("a turn whose client holds its tool call gives up its slot only under pressure, and the result replays", async t => {
  const kit = await createBridgeKit({ env: { AGY_BRIDGE_MAX_PROCS: "1" }, runTui: (...args) => callOnce(kit)(...args) })
  t.after(() => kit.dispose())
  const initial = baseBody()
  const { content } = await readSse(await kit.request(initial))
  // A client that just received its call keeps the slot.
  assert.equal((await kit.request(request)).status, 503)
  assert.equal(kit.tuiRuns[0].signal.aborted, false)
  kit.advance(30_000)
  const other = await kit.request({ ...request, stream: false })
  assert.equal(other.status, 200)
  assert.deepEqual((await other.json()).content, [{ type: "text", text: "text-only turn" }])
  assert.equal(kit.tuiRuns[0].signal.aborted, true)
  const late = await kit.request(withResult(initial, content, "lemon found"))
  assert.equal(late.status, 200)
  assert.equal(kit.tuiRuns.length, 3)
  assert.match(kit.tuiRuns[2].prompt, /lemon found/)
})

test("a tool result that does not come back in time ends the turn, and the late result replays", async t => {
  const kit = await createBridgeKit({ env: { AGY_BRIDGE_TOOL_TIMEOUT_MS: "20" }, runTui: (...args) => callOnce(kit)(...args) })
  t.after(() => kit.dispose())
  const initial = baseBody()
  const { content } = await readSse(await kit.request(initial))
  const { signal, mcp } = kit.tuiRuns[0]
  if (!signal.aborted) await once(signal, "abort", { signal: AbortSignal.timeout(1000) })
  await tick()
  assert.equal((await kit.control({ token: mcp.token, kind: "list" })).error.code, -32603)
  const late = await kit.request(withResult(initial, content, "lemon found"))
  assert.equal(late.status, 200)
  assert.equal(kit.tuiRuns.length, 2)
  assert.match(kit.tuiRuns[1].prompt, /lemon found/)
})

test("each response reports the tokens of the native steps since the previous response", async t => {
  const kit = await createBridgeKit({
    runTui: async (_file, { mcp, observer }) => {
      const steps = (inputTokens, outputTokens, cacheReadTokens, count, toolCalls) =>
        observer.progress({ inputTokens, outputTokens, cacheReadTokens, steps: count, toolCalls })
      observer.phase("ready")
      observer.phase("submitted")
      steps(0, 0, 0, 0, 0)
      const call = kit.control({ token: mcp.token, kind: "call", name: mcp.tools[0].name, arguments: { path: "lemon.txt" } })
      // The MCP call can arrive before the polled transcript shows its planner step.
      setTimeout(() => steps(10, 3, 4, 1, 1), 30)
      await call
      steps(25, 8, 9, 2, 1)
      return { text: "done", inputTokens: 25, outputTokens: 8, cacheReadTokens: 9 }
    },
  })
  t.after(() => kit.dispose())
  const initial = { ...baseBody(), stream: false }
  const first = await (await kit.request(initial)).json()
  assert.equal(first.stop_reason, "tool_use")
  assert.deepEqual(first.usage, { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 })
  const last = await (await kit.request(withResult(initial, first.content, "lemon found"))).json()
  assert.equal(last.stop_reason, "end_turn")
  assert.deepEqual(last.usage, { input_tokens: 15, output_tokens: 5, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 })
})

test("invalid replay input leaves the live tool open, but a removed catalog starts a new TUI", async t => {
  const runs = []
  const kit = await createBridgeKit({ env: { AGY_BRIDGE_MAX_PROCS: "1" },
    runTui: async (_file, { mcp, prompt, signal }) => {
      runs.push({ mcp, prompt, signal })
      if (!mcp) return { text: "no more tools" }
      const result = await Promise.race([
        kit.control({ token: mcp.token, kind: "call", name: mcp.tools[0].name, arguments: {} }),
        new Promise(resolve => signal.addEventListener("abort", () => resolve(null), { once: true })),
      ])
      assert.equal(result, null, "the old tool must not receive any result")
    },
  })
  t.after(() => kit.dispose())
  const initial = baseBody()
  const { content } = await readSse(await kit.request(initial))
  const followUp = value => ({ ...initial, stream: false, tool_choice: { type: "none" }, messages: [
    ...initial.messages, { role: "assistant", content }, { role: "user", content: [
      { type: "tool_result", tool_use_id: content[0].id, content: value },
    ] },
  ] })
  const invalid = [{ type: "image", source: { type: "base64", media_type: "image/gif", data: "AAAA" } }]
  assert.equal((await kit.request(followUp(invalid))).status, 400)
  assert.equal(runs[0].signal.aborted, false)
  const reply = await kit.request(followUp("Already found: lemon."))
  assert.equal(reply.status, 200)
  assert.deepEqual((await reply.json()).content, [{ type: "text", text: "no more tools" }])
  assert.equal(runs.length, 2)
  assert.equal(runs[0].signal.aborted, true)
  assert.equal(runs[1].mcp, undefined)
  assert.match(runs[1].prompt, /Already found: lemon\./)
})

test("a failed native turn is returned without retry or fallback", async t => {
  const kit = await createBridgeKit({
    runTui: async () => { throw Object.assign(new Error("turn interrupted"), { statusCode: 504 }) },
  })
  t.after(() => kit.dispose())
  const response = await kit.request(request)
  assert.equal(response.status, 504)
  assert.equal(kit.tuiRuns.length, 1)
})

test("an unsupported host does not attempt another transport", async t => {
  const kit = await createBridgeKit({ platform: "win32" })
  t.after(() => kit.dispose())
  assert.equal((await kit.request(request)).status, 503)
  assert.equal(kit.tuiRuns.length, 0)
})

test("the native process limit rejects excess turns and cancellation releases a slot", async t => {
  let started
  const pending = new Promise(resolve => { started = resolve })
  const kit = await createBridgeKit({ env: { AGY_BRIDGE_MAX_PROCS: "1" },
    runTui: async (_file, { signal }) => {
      if (kit.tuiRuns.length > 1) return { text: "next turn completed" }
      started()
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }))
      throw Object.assign(new Error("turn cancelled"), { statusCode: 499 })
    },
  })
  t.after(() => kit.dispose())
  const controller = new AbortController()
  t.after(() => controller.abort())
  const turn = kit.fetch(new Request(MESSAGES_URL, { method: "POST", body: JSON.stringify(request), signal: controller.signal }))
  // Surface an early response rather than waiting forever if routing regresses.
  assert.equal(await Promise.race([pending.then(() => "started"), turn.then(response => response.status)]), "started")
  assert.equal((await kit.request(baseBody())).status, 503)
  assert.equal(kit.tuiRuns.length, 1)
  controller.abort()
  assert.equal((await turn).status, 499)
  assert.equal((await readSse(await kit.request(request))).stopReason, "end_turn")
  assert.equal(kit.tuiRuns.length, 2)
})

test("aborting the original Request after tool_use closes the tool and releases its slot", async t => {
  const kit = await createBridgeKit({ env: { AGY_BRIDGE_MAX_PROCS: "1" },
    runTui: async (_file, { mcp, signal }) => {
      if (!mcp) return { text: "slot released" }
      const tool = kit.control({ token: mcp.token, kind: "call", name: mcp.tools[0].name, arguments: { path: "file.txt" } })
      if (!signal.aborted) await once(signal, "abort")
      return { text: "cancelled", tool }
    },
  })
  const controller = new AbortController()
  t.after(async () => { controller.abort(); await kit.dispose() })
  const pending = await readSse(await kit.fetch(new Request(MESSAGES_URL, {
    method: "POST", body: JSON.stringify(baseBody()), signal: controller.signal,
  })))
  assert.equal(pending.stopReason, "tool_use")
  assert.equal((await kit.request(request)).status, 503)
  const { signal, mcp } = kit.tuiRuns[0]
  const aborted = once(signal, "abort", { signal: AbortSignal.timeout(1000) })
  controller.abort()
  await aborted
  await tick()
  assert.equal((await kit.control({ token: mcp.token, kind: "list" })).error.code, -32603)
  assert.deepEqual((await readSse(await kit.request(request))).content, [{ type: "text", text: "slot released" }])
})
