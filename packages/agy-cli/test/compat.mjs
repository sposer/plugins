import assert from "node:assert/strict"
import { once } from "node:events"
import { test } from "node:test"
import { baseBody, COUNT_TOKENS_URL, createBridgeKit, readSse } from "./testkit.mjs"

const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2VB" } }
const text = value => ({ type: "text", text: value })
const user = content => ({ role: "user", content })

test("native replay marks the original image position and attaches the original bytes", async t => {
  const kit = await createBridgeKit({ runTui: async () => ({ text: "image received" }) })
  t.after(() => kit.dispose())
  const body = baseBody({ tools: [], messages: [
    user([text("before picture"), image, text("after picture")]),
    { role: "assistant", content: "old reply" }, user("current question"),
  ] })
  await readSse(await kit.request(body))
  const [{ parts }] = kit.tuiRuns
  assert.deepEqual(parts.slice(1), [{ type: "image", data: image.source.data, mimeType: "image/png" }])
  assert.match(parts[0].text, /before picture\s*\[Image 1 is attached\]\s*after picture[\s\S]*current question/)
})

test("new user text or an image beside a live tool result replays as input, not as an MCP reply", async t => {
  for (const steer of [text("Inspect the new information"), image]) {
    let oldReply
    const kit = await createBridgeKit({ runTui: async (_file, { mcp, signal }) => {
      if (kit.tuiRuns.length > 1) return { text: "new turn" }
      oldReply = kit.control({ token: mcp.token, kind: "call", name: "Read", arguments: { path: "test.txt" } })
      await Promise.race([oldReply, once(signal, "abort")])
    } })
    try {
      const initial = baseBody()
      const { content } = await readSse(await kit.request(initial))
      const followUp = { ...initial, messages: [...initial.messages, { role: "assistant", content },
        user([steer, { type: "tool_result", tool_use_id: content[0].id, content: "file contents" }]),
      ] }
      const reply = await readSse(await kit.request(followUp))
      assert.deepEqual(reply.content, [text("new turn")])
      assert.equal(await oldReply, null)
      assert.equal(kit.tuiRuns.length, 2)
      const [original, replay] = kit.tuiRuns
      assert.equal(original.signal.aborted, true)
      assert.match(replay.prompt, /file contents/)
      if (steer.type === "text") assert.ok(replay.prompt.includes(steer.text))
      else assert.equal(replay.parts[1].data, image.source.data)
    } finally {
      await kit.dispose()
    }
  }
})

test("standard count_tokens Requests are handled without launching the CLI", async t => {
  const kit = await createBridgeKit({ agyPath: null })
  t.after(() => kit.dispose())
  const request = body => new Request(COUNT_TOKENS_URL, { method: "POST", body: JSON.stringify(body) })
  async function count(messages) {
    const response = await kit.fetch(request({ messages }))
    assert.equal(response.status, 200)
    return (await response.json()).input_tokens
  }
  const short = await count([user("short")])
  const long = await count([user("substantially longer input ".repeat(100))])
  assert.ok(Number.isInteger(short) && short > 0 && long > short)
  assert.equal((await kit.fetch(request({ messages: "invalid" }))).status, 400)
  assert.equal(kit.tuiRuns.length, 0)
})
