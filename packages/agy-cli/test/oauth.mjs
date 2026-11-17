import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { baseBody, createBridgeKit, readSse, tick } from "./testkit.mjs"
import { storedToken } from "../signin.mjs"

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
const fresh = { access_token: "sandbox-access", refresh_token: "sandbox-refresh", token_type: "Bearer", expires_in: 3600 }

async function fixture(t, options) {
  const kit = await createBridgeKit(options)
  const original = globalThis.fetch
  const calls = []
  let tokenReply = () => json(fresh)
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url) === "https://oauth2.googleapis.com/token") return tokenReply(init)
    if (String(url) === "https://www.googleapis.com/oauth2/v2/userinfo") return json({ email: "sandbox@example.com" })
    throw new Error(`unexpected network request: ${url}`)
  }
  t.after(async () => { globalThis.fetch = original; await kit.dispose() })
  const accounts = path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "accounts")
  const homes = () => fs.existsSync(accounts) ? fs.readdirSync(accounts) : []
  return { kit, calls, homes, accounts, reply: fn => { tokenReply = fn }, methods: kit.plugin.auth.methods }
}

function link(login) { return new URL(login.url) }
function callback(url, params) {
  const target = new URL(url.searchParams.get("redirect_uri"))
  target.search = new URLSearchParams({ code: "sandbox-code", state: url.searchParams.get("state"), ...params }).toString()
  return target.href
}

test("configured authorization checks state and PKCE, writes native storage and serves an ACP request", async t => {
  const f = await fixture(t)
  const login = await f.methods[2].authorize({ redirect_uri: "http://localhost:8085/callback" })
  const url = link(login)
  assert.equal(url.searchParams.get("access_type"), "offline")
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  const result = await login.callback(callback(url))
  assert.equal(result.type, "success")
  assert.equal(result.metadata.email, "sandbox@example.com")
  const home = path.join(f.accounts, result.metadata.agyHome)
  const stored = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "utf8"))
  assert.equal(stored.token.refresh_token, fresh.refresh_token)
  assert.equal(stored.token.access_token, fresh.access_token)
  assert.equal(fs.existsSync(path.join(home, ".gemini", "antigravity-cli", "oauth-client.json")), false)
  const form = new URLSearchParams(f.calls[0].init.body)
  assert.equal(form.get("grant_type"), "authorization_code")
  assert.equal(form.get("redirect_uri"), "http://localhost:8085/callback")
  assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), url.searchParams.get("code_challenge"))
  assert.equal((await login.callback(callback(url))).type, "failed")
  assert.equal(fs.existsSync(home), true)
  const loader = await f.kit.plugin.auth.loader(() => result)
  await readSse(await loader.fetch("agy://local/v1/messages", { method: "POST", body: JSON.stringify(baseBody()) }))
  assert.ok(f.kit.acpSpawns.some(spawn => spawn.env.HOME === home && spawn.args.includes("--agent")))
  assert.equal(f.homes().length, 1)
})

test("token login validates refresh with the entered client and persists native ADC for subsequent CLI runs", async t => {
  const f = await fixture(t)
  const login = await f.methods[3].authorize({
    client_id: "sandbox-client", client_secret: "sandbox-secret", refresh_token: "submitted-refresh",
    access_token: "submitted-access", expiry: "2099-01-01T00:00:00Z", email: "entered@example.com",
  })
  assert.equal(login.method, "auto")
  assert.equal(login.url, "")
  const result = await login.callback()
  assert.equal(result.type, "success")
  assert.equal(result.metadata.email, "entered@example.com")
  const home = path.join(f.accounts, result.metadata.agyHome)
  const adc = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "antigravity-cli", "oauth-client.json"), "utf8"))
  assert.deepEqual(adc, { type: "authorized_user", client_id: "sandbox-client", client_secret: "sandbox-secret", refresh_token: fresh.refresh_token, token_uri: "https://oauth2.googleapis.com/token" })
  const quotaSignIn = await storedToken({ home })
  assert.equal(quotaSignIn.auth_method, "adc")
  assert.deepEqual(quotaSignIn.oauth, adc)
  const form = new URLSearchParams(f.calls[0].init.body)
  assert.equal(form.get("grant_type"), "refresh_token")
  assert.equal(form.get("client_id"), "sandbox-client")
  assert.equal(form.get("client_secret"), "sandbox-secret")
  assert.equal(form.get("refresh_token"), "submitted-refresh")
  assert.equal(f.calls.length, 1)
  const loader = await f.kit.plugin.auth.loader(() => result)
  await readSse(await loader.fetch("agy://local/v1/messages", { method: "POST", body: JSON.stringify(baseBody()) }))
  const spawn = f.kit.acpSpawns.find(spawn => spawn.args.includes("--agent"))
  assert.equal(spawn.env.AGY_ADC_AUTH, "true")
  assert.equal(spawn.env.GOOGLE_APPLICATION_CREDENTIALS, path.join(home, ".gemini", "antigravity-cli", "oauth-client.json"))
  assert.equal((await login.callback()).type, "failed")
  assert.equal(fs.existsSync(home), true)
})

test("a wrong state or redirect and an upstream refusal save no account; a new attempt accepts a pasted code", async t => {
  const f = await fixture(t)
  for (const bad of [url => callback(url, { state: "other-attempt" }), () => "https://wrong.example/callback?code=code&state=bad"]) {
    const login = await f.methods[2].authorize()
    assert.equal((await login.callback(bad(link(login)))).type, "failed")
    assert.equal(f.homes().length, 0)
    assert.equal(f.calls.length, 0)
  }
  f.reply(() => json({ error: "invalid_grant" }, 400))
  const rejectedCode = await f.methods[2].authorize()
  assert.equal((await rejectedCode.callback("rejected-code")).type, "failed")
  assert.equal(f.homes().length, 0)
  const rejected = await f.methods[3].authorize({ refresh_token: "revoked-refresh" })
  assert.equal((await rejected.callback()).type, "failed")
  assert.equal(f.homes().length, 0)
  f.reply(() => json(fresh))
  const retry = await f.methods[2].authorize()
  assert.equal((await retry.callback("sandbox-code")).type, "success")
  assert.equal(f.homes().length, 1)
})

test("cancelling before or during exchange and replacing an abandoned attempt release its home", async t => {
  const f = await fixture(t)
  const before = new AbortController()
  before.abort()
  assert.equal((await f.methods[2].authorize(undefined, { signal: before.signal })).type, "failed")
  assert.equal(f.homes().length, 0)
  const waiting = new AbortController()
  const abandoned = await f.methods[2].authorize(undefined, { signal: waiting.signal })
  waiting.abort()
  assert.equal((await abandoned.callback("code")).type, "failed")
  assert.equal(f.homes().length, 0)
  let started
  const fetching = new Promise(resolve => { started = resolve })
  f.reply(init => new Promise((_resolve, reject) => {
    started()
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
  }))
  const active = new AbortController()
  const exchange = await f.methods[3].authorize({ refresh_token: "pending-refresh" })
  const result = exchange.callback(undefined, { signal: active.signal })
  await fetching
  assert.equal((await exchange.callback()).type, "failed")
  active.abort()
  assert.equal((await result).type, "failed")
  assert.equal(f.homes().length, 0)
  const first = await f.methods[2].authorize()
  const old = f.homes()[0]
  const next = await f.methods[2].authorize()
  assert.equal(fs.existsSync(path.join(f.accounts, old)), false)
  assert.equal((await first.callback("code")).type, "failed")
  const cancel = new AbortController()
  cancel.abort()
  assert.equal((await next.callback("code", { signal: cancel.signal })).type, "failed")
  assert.equal(f.homes().length, 0)
  await tick()
  assert.equal(f.kit.children.size, 0)
  assert.equal(f.kit.timers.refed().length, 0)
})

test("invalid token fields, write errors and native verification failures discard only the unfinished home", async t => {
  const f = await fixture(t, { modelsBehavior: { code: 1, stderr: 'oauth2: "invalid_grant"' } })
  assert.equal((await f.methods[3].authorize({ client_id: "custom-without-secret" })).type, "failed")
  assert.equal(f.homes().length, 0)
  for (const input of [{}, { refresh_token: "refresh", expiry: "invalid-date" }, { refresh_token: "refresh" }]) {
    const login = await f.methods[3].authorize(input)
    assert.equal((await login.callback()).type, "failed")
    assert.equal(f.homes().length, 0)
  }
  const writing = await f.methods[3].authorize({ refresh_token: "refresh", email: "sandbox@example.com" })
  fs.writeFileSync(path.join(f.accounts, f.homes()[0], ".gemini"), "not a directory")
  const probes = f.kit.modelsSpawns.length
  assert.equal((await writing.callback()).type, "failed")
  assert.equal(f.kit.modelsSpawns.length, probes)
  assert.equal(f.homes().length, 0)
  assert.equal(f.kit.children.size, 0)
  assert.equal(f.kit.timers.refed().length, 0)
})
