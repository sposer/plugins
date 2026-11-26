import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { tokenFile } from "../account.mjs"
import { baseBody, createBridgeKit, modelsOutput } from "./testkit.mjs"

const TTL = 5 * 60 * 1000
const fellBack = Symbol.for("magpie.fellBack")
const gemini = [
  ["gemini-4-argon-high", "Gemini 4 Argon (High)"],
  ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
  ["gemini-4-carbon-high", "Gemini 4 Carbon (High)"],
]
const native = { stdout: modelsOutput([
  ...gemini,
  ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"],
  ["claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
  ["native-only", "Native Only"],
  ["gemini-4-orchestrator", "Orchestrator"],
]) }

async function fixture(t, options) {
  const kit = await createBridgeKit({ modelsBehavior: native, ...options })
  t.after(() => kit.dispose())
  return kit
}

function checkFallback(models) {
  assert.equal(models[fellBack], true)
  assert.ok(models["gemini-4-argon"])
  assert.equal(models["native-only"], undefined)
}

function storedGoogle(email) {
  return "go-keyring-base64:" + Buffer.from(JSON.stringify({
    token: { access_token: "fixture-access", refresh_token: "fixture-refresh", expiry: "2020-01-01T00:00:00Z" },
    id_token_email: email,
  })).toString("base64")
}

test("without a CLI the static public catalog is marked as a fallback", async t => {
  const kit = await fixture(t, { agyPath: null })
  checkFallback(await kit.models())
  assert.equal(kit.modelsSpawns.length, 0)
})

test("a signed-out account never starts background discovery or a native turn", async t => {
  const kit = await fixture(t, { platform: "darwin", storedSignIn: "missing" })
  checkFallback(await kit.models())
  await kit.plugin.provider.warming()
  assert.equal(kit.modelsSpawns.length, 0)
  const response = await kit.request(baseBody())
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("X-Magpie-Sign-In"), "expired")
  assert.equal(kit.tuiRuns.length, 0)
})

test("a cold, hung native listing falls back within the provider deadline", async t => {
  const kit = await fixture(t, { modelsBehavior: { hang: true } })
  const start = performance.now()
  checkFallback(await kit.models())
  assert.ok(performance.now() - start < 1500, "discovery must return before Magpie's 2s timeout")
  assert.equal(kit.modelsSpawns.length, 1)
  assert.equal(kit.timers.refed().length, 0)
  await kit.finishChildren()
  await kit.plugin.provider.warming()
  assert.equal(kit.timers.refed().length, 0)
})

test("native discovery exposes the account's families, variants, capabilities and known limits", async t => {
  const kit = await fixture(t)
  const models = await kit.models()
  assert.equal(models[fellBack], undefined)
  const sonnet = models["claude-sonnet-5-5"]
  assert.deepEqual(Object.keys(sonnet.variants).sort(), ["high", "low"])
  assert.equal(sonnet.capabilities.input.image, true)
  assert.deepEqual(models["gemini-4-carbon-high"].limit, { context: 1048576, output: 262144 })
  assert.ok(models["gpt-oss-120b"])
  assert.equal(models["native-only"].limit, undefined, "unknown models must not get guessed limits")
  assert.equal(models["gemini-4-orchestrator"], undefined)
  const response = await kit.request(baseBody({ model: "agy-cli/gemini-4-orchestrator" }))
  assert.equal(response.status, 400)
  assert.equal(kit.tuiRuns.length, 0)
  assert.deepEqual(kit.modelsSpawns.map(call => call.args), [["models"]])
})

test("a fast native Gemini-only catalog is authoritative rather than marked partial", async t => {
  const kit = await fixture(t, { modelsBehavior: { stdout: modelsOutput(gemini) } })
  const models = await kit.models()
  assert.equal(models[fellBack], undefined)
  assert.ok(models["gemini-4-carbon-high"])
  assert.equal(models["claude-sonnet-5-5"], undefined)
})

test("a slow native listing warms the catalog without waiting on a generation", async t => {
  const kit = await fixture(t, { modelsBehavior: { ...native, delayMs: 800 } })
  checkFallback(await kit.models())
  await kit.plugin.provider.warming()
  const models = await kit.models()
  assert.ok(models["native-only"])
  assert.equal(models[fellBack], undefined)
  assert.equal(kit.modelsSpawns.length, 1)
  assert.equal(kit.tuiRuns.length, 0)
})

test("concurrent reads coalesce; stale reads survive a failed native refresh", async t => {
  const kit = await fixture(t)
  const [first, ...rest] = await Promise.all(Array.from({ length: 20 }, () => kit.models()))
  assert.ok(first["native-only"])
  for (const catalog of rest) assert.deepEqual(catalog, first)
  assert.equal(kit.modelsSpawns.length, 1)
  kit.advance(TTL - 1)
  assert.ok((await kit.models())["native-only"])
  assert.equal(kit.modelsSpawns.length, 1)
  kit.advance(1)
  kit.modelsBehavior = { code: 1, stderr: "connection reset" }
  assert.ok((await kit.models())["native-only"])
  await kit.plugin.provider.warming()
  assert.equal(kit.modelsSpawns.length, 2)
  assert.ok((await kit.models())["native-only"])
  assert.equal(kit.modelsSpawns.length, 2, "failed refreshes are throttled")
  kit.advance(5_001)
  kit.modelsBehavior = { stdout: modelsOutput([["replacement-only", "Replacement Only"]]) }
  await kit.models()
  await kit.plugin.provider.warming()
  const refreshed = await kit.models()
  assert.ok(refreshed["replacement-only"])
  assert.equal(refreshed["native-only"], undefined)
})

test("a cached native listing survives startup without reviving historical offered rows", async t => {
  const kit = await fixture(t, { modelsBehavior: { hang: true } })
  const dir = path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ version: 1, byAgy: {
    [kit.agyPath]: {
      at: Date.UTC(2026, 10, 4, 12),
      list: [{ id: "native-cached", name: "Cached Native Model" }],
      offered: [{ id: "old-transport-only", name: "Obsolete Model" }],
    },
  } }))
  const models = await kit.models()
  assert.ok(models["native-cached"])
  assert.equal(models["old-transport-only"], undefined)
  assert.equal(models[fellBack], undefined)
  await kit.finishChildren()
  await kit.plugin.provider.warming()
  kit.env.AGY_PATH = kit.makeFakeAgy("agy-b")
  kit.modelsBehavior = native
  const switched = await kit.models()
  assert.ok(switched["native-only"])
  assert.equal(switched["native-cached"], undefined)
  assert.equal(kit.modelsSpawns.at(-1).file, kit.env.AGY_PATH)
})

test("the current native token file names the Google account and seeds model discovery", async t => {
  const kit = await fixture(t)
  const file = tokenFile(kit.home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, storedGoogle("sample@example.com"))
  const login = await kit.plugin.auth.methods[0].authorize()
  assert.equal(login.method, "auto")
  const result = await login.callback()
  assert.equal(result.type, "success")
  assert.deepEqual(result.metadata, { email: "sample@example.com" })
  assert.ok((await kit.models())["native-only"])
  assert.equal(kit.modelsSpawns.length, 1)
  assert.equal(kit.modelsSpawns[0].env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE, "true")
})

test("a keyring-only sign-in is not accepted for the private native terminal", async t => {
  const kit = await fixture(t, { platform: "darwin", storedSignIn: storedGoogle("sample@example.com") })
  assert.ok((await kit.models())["native-only"], "the keyring can serve native discovery")
  const login = await kit.plugin.auth.methods[0].authorize()
  // This host cannot open a Bun PTY. It must not claim it reused the keyring.
  assert.equal(login.type, "failed")
  assert.equal(kit.modelsSpawns.length, 1)
})

test("a native account refusal is surfaced rather than disguised as a static catalog", async t => {
  const kit = await fixture(t, { modelsBehavior: { code: 1, stderr:
    "Error: Eligibility check failed: PERMISSION_DENIED (code 403): You do not have a valid license of this product. (#3501). Please log out (/logout) and log back in (/login).\n",
  } })
  await assert.rejects(kit.models(), /#3501/)
  assert.equal(kit.modelsSpawns.length, 1)
})

test("native discovery bypasses settings.json's custom provider when the CLI accepts --settings", async t => {
  const kit = await fixture(t, {
    topHelp: "Usage of agy:\n  --settings  Settings for this session only\n",
    modelsBehavior: ({ args }) => args[0] === "--settings" && JSON.parse(args[1]).modelProvider === ""
      ? native : { code: 1, stderr: "Custom provider has no API key" },
  })
  assert.ok((await kit.models())["native-only"])
  assert.deepEqual(kit.modelsSpawns.map(call => call.args), [["--settings", '{"modelProvider":""}', "models"]])
  assert.equal(kit.helpSpawns.length, 1)
})

test("native listings use their selected account's home and do not leak across accounts", async t => {
  const kit = await fixture(t, {
    modelsBehavior: ({ env }) => env.HOME === otherHome ? { stdout: modelsOutput(gemini) } : native,
  })
  const auth = { type: "oauth", metadata: { agyHome: "otheracct1" } }
  const otherHome = path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "accounts", "otheracct1")
  const dir = path.join(otherHome, ".gemini", "antigravity-cli")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "antigravity-oauth-token"), JSON.stringify({ token: {
    access_token: "fixture-access", refresh_token: "fixture-refresh", expiry: "0001-01-01T00:00:00Z",
  } }))
  assert.ok((await kit.models())["claude-sonnet-5-5"])
  const other = await kit.models({ auth })
  assert.ok(other["gemini-4-argon"])
  assert.equal(other["claude-sonnet-5-5"], undefined)
  assert.ok((await kit.models())["claude-sonnet-5-5"])
  assert.deepEqual(kit.modelsSpawns.map(call => call.env.HOME), [kit.home, otherHome])
})
