// magpie-community/plugins#352: Command Code was told "magpie" twice, as
// the Go catalog's User-Agent and as every /alpha/generate request's
// x-project-slug. Nothing that goes upstream names the app: the catalog is
// asked as the CLI asks it (Node's fetch, "node") and the slug is the
// full working path slugified as command-code@1.89.2 does.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { CommandCodePlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
let zdr
beforeEach(() => {
  zdr = process.env.CMD_ZDR
  delete process.env.CMD_ZDR
})
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
  if (zdr === undefined) delete process.env.CMD_ZDR
  else process.env.CMD_ZDR = zdr
})

const finish = JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 3, outputTokens: 1 } })

function record() {
  const sent = []
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    const body = init.body == null ? "" : typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body)
    sent.push({ url, path: new URL(url).pathname, headers, body })
    const path = new URL(url).pathname
    if (path === "/alpha/generate") return new Response(JSON.stringify({ type: "text-delta", text: "hi" }) + "\n" + finish + "\n")
    if (path.endsWith("/models")) return Response.json({ data: [{ id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" }] })
    if (path.startsWith("/provider/")) return Response.json({ choices: [] })
    return new Response("", { status: 404 })
  }
  return sent
}

// upstream is everything a request carries: its URL, every header's name
// and value, and its body
const upstream = (s) => [s.url, ...[...s.headers].flat(), s.body].join("\n")

async function chat(plan, dir) {
  const hooks = await CommandCodePlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "k", metadata: { plan } }))
  const headers = dir === undefined ? {} : { "x-magpie-work-dir": encodeURIComponent(dir), "x-magpie-work-git": "yes" }
  const res = await opts.fetch("https://api.commandcode.ai/provider/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] }),
  })
  await res.text()
}

test("no request to Command Code names magpie: Go, Provider API and the catalog (#352)", async () => {
  const sent = record()
  await chat("Go", "/Users/me/shop")
  await chat("Pro", "/Users/me/shop")
  await _internal.goModels()
  expect(sent.some((s) => s.path === "/alpha/generate")).toBe(true)
  expect(sent.some((s) => s.path.endsWith("/models"))).toBe(true)
  for (const s of sent) expect(upstream(s)).not.toMatch(/magpie/i)
})

test("Go requests use the released CLI identity and its full-path project slug", async () => {
  const sent = record()
  await chat("Go", "/Users/me/shop")
  await chat("Go", "/Else/shop")
  const [first, second] = sent.filter((s) => s.path === "/alpha/generate")
  expect(Object.fromEntries(first.headers)).toEqual({
    "content-type": "application/json",
    "user-agent": "cli",
    "x-command-code-version": "1.89.2",
    "x-cli-environment": "production",
    "x-project-slug": "users-me-shop",
    "x-taste-learning": "false",
    "x-session-id": first.headers.get("x-session-id"),
    authorization: "Bearer k",
  })
  expect(first.headers.get("x-session-id")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(second.headers.get("x-session-id")).toBe(first.headers.get("x-session-id"))
  expect(second.headers.get("x-project-slug")).toBe("else-shop")
  expect(_internal.projectSlug("/")).toBe("root")
  expect(_internal.projectSlug("C:\\Users\\me\\MyProject")).toBe("c-users-me-my-project")
  expect(_internal.projectSlug("/Users/me/café")).toBe("users-me-cafe")
  expect(_internal.projectSlug("/Users/me/项目")).toBe("users-me")
  expect(_internal.projectSlug("/я люблю единорогов")).toBe("ya-lyublyu-edinorogov")
})

test("the catalog is asked as the CLI's Node fetch asks it", async () => {
  const sent = record()
  await _internal.goModels()
  expect(sent.find((s) => s.path.endsWith("/models")).headers.get("user-agent")).toBe("node")
})
