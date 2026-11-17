import { noRealGrok } from "./nocli.mjs"
import { afterAll, afterEach, expect, mock, test } from "bun:test"
import * as childProcess from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

noRealGrok()

const realExecFile = childProcess.execFile
let cliVersion
mock.module("node:child_process", () => ({ ...childProcess, execFile: (...args) => cliVersion ? cliVersion(...args) : realExecFile(...args) }))
const realFetch = globalThis.fetch
const env = { ...process.env }
const root = mkdtempSync(join(tmpdir(), "grok-identity-"))
const bin = join(root, "bin")
const exe = join(bin, process.platform === "win32" ? "grok.exe" : "grok")
mkdirSync(bin)
writeFileSync(exe, "not executable; execFile is mocked")
const expires = Date.parse("2099-01-01T00:00:00Z")
writeFileSync(join(root, "auth.json"), JSON.stringify({ test: { key: "test-token", expires_at: new Date(expires).toISOString(), email: "test@example.invalid" } }))
const auth = { type: "oauth", refresh: root, access: "test-token", expires, accountId: "test@example.invalid" }
afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => {
  globalThis.fetch = realFetch
  cliVersion = undefined
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]
  Object.assign(process.env, env)
})

let sample = 0
async function client(reply) {
  process.env.GROK_BIN_DIR = reply ? bin : join(root, "no-bin")
  const runs = []
  cliVersion = (file, args, _options, done) => {
    runs.push({ file, args })
    done(reply.err ?? null, reply.stdout ?? "", "")
  }
  // Each sample gets the production module with its own version cache, without
  // a test-only reset in the plugin or a dependency on the preceding test file.
  const { GrokAuthPlugin } = await import(`./index.mjs?identity=${++sample}`)
  const hooks = await GrokAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => auth)
  return { hooks, opts, runs }
}

for (const { name, reply, version } of [
  { name: "no installed CLI", version: "1.0.88" },
  { name: "an older installed CLI", reply: { stdout: "grok 1.0.41 (old)" }, version: "1.0.88" },
  { name: "the baseline installed CLI", reply: { stdout: "grok 1.0.88 (2fe3608f7398)" }, version: "1.0.88" },
  { name: "a newer installed CLI", reply: { stdout: "grok 1.0.89 (new)" }, version: "1.0.89" },
  { name: "an unreadable CLI version", reply: { stdout: "grok unavailable" }, version: "1.0.88" },
  { name: "a failed CLI version command", reply: { err: new Error("unavailable"), stdout: "grok 9.9.9" }, version: "1.0.88" },
]) {
  test(`headless requests use a coherent identity with ${name}`, async () => {
    const { opts, runs } = await client(reply)
    const sent = []
    globalThis.fetch = async (_, init) => { sent.push(new Headers(init.headers)); return Response.json({ output: [] }) }
    for (let i = 0; i < 2; i++) await opts.fetch(`${opts.baseURL}/responses`, {
      method: "POST",
      headers: { "x-grok-client-version": "0.0.1", "User-Agent": "caller/0.0.1", Authorization: "Bearer caller" },
      body: JSON.stringify({ model: "grok-4.7", input: "hi" }),
    })
    const os = { darwin: "macos", win32: "windows" }[process.platform] ?? process.platform
    const arch = { x64: "x86_64", arm64: "aarch64", ia32: "x86" }[process.arch] ?? process.arch
    expect(sent).toHaveLength(2)
    for (const h of sent) {
      expect(h.get("Authorization")).toBe("Bearer test-token")
      expect(h.get("x-grok-client-version")).toBe(version)
      expect(h.get("x-xai-token-auth")).toBe("xai-grok-cli")
      expect(h.get("x-grok-client-identifier")).toBe("grok-shell")
      expect(h.get("x-grok-client-mode")).toBe("headless")
      expect(h.get("x-authenticateresponse")).toBe("authenticate-response")
      expect(h.get("User-Agent")).toBe(`grok-shell/${version} (${os}; ${arch})`)
    }
    expect(runs).toEqual(reply ? [{ file: exe, args: ["--version"] }] : [])
  })
}

test("the proxy auth marker signs model lists but not direct API speech requests", async () => {
  const { hooks, opts } = await client()
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), marker: init.headers.get("x-authenticateresponse") })
    return String(url).endsWith("/models") ? Response.json({ data: [{ id: "grok-4.7", api_backend: "responses", context_window: 256000 }] }) : Response.json({ text: "hello" })
  }
  await hooks.provider.models({ id: "grok", models: {} }, { auth })
  const form = new FormData()
  form.set("file", new Blob(["test audio"], { type: "audio/wav" }), "test.wav")
  const body = new Response(form)
  await opts.fetch(`${opts.baseURL}/audio/transcriptions`, {
    method: "POST", headers: { "content-type": body.headers.get("content-type") }, body: await body.arrayBuffer(),
  })
  expect(sent).toEqual([
    { url: "https://cli-chat-proxy.grok.com/v1/models", marker: "authenticate-response" },
    { url: "https://api.x.ai/v1/stt", marker: null },
  ])
})
