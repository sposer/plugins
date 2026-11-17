// Production OAuth adapter -> native account home -> signed request/refresh.
// Every credential is synthetic, every filesystem target is temporary, and
// an unexpected network request or child process fails the test.
import { noRealGrok } from "./nocli.mjs"
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import * as childProcess from "node:child_process"
import { getEventListeners } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

noRealGrok()
let spawned = 0
const realSpawn = childProcess.spawn
mock.module("node:child_process", () => ({ ...childProcess, spawn: (...args) => {
  if (String(args[1]?.[0]) === "login") { spawned++; throw new Error("No CLI login may run") }
  return realSpawn(...args)
} }))
const { GrokAuthPlugin } = await import("./index.mjs")
const CLIENT = "b1a00492-073a-47ea-816f-4c329264a828"
const ISSUER = "https://auth.x.ai"
const TOKEN = `${ISSUER}/oauth2/token`
const USER = "https://cli-chat-proxy.grok.com/v1/user"
const CHAT = "https://cli-chat-proxy.grok.com/v1/responses"
const root = mkdtempSync(join(tmpdir(), "grok-oauth-"))
const environment = { ...process.env }
const realFetch = globalThis.fetch
let home, config, auth, requests, respond, deadline, clearDeadline, timers
const jwt = (claims) => `${Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`
const tokens = (over = {}) => ({ access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 3600, ...over })
const homes = () => existsSync(join(config, "opencode-grok-auth")) ? readdirSync(join(config, "opencode-grok-auth")) : []
const native = (r) => JSON.parse(readFileSync(join(r.refresh, "auth.json"), "utf8"))
const method = (index, inputs, options) => auth.methods[index].authorize(inputs, options)
const callback = (flow, over = {}) => { const u = new URL(flow.url); const dest = new URL(u.searchParams.get("redirect_uri")); dest.search = new URLSearchParams({ code: "code-1", state: u.searchParams.get("state"), ...over }); return dest.href }
const listenersGone = (signal) => expect(getEventListeners(signal, "abort")).toHaveLength(0)

beforeEach(async () => {
  home = mkdtempSync(join(root, "cli-"))
  config = mkdtempSync(join(root, "config-"))
  const user = mkdtempSync(join(root, "user-"))
  Object.assign(process.env, { HOME: user, USERPROFILE: user, GROK_HOME: home, GROK_BIN_DIR: join(root, "no-bin"), PATH: "", XDG_CONFIG_HOME: config })
  delete process.env.GROK_AUTH_PATH
  spawned = 0
  requests = []
  timers = new Map()
  const set = globalThis.setTimeout
  const clear = globalThis.clearTimeout
  deadline = spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) => {
    if (![600_000, 60_000, 30_000].includes(ms)) return set(fn, ms, ...args)
    const timer = set(fn, ms, ...args)
    timers.set(timer, () => fn(...args))
    return timer
  })
  clearDeadline = spyOn(globalThis, "clearTimeout").mockImplementation((timer) => { timers.delete(timer); clear(timer) })
  respond = async (url) => {
    if (url === USER) return Response.json({ userId: "user-1", email: "one@example.invalid" })
    if (url === TOKEN) return Response.json(tokens())
    if (url === CHAT) return Response.json({ output: [] })
    throw new Error(`Unexpected URL ${url}`)
  }
  globalThis.fetch = async (url, init = {}) => {
    init.signal?.throwIfAborted()
    const record = { url: String(url), params: new URLSearchParams(init.body instanceof URLSearchParams ? init.body : ""), headers: new Headers(init.headers), signal: init.signal }
    requests.push(record)
    return respond(String(url), init, record)
  }
  auth = (await GrokAuthPlugin({})).auth
})
afterEach(() => {
  const pending = timers.size
  for (const timer of timers.keys()) clearTimeout(timer)
  deadline.mockRestore()
  clearDeadline.mockRestore()
  globalThis.fetch = realFetch
  for (const k of Object.keys(process.env)) if (!(k in environment)) delete process.env[k]
  Object.assign(process.env, environment)
  expect(pending).toBe(0)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

function codeResponder(flow, over = {}) {
  const url = new URL(flow.url)
  respond = async (target) => target === TOKEN ? Response.json(tokens({ id_token: jwt({ iss: ISSUER, aud: url.searchParams.get("client_id"), sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), nonce: url.searchParams.get("nonce") }), ...over })) : target === USER ? Response.json({ userId: "user-1" }) : target === CHAT ? Response.json({ output: [] }) : Promise.reject(new Error(target))
}

test("authorization-code tracer saves native credentials and consumes them through the signed production request", async () => {
  expect(auth.methods[3].prompts.find((p) => p.key === "client_secret").type).toBe("password")
  const c = new AbortController()
  const flow = await method(3, { client_id: "configured-client", client_secret: "synthetic-secret", auth_method: "client_secret_basic", redirect_uri: "https://callback.example.invalid/grok", scope: "openid offline_access grok-cli:access" }, { signal: c.signal })
  expect(requests).toEqual([])
  expect(flow.method).toBe("code")
  const url = new URL(flow.url)
  expect(url.origin + url.pathname).toBe(`${ISSUER}/oauth2/authorize`)
  expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  codeResponder(flow)
  const [r, again] = await Promise.all([flow.callback(callback(flow)), flow.callback(callback(flow))])
  expect(r).toEqual(again)
  expect(r.type).toBe("success")
  expect(r.accountId).toBe("user-1")
  const stored = native(r)[`${ISSUER}::configured-client`]
  expect(stored.oidc_client_id).toBe("configured-client")
  expect(stored.refresh_token).toBe("refresh-1")
  expect(stored.magpie_oauth.auth_method).toBe("client_secret_basic")
  expect(Bun.TOML.parse(readFileSync(join(r.refresh, "config.toml"), "utf8")).grok_com_config.oauth2.client_id).toBe("configured-client")
  const grant = requests.find((r) => r.url === TOKEN)
  expect(grant.params.get("grant_type")).toBe("authorization_code")
  const basic = Buffer.from(grant.headers.get("authorization").split(" ")[1], "base64").toString().split(":").map(decodeURIComponent)
  expect(basic).toEqual(["configured-client", "synthetic-secret"])
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(grant.params.get("code_verifier")))).toString("base64url")
  expect(challenge).toBe(url.searchParams.get("code_challenge"))
  const opts = await auth.loader(async () => ({ ...r, type: "oauth" }))
  expect((await opts.fetch(CHAT, { method: "POST", body: '{"model":"grok-4.7","input":"hello"}' })).status).toBe(200)
  expect(requests.at(-1).headers.get("authorization")).toBe("Bearer access-1")
  expect(requests.at(-1).headers.get("x-xai-token-auth")).toBe("xai-grok-cli")
  c.abort()
  expect(await flow.callback("ignored", { signal: c.signal })).toEqual(r)
  listenersGone(c.signal)
  expect(homes()).toHaveLength(1)
  expect(spawned).toBe(0)
})

test("a bare authorization code is bound to its PKCE attempt", async () => {
  const flow = await method(3)
  codeResponder(flow)
  expect((await flow.callback("bare-code")).type).toBe("success")
  expect(requests.find((r) => r.url === TOKEN).params.get("code")).toBe("bare-code")
})

test("an OAuth-only configured scope does not require an OIDC ID token", async () => {
  const flow = await method(3, { scope: "offline_access grok-cli:access api:access" })
  expect(new URL(flow.url).searchParams.has("nonce")).toBe(false)
  codeResponder(flow, { id_token: undefined })
  expect((await flow.callback(callback(flow))).type).toBe("success")
})

test("wrong state, wrong redirect and upstream code failures create no account; a new attempt retries", async () => {
  for (const kind of ["state", "redirect", "upstream"]) {
    const flow = await method(3)
    codeResponder(flow)
    let input = callback(flow, kind === "state" ? { state: "foreign-state" } : {})
    if (kind === "redirect") input = input.replace("/callback", "/elsewhere")
    if (kind === "upstream") respond = async () => Response.json({ error: "invalid_grant" }, { status: 400 })
    const r = await flow.callback(input)
    expect(r.type).toBe("failed")
    expect(await flow.callback(callback(flow))).toEqual(r)
    expect(homes()).toEqual([])
  }
  const retry = await method(3)
  codeResponder(retry)
  expect((await retry.callback(callback(retry))).type).toBe("success")
  expect(spawned).toBe(0)
})

test("refresh-token fields validate, preserve rotation, and refresh concurrently with real request consumption", async () => {
  for (const key of ["client_secret", "refresh_token", "access_token"]) expect(auth.methods[4].prompts.find((p) => p.key === key).type).toBe("password")
  const flow = await method(4, { client_id: "custom", client_secret: "test-secret", refresh_token: "refresh-0", access_token: "ignored" })
  const r = await flow.callback()
  expect(r.type).toBe("success")
  expect(requests[0].params.get("refresh_token")).toBe("refresh-0")
  expect(requests[0].params.get("client_secret")).toBe("test-secret")
  expect(native(r)[`${ISSUER}::custom`].refresh_token).toBe("refresh-1")
  const all = native(r)
  all[`${ISSUER}::custom`].expires_at = new Date(Date.now() + 1000).toISOString()
  writeFileSync(join(r.refresh, "auth.json"), JSON.stringify(all))
  requests = []
  respond = async (url) => url === TOKEN ? Response.json(tokens({ access_token: "access-2", refresh_token: "refresh-2" })) : url === CHAT ? Response.json({ output: [] }) : Promise.reject(new Error(url))
  const account = { ...r, type: "oauth", expires: Date.now() + 1000 }
  const opts = await auth.loader(async () => account)
  const [renewed, sent] = await Promise.all([auth.refresh(account), opts.fetch(CHAT, { method: "POST", body: '{"model":"grok-4.7"}' })])
  expect(renewed.access).toBe("access-2")
  expect(sent.status).toBe(200)
  expect(requests.filter((r) => r.url === TOKEN)).toHaveLength(1)
  expect(requests[0].params.get("client_id")).toBe("custom")
  expect(requests[0].params.get("refresh_token")).toBe("refresh-1")
  expect(native(r)[`${ISSUER}::custom`].refresh_token).toBe("refresh-2")
  expect(requests.at(-1).headers.get("authorization")).toBe("Bearer access-2")
  expect(spawned).toBe(0)
})

test("new OAuth logins leave native and CPA credentials unchanged, then update only their own saved home", async () => {
  const scope = `${ISSUER}::${CLIENT}`
  const legacy = JSON.stringify({ [scope]: { key: "legacy-access", user_id: "user-1", email: "one@example.invalid", refresh_token: "legacy-refresh", expires_at: "2099-01-01T00:00:00Z", oidc_issuer: ISSUER, oidc_client_id: CLIENT } })
  const cpaHome = join(config, "opencode-grok-auth", "cpa-existing")
  mkdirSync(cpaHome, { recursive: true })
  for (const path of [home, cpaHome]) {
    writeFileSync(join(path, "auth.json"), legacy)
    writeFileSync(join(path, "config.toml"), "# existing config\n")
  }
  const first = await (await method(4, { refresh_token: "fresh-login" })).callback()
  expect(first.type).toBe("success")
  expect(first.refresh).not.toBe(home)
  expect(first.refresh).not.toBe(cpaHome)
  const next = await method(3, { client_id: "another-configured-client" })
  codeResponder(next, { refresh_token: "refresh-next" })
  const second = await next.callback(callback(next))
  expect(second.type).toBe("success")
  expect(second.refresh).toBe(first.refresh)
  expect(native(second)[`${ISSUER}::another-configured-client`].refresh_token).toBe("refresh-next")
  expect(homes()).toHaveLength(2)
  for (const path of [home, cpaHome]) {
    expect(readFileSync(join(path, "auth.json"), "utf8")).toBe(legacy)
    expect(readFileSync(join(path, "config.toml"), "utf8")).toBe("# existing config\n")
  }
  expect(spawned).toBe(0)
})

test("cancellation after a saved account's refresh rotation retains its successor and retries in the same home", async () => {
  const first = await (await method(4, { refresh_token: "refresh-0" })).callback()
  const c = new AbortController()
  const flow = await method(4, { refresh_token: "refresh-1" }, { signal: c.signal })
  respond = async (url) => {
    expect(url).toBe(TOKEN)
    c.abort()
    return Response.json(tokens({ access_token: "access-2", refresh_token: "refresh-2" }))
  }
  expect((await flow.callback()).type).toBe("failed")
  expect(native(first)[`${ISSUER}::${CLIENT}`].refresh_token).toBe("refresh-2")
  listenersGone(c.signal)
  respond = async (url) => {
    expect(url).toBe(TOKEN)
    return Response.json(tokens({ refresh_token: "refresh-3" }))
  }
  const retry = await (await method(4, { refresh_token: "refresh-2" })).callback()
  expect(retry.type).toBe("success")
  expect(retry.refresh).toBe(first.refresh)
  expect(native(retry)[`${ISSUER}::${CLIENT}`].refresh_token).toBe("refresh-3")
  expect(homes()).toHaveLength(1)
})

test("failed renewal preserves the saved credential and releases its flight so a retry can succeed", async () => {
  const first = await (await method(4, { refresh_token: "refresh-0" })).callback()
  const account = { ...first, type: "oauth" }
  const before = readFileSync(join(first.refresh, "auth.json"), "utf8")
  respond = async (url) => {
    expect(url).toBe(TOKEN)
    return Response.json({ error: "temporarily_unavailable" }, { status: 503 })
  }
  await expect(auth.refresh(account)).rejects.toThrow()
  expect(readFileSync(join(first.refresh, "auth.json"), "utf8")).toBe(before)
  respond = async (url) => {
    expect(url).toBe(TOKEN)
    return Response.json(tokens({ access_token: "access-retry", refresh_token: "refresh-retry" }))
  }
  expect((await auth.refresh(account)).access).toBe("access-retry")
  expect(native(first)[`${ISSUER}::${CLIENT}`].refresh_token).toBe("refresh-retry")
  expect(requests.filter((r) => r.params.get("refresh_token") === "refresh-1")).toHaveLength(2)
  expect(homes()).toHaveLength(1)
})

test("abandoned code and expired device attempts release their deadlines and signal listeners", async () => {
  for (const kind of [3, 0]) {
    respond = async (url) => url === `${ISSUER}/oauth2/device/code` ? Response.json({ device_code: "expired-device", user_code: "ABCD", verification_uri: "https://accounts.x.ai/device", expires_in: 60, interval: 1 }) : Promise.reject(new Error(url))
    const c = new AbortController()
    const flow = await method(kind, {}, { signal: c.signal })
    expect(timers.size).toBe(1)
    timers.values().next().value()
    expect(timers.size).toBe(0)
    listenersGone(c.signal)
    expect((await flow.callback(kind === 3 ? callback(flow) : undefined)).type).toBe("failed")
    expect(homes()).toEqual([])
  }
  expect(requests.map((r) => r.url)).toEqual([`${ISSUER}/oauth2/device/code`])
})

test("access-only fields validate against Grok, keep no invented refresh token, and report renewal needs at expiry", async () => {
  const flow = await method(4, { access_token: "existing-access", expires_at: "2099-01-01T00:00:00Z" })
  const r = await flow.callback()
  expect(r.type).toBe("success")
  expect(requests.map((r) => r.url)).toEqual([USER])
  const scope = `${ISSUER}::${CLIENT}`
  expect(native(r)[scope].refresh_token).toBeUndefined()
  expect(await auth.refresh({ ...r, type: "oauth" })).toBeUndefined()
  const all = native(r)
  all[scope].expires_at = "2020-01-01T00:00:00Z"
  writeFileSync(join(r.refresh, "auth.json"), JSON.stringify(all))
  const opts = await auth.loader(async () => ({ ...r, type: "oauth" }))
  await expect(opts.fetch(CHAT, { method: "POST", body: "{}" })).rejects.toThrow()
  expect(requests.map((r) => r.url)).toEqual([USER])
})

test("invalid account fields and failed token or account validation leave no home", async () => {
  for (const inputs of [{}, { access_token: "x" }, { access_token: "x", expires_in: "-1" }, { access_token: "x", expires_in: "3600", token_type: "other" }]) {
    const flow = await method(4, inputs)
    expect((await flow.callback()).type).toBe("failed")
  }
  for (const status of [401, 500]) {
    respond = async () => Response.json({ error: "invalid_grant" }, { status })
    expect((await (await method(4, { refresh_token: "bad" })).callback()).type).toBe("failed")
    expect((await (await method(4, { access_token: "bad", expires_in: "3600" })).callback()).type).toBe("failed")
  }
  await expect(method(3, { client_secret: "x", auth_method: "none" })).rejects.toThrow()
  await expect(method(3, { auth_method: "client_secret_post" })).rejects.toThrow()
  expect(homes()).toEqual([])
})

test("cancel before authorization, before callback and during HTTP releases listeners and retries without residual homes", async () => {
  const pre = new AbortController()
  pre.abort()
  await expect(method(3, {}, { signal: pre.signal })).rejects.toThrow()
  await expect(method(4, {}, { signal: pre.signal })).rejects.toThrow()
  await expect(method(0, {}, { signal: pre.signal })).rejects.toThrow()
  expect(requests).toEqual([])
  const c = new AbortController()
  const cancelled = await method(3, {}, { signal: c.signal })
  c.abort()
  expect((await cancelled.callback(callback(cancelled))).type).toBe("failed")
  listenersGone(c.signal)
  const during = new AbortController()
  const flow = await method(4, { refresh_token: "cancelled" }, { signal: during.signal })
  let started
  const entered = new Promise((ok) => { started = ok })
  respond = (_url, init) => new Promise((_ok, fail) => {
    init.signal.addEventListener("abort", () => fail(init.signal.reason), { once: true })
    started()
  })
  const pending = flow.callback()
  await entered
  during.abort()
  expect((await pending).type).toBe("failed")
  listenersGone(during.signal)
  expect(homes()).toEqual([])
  const retry = await method(3)
  codeResponder(retry)
  expect((await retry.callback(callback(retry))).type).toBe("success")
})

test("device login requests the real protocol without spawning or opening a browser; cancellation stops the wait", async () => {
  respond = async (url) => url === `${ISSUER}/oauth2/device/code` ? Response.json({ device_code: "device-1", user_code: "ABCD-EFGH", verification_uri: "https://accounts.x.ai/device", verification_uri_complete: "https://accounts.x.ai/device?user_code=ABCD-EFGH", expires_in: 60, interval: 1 }) : Promise.reject(new Error(url))
  const c = new AbortController()
  const flow = await method(0, {}, { signal: c.signal })
  expect(flow.url).toBe("https://accounts.x.ai/device?user_code=ABCD-EFGH")
  expect(requests[0].params.get("client_id")).toBe(CLIENT)
  expect(requests[0].params.get("scope").split(" ")).toContain("grok-cli:access")
  const pending = flow.callback()
  c.abort()
  expect((await pending).type).toBe("failed")
  expect(homes()).toEqual([])
  expect(spawned).toBe(0)
  listenersGone(c.signal)
})

test("device approval uses the shared token/account writer and leaves only its saved home", async () => {
  respond = async (url) => url === `${ISSUER}/oauth2/device/code` ? Response.json({ device_code: "device-1", user_code: "ABCD-EFGH", verification_uri: "https://accounts.x.ai/device", expires_in: 60, interval: 1 }) : url === TOKEN ? Response.json(tokens()) : url === USER ? Response.json({ userId: "device-user" }) : Promise.reject(new Error(url))
  const flow = await method(0)
  const r = await flow.callback()
  expect(r.type).toBe("success")
  expect(r.accountId).toBe("device-user")
  expect(requests.find((r) => r.url === TOKEN).params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code")
  expect(homes()).toHaveLength(1)
  expect(await flow.callback()).toEqual(r)
  expect(spawned).toBe(0)
})
