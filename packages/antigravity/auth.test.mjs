import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import http from "node:http"
import { AntigravityAuthPlugin } from "./index.mjs"
import { fake, real, reset } from "./fake.mjs"

const setTimer = globalThis.setTimeout
const clearTimer = globalThis.clearTimeout
let deadlines, controllers, servers, setSpy, clearSpy

beforeEach(() => {
  reset()
  deadlines = new Map()
  controllers = []
  servers = spyOn(http, "createServer")
  setSpy = spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) => {
    const timer = setTimer(fn, ms, ...args)
    if (ms === 10 * 60 * 1000) deadlines.set(timer, () => fn(...args))
    return timer
  })
  clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
    deadlines.delete(timer)
    clearTimer(timer)
  })
})
afterEach(() => {
  for (const controller of controllers) controller.abort()
  for (const timer of deadlines.keys()) clearTimer(timer)
  servers.mockRestore()
  setSpy.mockRestore()
  clearSpy.mockRestore()
  globalThis.fetch = real
})

async function start(method = 0) {
  const controller = new AbortController()
  controllers.push(controller)
  const plugin = await AntigravityAuthPlugin({})
  const flow = await plugin.auth.methods[method].authorize({}, { signal: controller.signal })
  return { flow, controller, params: new URL(flow.url).searchParams }
}

function callbackURL(params, fields = { code: "google-code" }) {
  const url = new URL(params.get("redirect_uri"))
  url.searchParams.set("state", params.get("state"))
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value)
  return url.href
}

function request(url, host = "127.0.0.1") {
  const target = new URL(url)
  target.hostname = host
  return new Promise((resolve, reject) => {
    const req = http.get(target, { agent: false }, (res) => {
      res.resume()
      res.once("end", () => resolve(res.statusCode))
    })
    req.once("error", reject)
    req.setTimeout(1000, () => req.destroy(new Error("loopback request timed out")))
  })
}

async function closed(params) {
  for (const host of ["127.0.0.1", "[::1]"]) await expect(request(params.get("redirect_uri"), host)).rejects.toMatchObject({ code: "ECONNREFUSED" })
  expect(deadlines.size).toBe(0)
}

function google(replies = {}) {
  return fake({ token: { access_token: "signed-access", refresh_token: "signed-refresh", expires_in: 3600 }, who: { email: "signed@example.com" }, ...replies })
}

function aborted(signal) {
  return new Promise((_, reject) => {
    signal.throwIfAborted()
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

test("browser sign-in validates state and exchanges its code once with the original redirect and PKCE", async () => {
  const seen = google()
  const { flow, params } = await start()
  expect(flow.method).toBe("auto")
  expect(deadlines.size).toBe(1)
  const pending = flow.callback()
  expect(await request(callbackURL(params, { state: "another-attempt", code: "wrong-code" }))).toBe(400)
  expect(seen).toHaveLength(0)
  expect(await request(callbackURL(params))).toBe(200)
  const again = flow.callback()
  expect(again).toBe(pending)
  expect(await pending).toMatchObject({ type: "success", access: "signed-access", refresh: "signed-refresh|ag-proj", accountId: "signed@example.com" })
  expect(await flow.callback()).toEqual(await pending)
  const exchanges = seen.filter((s) => s.name === "token")
  expect(exchanges).toHaveLength(1)
  const form = new URLSearchParams(exchanges[0].body)
  expect(form.get("grant_type")).toBe("authorization_code")
  expect(form.get("code")).toBe("google-code")
  expect(form.get("client_id")).toBe(params.get("client_id"))
  expect(form.get("redirect_uri")).toBe(params.get("redirect_uri"))
  expect(params.get("code_challenge_method")).toBe("S256")
  expect(crypto.createHash("sha256").update(form.get("code_verifier")).digest("base64url")).toBe(params.get("code_challenge"))
  await closed(params)
})

test.each(["URL", "code"])("manual sign-in accepts a pasted %s without a listener", async (kind) => {
  const seen = google()
  const { flow, params } = await start(2)
  expect(flow.method).toBe("code")
  expect(new URL(params.get("redirect_uri")).hostname).toBe("localhost")
  expect(servers).not.toHaveBeenCalled()
  const pending = flow.callback(kind === "URL" ? callbackURL(params, { code: "4/example+code" }) : "  4/example+code  ")
  expect(flow.callback("another-code")).toBe(pending)
  expect(await pending).toMatchObject({ type: "success", refresh: "signed-refresh|ag-proj", accountId: "signed@example.com" })
  const exchanges = seen.filter((s) => s.name === "token")
  expect(exchanges).toHaveLength(1)
  expect(new URLSearchParams(exchanges[0].body).get("code")).toBe("4/example+code")
  expect(new URLSearchParams(exchanges[0].body).get("redirect_uri")).toBe(params.get("redirect_uri"))
  expect(deadlines.size).toBe(0)
})

test.each(["wrong state", "missing state", "wrong redirect", "Google refusal", "empty"])("manual sign-in rejects %s before token exchange", async (kind) => {
  const seen = google()
  const { flow, params } = await start(2)
  let input = callbackURL(params)
  if (kind === "wrong state") input = callbackURL(params, { code: "google-code", state: "another-attempt" })
  if (kind === "missing state") { const url = new URL(input); url.searchParams.delete("state"); input = url.href }
  if (kind === "wrong redirect") { const url = new URL(input); url.pathname = "/other"; input = url.href }
  if (kind === "Google refusal") input = callbackURL(params, { error: "access_denied", error_description: "Consent declined" })
  if (kind === "empty") input = " "
  expect((await flow.callback(input)).type).toBe("failed")
  expect(seen).toHaveLength(0)
  expect(deadlines.size).toBe(0)
})

test("Google refusal on the browser callback releases the listeners without an exchange", async () => {
  const seen = google()
  const { flow, params } = await start()
  expect(await request(callbackURL(params, { error: "access_denied" }))).toBe(200)
  expect((await flow.callback()).type).toBe("failed")
  expect(seen).toHaveLength(0)
  await closed(params)
})

test("pre-cancelled authorize starts no listener, deadline or request for any method", async () => {
  const seen = google()
  const plugin = await AntigravityAuthPlugin({})
  const controller = new AbortController()
  controller.abort()
  for (const method of plugin.auth.methods) expect((await method.authorize({ account: "refresh-import" }, { signal: controller.signal })).type).toBe("failed")
  expect(servers).not.toHaveBeenCalled()
  expect(deadlines.size).toBe(0)
  expect(seen).toHaveLength(0)
})

test.each([0, 2])("a pre-cancelled callback for method %i sends no request", async (method) => {
  const seen = google()
  const { flow, params } = await start(method)
  const controller = new AbortController()
  controller.abort()
  expect((await flow.callback("google-code", { signal: controller.signal })).type).toBe("failed")
  expect(seen).toHaveLength(0)
  if (method === 0) await closed(params)
  else expect(deadlines.size).toBe(0)
})

test("cancelling authorize releases browser resources even when callback was never called", async () => {
  const seen = google()
  const { flow, params, controller } = await start()
  controller.abort()
  await closed(params)
  expect((await flow.callback()).type).toBe("failed")
  expect(seen).toHaveLength(0)
})

test("a callback signal cancels the browser wait", async () => {
  const seen = google()
  const { flow, params } = await start()
  const controller = new AbortController()
  const pending = flow.callback(undefined, { signal: controller.signal })
  controller.abort()
  expect((await pending).type).toBe("failed")
  expect(seen).toHaveLength(0)
  await closed(params)
})

test.each([0, 2])("sign-in method %i expires without requiring a callback", async (method) => {
  const seen = google()
  const { flow, params } = await start(method)
  expect(deadlines.size).toBe(1)
  for (const expire of [...deadlines.values()]) expire()
  if (method === 0) await closed(params)
  else expect(deadlines.size).toBe(0)
  expect((await flow.callback("late-code")).type).toBe("failed")
  expect(seen).toHaveLength(0)
})

test.each(["authorize", "callback", "deadline"])("%s cancellation reaches an in-flight token exchange", async (source) => {
  let began
  const ready = new Promise((r) => (began = r))
  const seen = google({ token: (s) => { began(s.signal); return aborted(s.signal) } })
  const { flow, controller } = await start(2)
  const callbackController = new AbortController()
  const pending = flow.callback("google-code", { signal: callbackController.signal })
  const signal = await ready
  if (source === "authorize") controller.abort()
  else if (source === "callback") callbackController.abort()
  else for (const expire of [...deadlines.values()]) expire()
  expect((await pending).type).toBe("failed")
  expect(signal.aborted).toBe(true)
  expect((await flow.callback("another-code")).type).toBe("failed")
  expect(seen.map((s) => s.name)).toEqual(["token"])
  expect(deadlines.size).toBe(0)
})

test.each(["who", "loadCodeAssist"])("cancellation also reaches sign-in's %s request without becoming success", async (name) => {
  let began
  const ready = new Promise((r) => (began = r))
  google({ [name]: (s) => { began(s.signal); return aborted(s.signal) } })
  const { flow, controller } = await start(2)
  const pending = flow.callback("google-code")
  const signal = await ready
  controller.abort()
  expect((await pending).type).toBe("failed")
  expect(signal.aborted).toBe(true)
  expect(deadlines.size).toBe(0)
})

test.each(["HTTP failure", "missing tokens"])("browser token %s releases resources and is not exchanged again", async (kind) => {
  const seen = google({ token: kind === "HTTP failure" ? new Response('{"error":"invalid_grant"}', { status: 400 }) : { access_token: "access-only" } })
  const { flow, params } = await start()
  expect(await request(callbackURL(params))).toBe(200)
  expect((await flow.callback()).type).toBe("failed")
  expect((await flow.callback()).type).toBe("failed")
  expect(seen.filter((s) => s.name === "token")).toHaveLength(1)
  await closed(params)
})

async function importAccount(account) {
  const plugin = await AntigravityAuthPlugin({})
  const flow = await plugin.auth.methods[1].authorize({ account: typeof account === "string" ? account : JSON.stringify(account) })
  return flow.type === "failed" ? flow : flow.callback()
}

test.each([
  [{ email: "first@example.com", token: { refresh_token: "first-refresh", project_id: "p1" } }, "p1"],
  [{ accounts: [{ email: "first@example.com", refreshToken: "first-refresh" }, { refresh_token: "second-refresh", projectId: "p2" }] }, "ag-proj"],
  [[{ refresh_token: "first-refresh" }, { refresh_token: "second-refresh" }], "ag-proj"],
  ["# mine\nfirst-refresh\n\nsecond-refresh\n", "ag-proj"],
])("legacy import still signs in its first account: %j", async (account, project) => {
  const seen = google()
  const result = await importAccount(account)
  expect(result).toMatchObject({ type: "success", access: "signed-access", refresh: `first-refresh|${project}` })
  expect(new URLSearchParams(seen.find((s) => s.name === "token").body).get("refresh_token")).toBe("first-refresh")
})

test.each(["authorize", "callback"])("import %s cancellation aborts its single refresh exchange", async (source) => {
  let began
  const ready = new Promise((r) => (began = r))
  const seen = google({ token: (s) => { began(s.signal); return aborted(s.signal) } })
  const plugin = await AntigravityAuthPlugin({})
  const controller = new AbortController()
  controllers.push(controller)
  const callbackController = new AbortController()
  const flow = await plugin.auth.methods[1].authorize({ account: "import-refresh" }, { signal: controller.signal })
  const pending = flow.callback(undefined, { signal: callbackController.signal })
  expect(flow.callback()).toBe(pending)
  const signal = await ready
  if (source === "authorize") controller.abort()
  else callbackController.abort()
  expect((await pending).type).toBe("failed")
  expect(signal.aborted).toBe(true)
  expect(seen.map((s) => s.name)).toEqual(["token"])
  expect(deadlines.size).toBe(0)
})

test.each([
  { type: "kiro", refresh_token: "not-antigravity" },
  "",
])("an inapplicable import fails without contacting Google: %j", async (account) => {
  const seen = google()
  expect((await importAccount(account)).type).toBe("failed")
  expect(seen).toHaveLength(0)
})
