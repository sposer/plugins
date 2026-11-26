import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { dropHome, inAccount, newHome, tokenFile, writeTokenFile } from "../account.mjs"
import { startLogin } from "../login.mjs"

const PTY = { skip: process.platform !== "linux" || typeof globalThis.Bun?.Terminal !== "function" }
const LINK = "https://accounts.google.com/o/oauth2/auth?client_id=test&state=one"
const CALLBACK = "https://antigravity.google/oauth-callback?code=sandbox&state=one"
const TOKENS = JSON.stringify({ token: { refresh_token: "sandbox-refresh", access_token: "sandbox-access" } })

function fixture(t, { mode = "success", input = CALLBACK } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-login-test-"))
  const account = newHome({ XDG_STATE_HOME: root })
  const agy = path.join(root, "agy")
  const pid = path.join(root, "pid")
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(agy, `#!${process.execPath}
import fs from "node:fs"
import path from "node:path"
const env = process.env
fs.writeFileSync(${JSON.stringify(pid)}, String(process.pid))
if (process.argv.slice(2).includes("acp") || !env.SSH_CONNECTION || env.HOME !== process.cwd() ||
    !env.XDG_CONFIG_HOME.startsWith(env.HOME + path.sep) || env.ANTIGRAVITY_GEMINI_DIR || env.GEMINI_API_KEY) process.exit(2)
const mode = ${JSON.stringify(mode)}
const link = ${JSON.stringify(LINK)}
process.stdin.setRawMode(true)
process.stdin.setEncoding("utf8")
let selected = false, input = ""
process.stdin.on("data", chunk => {
  input += chunk
  if (!input.endsWith("\\r")) return
  if (!selected && input === "\\r") {
    selected = true
    input = ""
    process.stdout.write("\\x1b]8;id=mock;" + link.slice(0, 40))
    setTimeout(() => {
      process.stdout.write(link.slice(40) + "\\x1b\\\\Click here to authenticate\\x1b]8;;\\x1b\\\\\\nauthorization \\x1b[32mcode...\\x1b[0m\\n")
    }, 10)
  } else if (selected) {
    if (mode === "stall") return
    if (mode === "exit") process.exit(0)
    if (input !== ${JSON.stringify(input + "\r")}) process.exit(3)
    if (mode === "deny") return process.stdout.write("invalid_grant\\nPress any key to go back.\\n")
    const file = ${JSON.stringify(tokenFile(account.home))}
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, ${JSON.stringify(TOKENS)})
  }
})
if (mode !== "silent") process.stdout.write("Select login method:\\n> 1. Google OAuth\\n2. Use a Google Cloud project\\n↑/↓ Navigate · enter Select\\n")
`, { mode: 0o755 })
  return {
    account,
    start: options => inAccount(account.home, () => startLogin(agy, {
      onFailure: () => dropHome(account.home), ...options,
    })),
    launched: () => fs.existsSync(pid),
    stopped: () => assert.throws(() => process.kill(Number(fs.readFileSync(pid, "utf8")), 0), { code: "ESRCH" }),
    stored: () => fs.readFileSync(tokenFile(account.home), "utf8"),
  }
}

test("native Google login submits the callback once and succeeds after the credential is stored", PTY, async t => {
  const f = fixture(t)
  const login = await f.start()
  assert.equal(login.url, LINK)
  const done = login.finish(CALLBACK)
  assert.ok((await login.finish("duplicate")).error)
  assert.deepEqual(await done, { ok: true })
  f.stopped()
  assert.equal(f.stored(), TOKENS)
  assert.ok((await login.finish("replay")).error)
  assert.equal(f.stored(), TOKENS)
})

test("native login never starts against an account with existing credentials", t => {
  const f = fixture(t)
  writeTokenFile(f.account.home, TOKENS)
  return f.start().then(result => {
    assert.ok(result.error)
    assert.equal(f.launched(), false)
    assert.equal(f.stored(), TOKENS)
  })
})

test("native login cancellation and replacement release only the unfinished account homes", PTY, async t => {
  const replaced = fixture(t)
  const first = await replaced.start()
  const f = fixture(t, { mode: "stall" })
  const second = await f.start()
  assert.ok((await first.finish(CALLBACK)).error)
  replaced.stopped()
  assert.equal(fs.existsSync(replaced.account.home), false)
  const controller = new AbortController()
  const done = second.finish(CALLBACK, { signal: controller.signal })
  controller.abort()
  assert.ok((await done).error)
  f.stopped()
  assert.equal(fs.existsSync(f.account.home), false)
  const cancelled = fixture(t)
  assert.ok((await cancelled.start({ signal: controller.signal })).error)
  assert.equal(cancelled.launched(), false)
  assert.equal(fs.existsSync(cancelled.account.home), false)
})

test("the TUI's rejection or exit without a new credential fails sign-in", PTY, async t => {
  for (const mode of ["deny", "exit"]) {
    const f = fixture(t, { mode, input: "sandbox-code" })
    const login = await f.start()
    assert.equal(login.url, LINK)
    assert.ok((await login.finish("sandbox-code")).error)
    f.stopped()
    assert.equal(fs.existsSync(f.account.home), false)
  }
})

test("native login releases the PTY at its startup or submission deadline", PTY, async t => {
  const f = fixture(t, { mode: "silent" })
  assert.ok((await f.start({ startMs: 300 })).error)
  f.stopped()
  assert.equal(fs.existsSync(f.account.home), false)
  const checking = fixture(t, { mode: "stall" })
  const login = await checking.start()
  assert.equal(login.url, LINK)
  assert.ok((await login.finish(CALLBACK, { finishMs: 25 })).error)
  checking.stopped()
  assert.equal(fs.existsSync(checking.account.home), false)
})
