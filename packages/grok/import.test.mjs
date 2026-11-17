// CPA and explicit sub2api Grok OAuth accounts share the import parser and
// Grok Build auth.json writer. Sources are read, never changed or renewed.
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
afterEach(() => {
  for (const [k, v] of Object.entries(real)) v === undefined ? delete process.env[k] : (process.env[k] = v)
})

function jwt(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${part({ alg: "none" })}.${part(claims)}.sig`
}
const token = (sub = "user-1", claims = {}) => jwt({ iss: "https://auth.x.ai", aud: [CLIENT_ID], sub, ...claims })
const goodToken = token()
const later = "2099-01-01T00:00:00Z"
function cpa(over = {}) {
  return {
    type: "xai", auth_kind: "oauth", access_token: goodToken, refresh_token: "rt-1",
    expired: later, expires_in: 3600, last_refresh: "2026-11-01T01:02:03Z", disabled: false,
    email: "someone@example.com", sub: "user-1", token_type: "Bearer", base_url: "https://cli-chat-proxy.grok.com/v1", ...over,
  }
}
function sub2api(over = {}) {
  return {
    name: "Grok account", platform: "grok", type: "oauth",
    credentials: { access_token: goodToken, refresh_token: "rt-1", expires_at: later, client_id: CLIENT_ID, scope: "openid offline_access grok-cli:access", sub: "user-1", ...over },
  }
}
function file(source) {
  const path = join(dir, `account-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(path, typeof source === "string" ? source : JSON.stringify(source))
  return path
}
function sandbox({ exe = true } = {}) {
  const bin = mkdtempSync(join(dir, "bin-"))
  // Import discovers the executable but never runs it, on either platform.
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
const authFile = (result) => JSON.parse(readFileSync(join(result.refresh, "auth.json"), "utf8"))

test("a CPA path imports into Grok Build's native shape once, without changing the source", async () => {
  const config = sandbox()
  const path = file(cpa())
  const before = readFileSync(path, "utf8")
  const asked = await authorize(path)
  expect(asked.url).toBe("")
  expect(asked.method).toBe("auto")
  const [r, again] = await Promise.all([asked.callback(), asked.callback()])
  expect(r).toEqual(again)
  expect(r.type).toBe("success")
  expect(r.access).toBe(goodToken)
  expect(r.accountId).toBe("someone@example.com")
  expect(dirname(r.refresh)).toBe(join(config, "opencode-grok-auth"))
  expect(authFile(r)).toEqual({ [SCOPE]: {
    key: goodToken, auth_mode: "oidc", create_time: "2026-11-01T01:02:03.000Z", user_id: "user-1",
    email: "someone@example.com", refresh_token: "rt-1", expires_at: "2099-01-01T00:00:00.000Z", oidc_issuer: "https://auth.x.ai", oidc_client_id: CLIENT_ID,
  } })
  if (process.platform !== "win32") expect(statSync(join(r.refresh, "auth.json")).mode & 0o777).toBe(0o600)
  expect(homes(config)).toHaveLength(1)
  expect(readFileSync(path, "utf8")).toBe(before)
})

test("invalid CPA sources are refused before making a home", async () => {
  const cases = [
    file("this is not JSON"), join(dir, "missing.json"),
    ...[{ type: "openai" }, { auth_kind: "api_key" }, { disabled: true }, { refresh_token: "" }, { sub: "" }, { email: "" },
      { expired: "yesterday" }, { expired: [later] }, { last_refresh: 1759936586 },
      { access_token: token("u", { iss: "https://accounts.example.com" }) },
      { access_token: token("u", { aud: ["someone-else"] }) }, { access_token: "opaque" }].map((over) => file(cpa(over))),
  ]
  for (const path of cases) {
    const config = sandbox()
    await expect(authorize(path)).rejects.toThrow()
    expect(homes(config)).toEqual([])
  }
})

test("Grok Build must be installed to own imported token refresh", async () => {
  const config = sandbox({ exe: false })
  await expect(authorize(file(cpa()))).rejects.toThrow("install Grok Build first")
  await expect(bulk([JSON.stringify(sub2api())])).rejects.toThrow("install Grok Build first")
  expect(homes(config)).toEqual([])
})

test("an expired CPA token is imported without spending its refresh token", async () => {
  sandbox()
  const expired = "2020-01-01T00:00:00Z"
  const a = await authorize(file(cpa({ expired })))
  expect((await a.callback()).expires).toBe(Date.parse(expired))
})

test("sub2api single-account paste accepts X identity without email and RFC3339 expiry", async () => {
  const config = sandbox()
  const source = sub2api({ expires_at: "2099-01-01T08:00:00+08:00" })
  const before = JSON.stringify(source)
  const a = await authorize(before)
  const r = await a.callback()
  expect(r.type).toBe("success")
  expect(r.accountId).toBe("user-1")
  expect(r.expires).toBe(Date.parse(later))
  expect(authFile(r)[SCOPE].email).toBeNull()
  expect(authFile(r)[SCOPE].oidc_client_id).toBe(CLIENT_ID)
  expect(JSON.stringify(source)).toBe(before)
  expect(homes(config)).toHaveLength(1)
})

test("sub2api identity falls back to the access token subject, not its display name", async () => {
  sandbox()
  const [r] = await bulk(JSON.stringify(sub2api({ sub: undefined })))
  expect(r.type).toBe("success")
  expect(r.accountId).toBe("user-1")
  expect(authFile(r)[SCOPE].user_id).toBe("user-1")
})

test("mixed sub2api exports skip other platforms and non-OAuth accounts and deduplicate CPA/paste copies", async () => {
  const config = sandbox()
  const exportData = {
    type: "sub2api-data", version: 1, exported_at: "2026-11-01T00:00:00Z", proxies: [{ name: "unused" }],
    accounts: [
      { platform: "antigravity", type: "oauth", credentials: { refresh_token: "not-grok" } },
      { platform: "grok", type: "apikey", credentials: { api_key: "not-oauth" } },
      sub2api(), sub2api({ access_token: token("user-2"), refresh_token: "rt-2", sub: "user-2", email: "second@example.com" }),
    ],
  }
  const text = JSON.stringify(exportData)
  const results = await bulk([text, JSON.stringify(cpa()), JSON.stringify(sub2api())])
  expect(results.map((r) => r.type)).toEqual(["success", "success"])
  expect(results.map((r) => r.accountId)).toEqual(["user-1", "second@example.com"])
  expect(homes(config)).toHaveLength(2)
  expect(JSON.stringify(exportData)).toBe(text)
})

test("explicit sub2api client, token issuer and audience errors are reported beside valid accounts", async () => {
  const config = sandbox()
  const bad = [
    sub2api({ client_id: "configured-other-client" }),
    sub2api({ access_token: token("user-1", { iss: "https://another.example" }) }),
    sub2api({ access_token: token("user-1", { aud: ["other-client"] }) }),
    sub2api({ access_token: "opaque" }),
    sub2api({ expires_at: 4102444800 }),
    sub2api({ expires_at: "4102444800" }),
    sub2api({ refresh_token: "" }),
    sub2api({ sub: undefined, access_token: token(undefined, { sub: undefined }) }),
  ]
  const results = await bulk([JSON.stringify({ accounts: [...bad, sub2api()] })])
  expect(results.map((r) => r.type)).toEqual([...bad.map(() => "failed"), "success"])
  // These diagnostics distinguish a configurable foreign client from an xAI
  // issuer/audience mismatch; neither may be silently coerced or discarded.
  expect(results[0].error).toContain("client_id")
  expect(results[1].error).toContain("issuer/audience")
  expect(results[2].error).toContain("issuer/audience")
  expect(homes(config)).toHaveLength(1)
})

test("unlabelled credentials and unsupported export versions create no homes", async () => {
  const config = sandbox()
  const sources = [sub2api().credentials,
    { type: "sub2api-data", version: 2, accounts: [sub2api()] }, { type: "another-export", accounts: [sub2api()] }, "not JSON"]
  for (const source of sources) {
    const results = await bulk([typeof source === "string" ? source : JSON.stringify(source)])
    expect(results.map((r) => r.type)).toEqual(["failed"])
  }
  expect(homes(config)).toEqual([])
})

test("foreign-platform and non-OAuth inputs are skipped even as standalone files", async () => {
  const config = sandbox()
  const inputs = [{ ...sub2api(), platform: "openai" }, { ...sub2api(), type: "api_key" }, cpa({ auth_kind: "api_key" })]
  expect(await bulk(inputs.map((a) => JSON.stringify(a)))).toEqual([])
  expect(homes(config)).toEqual([])
})

test("the single-account path/paste method directs multi-account JSON to magpie's bulk import", async () => {
  const config = sandbox()
  const data = { accounts: [sub2api(), sub2api({ sub: "user-2", access_token: token("user-2"), refresh_token: "rt-2" })] }
  await expect(authorize(JSON.stringify(data))).rejects.toThrow()
  expect(homes(config)).toEqual([])
  const a = await authorize(file({ accounts: [{ platform: "other", type: "oauth" }, sub2api()] }))
  expect((await a.callback()).type).toBe("success")
  expect(homes(config)).toHaveLength(1)
})

test("batch retries reuse existing private and CLI homes without rewriting their credentials", async () => {
  const config = sandbox()
  const [first] = await bulk([JSON.stringify(sub2api())])
  const before = readFileSync(join(first.refresh, "auth.json"), "utf8")
  const [again] = await bulk([JSON.stringify(sub2api({ refresh_token: "different-source-token" }))])
  expect(again).toEqual(first)
  expect(homes(config)).toHaveLength(1)
  expect(readFileSync(join(first.refresh, "auth.json"), "utf8")).toBe(before)

  const cli = join(process.env.GROK_HOME, "auth.json")
  writeFileSync(cli, JSON.stringify({ [SCOPE]: { key: token("cli-user"), user_id: "cli-user", email: "cli@example.com", expires_at: later } }))
  const cliBefore = readFileSync(cli, "utf8")
  const [current] = await bulk([JSON.stringify(sub2api({ sub: "cli-user", access_token: token("cli-user"), refresh_token: "cli-rt" }))])
  expect(current.refresh).toBe(process.env.GROK_HOME)
  expect(readFileSync(cli, "utf8")).toBe(cliBefore)
  expect(homes(config)).toHaveLength(1)
})

test("pre-aborted batches and callbacks allocate nothing and preserve existing homes", async () => {
  const config = sandbox()
  const a = await authorize(JSON.stringify(sub2api()))
  const c = new AbortController()
  c.abort()
  await expect(bulk([JSON.stringify(sub2api())], { signal: c.signal })).rejects.toThrow()
  await expect(authorize(JSON.stringify(sub2api()), { signal: c.signal })).rejects.toThrow()
  await expect(a.callback(undefined, { signal: c.signal })).rejects.toThrow()
  expect(homes(config)).toEqual([])
  expect(existsSync(process.env.GROK_HOME)).toBe(true)
})

test("cancellation interrupts an existing home's torn-file read without changing that home", async () => {
  const config = sandbox()
  const path = join(process.env.GROK_HOME, "auth.json")
  writeFileSync(path, "")
  const c = new AbortController()
  const auth = await hooks()
  const pending = auth.import([JSON.stringify(sub2api())], { signal: c.signal })
  c.abort()
  await expect(pending).rejects.toThrow()
  expect(getEventListeners(c.signal, "abort")).toHaveLength(0)
  expect(readFileSync(path, "utf8")).toBe("")
  expect(homes(config)).toEqual([])
})

test("the import callback respects authorize cancellation but cannot undo an already saved account", async () => {
  const config = sandbox()
  const cancelled = new AbortController()
  const a = await authorize(JSON.stringify(sub2api()), { signal: cancelled.signal })
  cancelled.abort()
  await expect(a.callback()).rejects.toThrow()
  expect(homes(config)).toEqual([])

  const completed = new AbortController()
  const b = await authorize(JSON.stringify(sub2api()), { signal: completed.signal })
  const result = await b.callback()
  completed.abort()
  expect(await b.callback(undefined, { signal: completed.signal })).toEqual(result)
  expect(homes(config)).toHaveLength(1)
  expect(existsSync(join(result.refresh, "auth.json"))).toBe(true)
})

test("cancelling after batch writes rolls back every unsaved new home but keeps existing accounts", async () => {
  const config = sandbox()
  const [existing] = await bulk([JSON.stringify(sub2api())])
  const before = readFileSync(join(existing.refresh, "auth.json"), "utf8")
  const c = new AbortController()
  const originalWrite = fs.writeFileSync
  let writes = 0
  const write = spyOn(fs, "writeFileSync").mockImplementation((...args) => {
    const r = originalWrite(...args)
    if (String(args[0]).endsWith("auth.json") && ++writes === 2) queueMicrotask(() => c.abort())
    return r
  })
  try {
    const list = [sub2api(), ...[2, 3, 4].map((n) => sub2api({ sub: `user-${n}`, access_token: token(`user-${n}`), refresh_token: `rt-${n}` }))]
    await expect(bulk([JSON.stringify({ accounts: list })], { signal: c.signal })).rejects.toThrow()
    expect(writes).toBe(2)
  } finally {
    write.mockRestore()
  }
  expect(homes(config)).toEqual([existing.refresh.split(/[\\/]/).at(-1)])
  expect(readFileSync(join(existing.refresh, "auth.json"), "utf8")).toBe(before)
  expect(existsSync(process.env.GROK_HOME)).toBe(true)
  const [retried] = await bulk([JSON.stringify(sub2api({ sub: "user-2", access_token: token("user-2"), refresh_token: "rt-2" }))])
  expect(retried.type).toBe("success")
  expect(homes(config)).toHaveLength(2)
})

test("write failure removes its allocated home and a later import can retry", async () => {
  const config = sandbox()
  const originalWrite = fs.writeFileSync
  const write = spyOn(fs, "writeFileSync").mockImplementation((...args) => {
    if (String(args[0]).endsWith("auth.json")) throw new Error("test disk failure")
    return originalWrite(...args)
  })
  try {
    expect((await bulk([JSON.stringify(sub2api())])).map((r) => r.type)).toEqual(["failed"])
    expect(homes(config)).toEqual([])
  } finally {
    write.mockRestore()
  }
  expect((await bulk([JSON.stringify(sub2api())]))[0].type).toBe("success")
  expect(homes(config)).toHaveLength(1)
})

test("a home that cannot be made leaves its existing path untouched", async () => {
  const config = sandbox()
  writeFileSync(join(config, "opencode-grok-auth"), "existing file")
  const a = await authorize(file(cpa()))
  await expect(a.callback()).rejects.toThrow()
  expect(readFileSync(join(config, "opencode-grok-auth"), "utf8")).toBe("existing file")
})

test("a representative multi-file batch creates one home per identity, with no extra homes on retry", async () => {
  const config = sandbox()
  const accounts = Array.from({ length: 50 }, (_, n) => sub2api({ sub: `bulk-${n}`, access_token: token(`bulk-${n}`), refresh_token: `bulk-rt-${n}` }))
  const texts = Array.from({ length: 4 }, () => JSON.stringify({ type: "sub2api-data", version: 1, accounts }))
  const results = await bulk(texts)
  expect(results).toHaveLength(50)
  expect(results.every((r) => r.type === "success")).toBe(true)
  expect(homes(config)).toHaveLength(50)
  const again = await bulk(texts)
  expect(again).toEqual(results)
  expect(homes(config)).toHaveLength(50)
})
