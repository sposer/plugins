import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import http from "node:http"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { CommandCodePlugin, _internal } from "./index.mjs"

const realFetch = globalThis.fetch
const setTimer = globalThis.setTimeout
const clearTimer = globalThis.clearTimeout
const listen = http.Server.prototype.listen
let timers, controllers, cleanup, setSpy, clearSpy, servers

beforeEach(() => {
  _internal.subsSeen.clear()
  timers = new Map()
  controllers = []
  cleanup = []
  servers = spyOn(http.Server.prototype, "listen")
  setSpy = spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) => {
    const timer = setTimer(fn, ms, ...args)
    if (ms === 600_000 || ms === 10_000) timers.set(timer, { ms, fire: () => fn(...args) })
    return timer
  })
  clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
    timers.delete(timer)
    clearTimer(timer)
  })
})
afterEach(() => {
  for (const controller of controllers) controller.abort()
  for (const timer of timers.keys()) clearTimer(timer)
  for (const close of cleanup.reverse()) close()
  setSpy.mockRestore()
  clearSpy.mockRestore()
  servers.mockRestore()
  _internal.subsSeen.clear()
  globalThis.fetch = realFetch
})

function controller() {
  const c = new AbortController()
  controllers.push(c)
  return c
}
async function start(method = 0, cancel = controller()) {
  const hooks = await CommandCodePlugin()
  const flow = await hooks.auth.methods[method].authorize({}, { signal: cancel.signal })
  return { flow, cancel, params: flow.url ? new URL(flow.url).searchParams : undefined }
}
function fake(replies = {}) {
  const seen = []
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname
    const sent = { path, signal: init.signal, key: new Headers(init.headers).get("authorization") }
    seen.push(sent)
    const reply = replies[path]
    if (typeof reply === "function") return reply(sent)
    if (reply instanceof Response) return reply
    if (path === "/alpha/whoami") return Response.json({ user: { userName: "Ada", email: "ada@example.com" } })
    if (path === "/alpha/billing/subscriptions") return Response.json({ success: true, data: { planId: "individual-pro", status: "active" } })
    throw new Error(`unexpected account request: ${path}`)
  }
  return seen
}
function request(url, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      let text = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => (text += chunk))
      res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.once("error", reject)
    req.setTimeout(1000, () => req.destroy(new Error("loopback request timed out")))
    req.end(body)
  })
}
function post(params, fields = { apiKey: "studio-key" }, json = false) {
  const body = { state: params.get("state"), ...fields }
  return request(params.get("callback"), {
    method: "POST", headers: { "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded" },
    body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
  })
}
async function closed(params) {
  await expect(request(params.get("callback"))).rejects.toMatchObject({ code: "ECONNREFUSED" })
  expect(timers.size).toBe(0)
}
function expire(ms) {
  const timer = [...timers.values()].find((t) => t.ms === ms)
  expect(timer).toBeDefined()
  timer.fire()
}
function waitForAbort(signal) {
  return new Promise((_, reject) => {
    signal.throwIfAborted()
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}
function cliFixture() {
  const home = mkdtempSync(join(tmpdir(), "commandcode-auth-"))
  const old = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  cleanup.push(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  })
  expect(homedir()).toBe(home)
  mkdirSync(join(home, ".commandcode"))
  const path = join(home, ".commandcode", "auth.json")
  const content = JSON.stringify({ apiKey: "cli-key", userId: "cli-user", keyName: "CLI" })
  writeFileSync(path, content)
  return { path, content }
}

test("pre-cancelled authorize creates no listener, timer or request for browser and CLI", async () => {
  const seen = fake()
  const cancel = controller()
  cancel.abort()
  for (const method of [0, 1]) expect((await start(method, cancel)).flow.type).toBe("failed")
  expect(servers).not.toHaveBeenCalled()
  expect(timers.size).toBe(0)
  expect(seen).toHaveLength(0)
})

test("cancelling while the browser listener starts also completes authorize and closes it", async () => {
  const seen = fake()
  let server
  servers.mockImplementationOnce(function (...args) { server = this; return listen.apply(this, args) })
  cleanup.push(() => { try { server?.close(); server?.closeAllConnections?.() } catch {} })
  const hooks = await CommandCodePlugin()
  const cancel = controller()
  const pending = hooks.auth.methods[0].authorize({}, { signal: cancel.signal })
  cancel.abort()
  expect((await pending).type).toBe("failed")
  expect(server.listening).toBe(false)
  expect(timers.size).toBe(0)
  expect(seen).toHaveLength(0)
}, 1000)

test("cancelling authorize without a callback releases the browser listener", async () => {
  const seen = fake()
  const { flow, params, cancel } = await start()
  expect(servers).toHaveBeenCalledTimes(1)
  cancel.abort()
  expect((await flow.callback()).type).toBe("failed")
  expect(seen).toHaveLength(0)
  await closed(params)
})

test.each([true, false])("a callback cancelled before or during its browser wait closes the listener (pre: %s)", async (pre) => {
  const seen = fake()
  const { flow, params } = await start()
  const cancel = controller()
  if (pre) cancel.abort()
  const pending = flow.callback(undefined, { signal: cancel.signal })
  expect(flow.callback()).toBe(pending)
  if (!pre) cancel.abort()
  expect((await pending).type).toBe("failed")
  expect(seen).toHaveLength(0)
  await closed(params)
})

test("browser expiry without callback closes the listener instead of keeping a failure page", async () => {
  const seen = fake()
  const { flow, params } = await start()
  expire(600_000)
  expect((await flow.callback()).type).toBe("failed")
  expect(seen).toHaveLength(0)
  await closed(params)
})

test.each([false, true])("Studio's native POST validates and completes only once, with a bounded success page (JSON: %s)", async (json) => {
  let began, approve
  const ready = new Promise((r) => (began = r))
  const approval = new Promise((r) => (approve = r))
  const seen = fake({ "/alpha/whoami": () => { began(); return approval } })
  const { flow, params, cancel } = await start()
  expect(flow.method).toBe("auto")
  const pending = flow.callback()
  expect(flow.callback()).toBe(pending)
  expect((await post(params, { state: "other-attempt", apiKey: "wrong-key" }, true)).status).toBe(403)
  expect(seen).toHaveLength(0)
  const accepted = post(params, { apiKey: "studio-key", userId: "studio-user" }, json)
  await ready
  const duplicate = await post(params, { apiKey: "another-key" }, true)
  expect(duplicate.status).toBe(400)
  expect(JSON.parse(duplicate.text).success).toBe(false)
  expect(seen.map((s) => s.path)).toEqual(["/alpha/whoami"])
  approve(Response.json({ user: { userName: "Ada" } }))
  const response = await accepted
  if (json) {
    expect(response.status).toBe(200)
    expect(JSON.parse(response.text).success).toBe(true)
  } else {
    expect(response.status).toBe(303)
    expect(new URL(response.headers.location, params.get("callback")).pathname).toBe("/callback/complete")
  }
  expect(await pending).toMatchObject({ type: "success", key: "studio-key", metadata: { email: "Ada", userId: "studio-user", plan: "Pro" } })
  expect(flow.callback()).toBe(pending)
  expect(seen.map((s) => s.path)).toEqual(["/alpha/whoami", "/alpha/billing/subscriptions"])
  expect((await request(new URL("/callback/complete", params.get("callback")))).status).toBe(200)
  expect([...timers.values()].map((t) => t.ms)).toEqual([10_000])
  if (json) cancel.abort()
  else expire(10_000)
  await closed(params)
  expect((await flow.callback()).type).toBe("success")
})

test("the browser's native cancel endpoint also releases its resources", async () => {
  const seen = fake()
  const { flow, params } = await start()
  expect((await request(new URL("/cancel", params.get("callback")))).status).toBe(204)
  expect((await flow.callback()).type).toBe("failed")
  expect(seen).toHaveLength(0)
  await closed(params)
})

test.each(["Studio refusal", "key refusal"])("%s releases the listener without a success-page timer", async (kind) => {
  const seen = fake({ "/alpha/whoami": new Response("refused", { status: 401 }) })
  const { flow, params } = await start()
  const response = await post(params, kind === "Studio refusal" ? { error: "access_denied" } : { apiKey: "refused-key" }, true)
  expect(response.status).toBe(400)
  expect((await flow.callback()).type).toBe("failed")
  expect(seen).toHaveLength(kind === "Studio refusal" ? 0 : 1)
  await closed(params)
})

test.each([
  ["/alpha/whoami", "authorize"], ["/alpha/whoami", "callback"], ["/alpha/whoami", "deadline"],
  ["/alpha/billing/subscriptions", "authorize"], ["/alpha/billing/subscriptions", "callback"], ["/alpha/billing/subscriptions", "deadline"],
])("cancellation of %s through %s aborts validation and cannot save a successful key", async (path, source) => {
  let began
  const ready = new Promise((r) => (began = r))
  const seen = fake({ [path]: (s) => { began(s.signal); return waitForAbort(s.signal) } })
  const { flow, params, cancel } = await start()
  const callbackCancel = controller()
  const pending = flow.callback(undefined, { signal: callbackCancel.signal })
  const posted = post(params).then((value) => ({ value }), (error) => ({ error }))
  const signal = await ready
  if (source === "authorize") cancel.abort()
  else if (source === "callback") callbackCancel.abort()
  else expire(600_000)
  expect((await pending).type).toBe("failed")
  await posted
  expect(signal.aborted).toBe(true)
  expect(seen.filter((s) => s.path === path)).toHaveLength(1)
  expect(_internal.subsSeen.size).toBe(0)
  await closed(params)
})

test("cancelling key validation's retry wait sends no second whoami request", async () => {
  let began
  const ready = new Promise((r) => (began = r))
  const seen = fake({ "/alpha/whoami": () => { began(); return new Response("retry", { status: 503 }) } })
  const { flow, params, cancel } = await start()
  const posted = post(params).catch(() => undefined)
  await ready
  await new Promise((r) => setImmediate(r))
  cancel.abort()
  expect((await flow.callback()).type).toBe("failed")
  await posted
  expect(seen).toHaveLength(1)
  await closed(params)
})

test("CLI completion reads its fixture once, reuses validation and leaves the file unchanged", async () => {
  const fixture = cliFixture()
  const seen = fake()
  const { flow } = await start(1)
  const pending = flow.callback()
  expect(flow.callback()).toBe(pending)
  expect(await pending).toMatchObject({ type: "success", key: "cli-key", metadata: { email: "Ada", userId: "cli-user", keyName: "CLI", plan: "Pro", cli: true } })
  expect(flow.callback()).toBe(pending)
  expect(seen.map((s) => s.path)).toEqual(["/alpha/whoami", "/alpha/billing/subscriptions"])
  expect(readFileSync(fixture.path, "utf8")).toBe(fixture.content)
  expect(servers).not.toHaveBeenCalled()
})

test("a pre-cancelled CLI callback makes no validation request", async () => {
  const fixture = cliFixture()
  const seen = fake()
  const { flow } = await start(1)
  const cancel = controller()
  cancel.abort()
  expect((await flow.callback(undefined, { signal: cancel.signal })).type).toBe("failed")
  expect(seen).toHaveLength(0)
  expect(readFileSync(fixture.path, "utf8")).toBe(fixture.content)
})

test.each(["authorize", "callback"])("CLI %s cancellation aborts validation without changing the fixture", async (source) => {
  const fixture = cliFixture()
  let began
  const ready = new Promise((r) => (began = r))
  const seen = fake({ "/alpha/whoami": (s) => { began(s.signal); return waitForAbort(s.signal) } })
  const { flow, cancel } = await start(1)
  const callbackCancel = controller()
  const pending = flow.callback(undefined, { signal: callbackCancel.signal })
  const signal = await ready
  if (source === "authorize") cancel.abort()
  else callbackCancel.abort()
  expect((await pending).type).toBe("failed")
  expect(signal.aborted).toBe(true)
  expect(seen).toHaveLength(1)
  expect(readFileSync(fixture.path, "utf8")).toBe(fixture.content)
})
