// CPA's independent native import retains its parser and CLI renewal owner.
// Sources are read, never changed or renewed; every target is temporary.
import { noRealGrok } from "./nocli.mjs"
import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { getEventListeners } from "node:events"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { GrokAuthPlugin } from "./index.mjs"

noRealGrok()
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const SCOPE = `https://auth.x.ai::${CLIENT_ID}`
const dir = mkdtempSync(join(tmpdir(), "grok-import-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const real = Object.fromEntries(["GROK_BIN_DIR", "GROK_HOME", "XDG_CONFIG_HOME", "HOME", "USERPROFILE", "PATH"].map((k) => [k, process.env[k]]))
afterEach(() => { for (const [k, v] of Object.entries(real)) v === undefined ? delete process.env[k] : (process.env[k] = v) })
const jwt = (claims) => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`
const token = (sub = "user-1", claims = {}) => jwt({ iss: "https://auth.x.ai", aud: [CLIENT_ID], sub, ...claims })
const goodToken = token()
const later = "2099-01-01T00:00:00Z"
const cpa = (over = {}) => ({
  type: "xai", auth_kind: "oauth", access_token: goodToken, refresh_token: "rt-1",
  expired: later, expires_in: 3600, last_refresh: "2026-11-01T01:02:03Z", disabled: false,
  email: "someone@example.com", sub: "user-1", token_type: "Bearer", ...over,
})
const account = (n) => cpa({ sub: `user-${n}`, email: `user-${n}@example.invalid`, access_token: token(`user-${n}`), refresh_token: `rt-${n}` })
function file(source) {
  const path = join(dir, `account-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(path, typeof source === "string" ? source : JSON.stringify(source))
  return path
}
function sandbox({ exe = true } = {}) {
  const bin = mkdtempSync(join(dir, "bin-"))
  if (exe) writeFileSync(join(bin, process.platform === "win32" ? "grok.exe" : "grok"), "not executable; never run")
  const home = mkdtempSync(join(dir, "home-"))
  const user = mkdtempSync(join(dir, "user-"))
  const config = mkdtempSync(join(dir, "config-"))
  Object.assign(process.env, { GROK_BIN_DIR: bin, GROK_HOME: home, HOME: user, USERPROFILE: user, PATH: "", XDG_CONFIG_HOME: config })
  return config
}
const hooks = async () => (await GrokAuthPlugin({})).auth
const authorize = async (path, options) => (await hooks()).methods[2].authorize({ path }, options)
const bulk = async (texts, options) => (await hooks()).import(texts, options)
const homes = (config) => existsSync(join(config, "opencode-grok-auth")) ? readdirSync(join(config, "opencode-grok-auth")) : []
const authFile = (r) => JSON.parse(readFileSync(join(r.refresh, "auth.json"), "utf8"))

test("a CPA path imports native credentials once without changing its source", async () => {
  const config = sandbox()
  const path = file(cpa())
  const before = readFileSync(path, "utf8")
  const flow = await authorize(path)
  const [r, again] = await Promise.all([flow.callback(), flow.callback()])
  expect(r).toEqual(again)
  expect(r.type).toBe("success")
  expect(r.accountId).toBe("someone@example.com")
  expect(dirname(r.refresh)).toBe(join(config, "opencode-grok-auth"))
  expect(authFile(r)).toEqual({ [SCOPE]: {
    key: goodToken, auth_mode: "oidc", create_time: "2026-11-01T01:02:03.000Z", user_id: "user-1", email: "someone@example.com",
    refresh_token: "rt-1", expires_at: "2099-01-01T00:00:00.000Z", oidc_issuer: "https://auth.x.ai", oidc_client_id: CLIENT_ID,
  } })
  if (process.platform !== "win32") expect(statSync(join(r.refresh, "auth.json")).mode & 0o777).toBe(0o600)
  expect(homes(config)).toHaveLength(1)
  expect(readFileSync(path, "utf8")).toBe(before)
})

test("invalid CPA sources fail before creating a home", async () => {
  const cases = [file("not JSON"), join(dir, "missing.json"),
    ...[{ type: "openai" }, { auth_kind: "api_key" }, { disabled: true }, { refresh_token: "" }, { sub: "" }, { email: "" },
      { expired: "yesterday" }, { expired: [later] }, { last_refresh: 1759936586 }, { client_id: "other-client" },
      { access_token: token("u", { iss: "https://other.example" }) }, { access_token: token("u", { aud: ["other"] }) }, { access_token: "opaque" }].map((over) => file(cpa(over)))]
  for (const path of cases) {
    const config = sandbox()
    await expect(authorize(path)).rejects.toThrow()
    expect(homes(config)).toEqual([])
  }
})

test("CPA keeps its installed-CLI refresh prerequisite and imports expired tokens without refreshing", async () => {
  let config = sandbox({ exe: false })
  await expect(authorize(file(cpa()))).rejects.toThrow()
  await expect(bulk(JSON.stringify(cpa()))).rejects.toThrow()
  expect(homes(config)).toEqual([])
  config = sandbox()
  const flow = await authorize(file(cpa({ expired: "2020-01-01T00:00:00Z" })))
  expect((await flow.callback()).expires).toBe(Date.parse("2020-01-01T00:00:00Z"))
  expect(homes(config)).toHaveLength(1)
})

test("multi-file CPA lists skip foreign accounts, report invalid credentials and deduplicate identities", async () => {
  const config = sandbox()
  const texts = [JSON.stringify([cpa({ type: "openai" }), cpa({ auth_kind: "api_key" }), cpa({ disabled: true }), cpa(), account(2)]), JSON.stringify(cpa())]
  const r = await bulk(texts)
  expect(r.map((a) => a.type)).toEqual(["failed", "success", "success"])
  expect(r.slice(1).map((a) => a.accountId)).toEqual(["someone@example.com", "user-2@example.invalid"])
  expect(homes(config)).toHaveLength(2)
  await expect(authorize(JSON.stringify([cpa(), account(2)]))).rejects.toThrow()
})

test("CPA retries reuse existing plugin and CLI homes without rewriting them", async () => {
  const config = sandbox()
  const [first] = await bulk(JSON.stringify(cpa()))
  const before = readFileSync(join(first.refresh, "auth.json"), "utf8")
  const [again] = await bulk(JSON.stringify(cpa({ refresh_token: "different-source" })))
  expect(again).toEqual(first)
  expect(readFileSync(join(first.refresh, "auth.json"), "utf8")).toBe(before)
  const cli = join(process.env.GROK_HOME, "auth.json")
  const cliText = JSON.stringify({ [SCOPE]: { key: token("cli-user"), user_id: "cli-user", email: "cli@example.invalid", expires_at: later } })
  writeFileSync(cli, cliText)
  const [current] = await bulk(JSON.stringify(cpa({ sub: "cli-user", email: "cli@example.invalid", access_token: token("cli-user"), refresh_token: "cli-rt" })))
  expect(current.refresh).toBe(process.env.GROK_HOME)
  expect(readFileSync(cli, "utf8")).toBe(cliText)
  expect(homes(config)).toHaveLength(1)
})

test("cancelled batches and callbacks allocate nothing and retain existing homes", async () => {
  const config = sandbox()
  const flow = await authorize(JSON.stringify(cpa()))
  const c = new AbortController()
  c.abort()
  await expect(bulk(JSON.stringify(cpa()), { signal: c.signal })).rejects.toThrow()
  await expect(authorize(JSON.stringify(cpa()), { signal: c.signal })).rejects.toThrow()
  await expect(flow.callback(undefined, { signal: c.signal })).rejects.toThrow()
  expect(homes(config)).toEqual([])
  expect(existsSync(process.env.GROK_HOME)).toBe(true)
})

test("cancelling a torn-file read releases listeners and preserves the CLI file", async () => {
  const config = sandbox()
  const path = join(process.env.GROK_HOME, "auth.json")
  writeFileSync(path, "")
  const c = new AbortController()
  const auth = await hooks()
  const pending = auth.import(JSON.stringify(cpa()), { signal: c.signal })
  c.abort()
  await expect(pending).rejects.toThrow()
  expect(getEventListeners(c.signal, "abort")).toHaveLength(0)
  expect(readFileSync(path, "utf8")).toBe("")
  expect(homes(config)).toEqual([])
})

test("authorize cancellation stops an unsaved import but cannot undo its committed result", async () => {
  const config = sandbox()
  const cancelled = new AbortController()
  const a = await authorize(JSON.stringify(cpa()), { signal: cancelled.signal })
  cancelled.abort()
  await expect(a.callback()).rejects.toThrow()
  expect(homes(config)).toEqual([])
  const completed = new AbortController()
  const b = await authorize(JSON.stringify(cpa()), { signal: completed.signal })
  const result = await b.callback()
  completed.abort()
  expect(await b.callback(undefined, { signal: completed.signal })).toEqual(result)
  expect(homes(config)).toHaveLength(1)
})

test("batch cancellation after writes rolls back unsaved homes but keeps existing accounts; retry succeeds", async () => {
  const config = sandbox()
  const [existing] = await bulk(JSON.stringify(cpa()))
  const before = readFileSync(join(existing.refresh, "auth.json"), "utf8")
  const c = new AbortController()
  const original = fs.writeFileSync
  let writes = 0
  const write = spyOn(fs, "writeFileSync").mockImplementation((...args) => {
    const r = original(...args)
    if (String(args[0]).endsWith("auth.json") && ++writes === 2) queueMicrotask(() => c.abort())
    return r
  })
  try {
    await expect(bulk(JSON.stringify([cpa(), account(2), account(3), account(4)]), { signal: c.signal })).rejects.toThrow()
    expect(writes).toBe(2)
  } finally { write.mockRestore() }
  expect(homes(config)).toEqual([existing.refresh.split(/[\\/]/).at(-1)])
  expect(readFileSync(join(existing.refresh, "auth.json"), "utf8")).toBe(before)
  expect((await bulk(JSON.stringify(account(2))))[0].type).toBe("success")
  expect(homes(config)).toHaveLength(2)
})

test("write and directory creation failures leave no new home or changed existing path", async () => {
  const config = sandbox()
  const original = fs.writeFileSync
  const write = spyOn(fs, "writeFileSync").mockImplementation((...args) => {
    if (String(args[0]).endsWith("auth.json")) throw new Error("test disk failure")
    return original(...args)
  })
  try {
    expect((await bulk(JSON.stringify(cpa()))).map((a) => a.type)).toEqual(["failed"])
    expect(homes(config)).toEqual([])
  } finally { write.mockRestore() }
  expect((await bulk(JSON.stringify(cpa())))[0].type).toBe("success")
  const another = sandbox()
  writeFileSync(join(another, "opencode-grok-auth"), "existing file")
  const flow = await authorize(file(cpa()))
  await expect(flow.callback()).rejects.toThrow()
  expect(readFileSync(join(another, "opencode-grok-auth"), "utf8")).toBe("existing file")
})

test("representative bulk import creates one home per identity with no extra homes on retry", async () => {
  const config = sandbox()
  const accounts = Array.from({ length: 50 }, (_, n) => account(n + 1))
  const texts = Array.from({ length: 4 }, () => JSON.stringify(accounts))
  const r = await bulk(texts)
  expect(r).toHaveLength(50)
  expect(r.every((a) => a.type === "success")).toBe(true)
  expect(homes(config)).toHaveLength(50)
  expect(await bulk(texts)).toEqual(r)
  expect(homes(config)).toHaveLength(50)
})
