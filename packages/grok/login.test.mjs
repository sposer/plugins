// Exercise the native CLI boundary without running Grok Build or writing a
// login script in the user's home. The child and interaction timers are
// controlled on Windows as well as POSIX; every filesystem target is temporary.
import { noRealGrok } from "./nocli.mjs"
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import * as childProcess from "node:child_process"
import { EventEmitter, getEventListeners } from "node:events"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

noRealGrok()

const realSpawn = childProcess.spawn
let spawnLogin
mock.module("node:child_process", () => ({ ...childProcess, spawn: (...args) => spawnLogin ? spawnLogin(...args) : realSpawn(...args) }))
const { GrokAuthPlugin } = await import("./index.mjs")
const dir = mkdtempSync(join(tmpdir(), "grok-login-"))
const envKeys = ["HOME", "USERPROFILE", "GROK_HOME", "GROK_BIN_DIR", "XDG_CONFIG_HOME", "GROK_AUTH_PATH", "PATH", "BROWSER"]
const realEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]))
const nativeSetTimeout = globalThis.setTimeout
const nativeClearTimeout = globalThis.clearTimeout
const LINK = "https://accounts.x.ai/oauth2/device?user_code=AB12-CD34"
const scope = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"
const later = "2099-01-01T00:00:00Z"
const theirs = { [scope]: { key: "cli-tok", email: "cli@x.ai", user_id: "u-cli", expires_at: later } }
const account = { [scope]: { key: "tok", email: null, user_id: "u-1", expires_at: later } }
let cliHome, config, calls, children, timers, setTimer, clearTimer, behavior

class Child extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kills = []
  output(text, stderr = false) { (stderr ? this.stderr : this.stdout).emit("data", Buffer.from(text)) }
  close(code = 0) {
    if (this.exited) return
    this.exited = true
    children.delete(this)
    this.emit("exit", code)
    this.emit("close", code)
  }
  kill(signal) {
    this.kills.push(signal)
    // A child may finish a write as it is killed. Cleanup must follow exit.
    queueMicrotask(() => {
      writeFileSync(join(this.home, "late-write"), "temporary")
      this.close(null)
    })
    return true
  }
}

beforeEach(() => {
  cliHome = mkdtempSync(join(dir, "home-"))
  config = mkdtempSync(join(dir, "config-"))
  const user = mkdtempSync(join(dir, "user-"))
  const bin = mkdtempSync(join(dir, "bin-"))
  writeFileSync(join(bin, process.platform === "win32" ? "grok.exe" : "grok"), "not an executable; spawn is mocked")
  Object.assign(process.env, { HOME: user, USERPROFILE: user, GROK_HOME: cliHome, GROK_BIN_DIR: bin, XDG_CONFIG_HOME: config, PATH: "" })
  calls = []
  children = new Set()
  timers = new Map()
  behavior = () => {}
  setTimer = spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) => {
    if (ms !== 100 && ms !== 30_000 && ms !== 600_000) return nativeSetTimeout(fn, ms, ...args)
    const timer = { ms, fire: () => { timers.delete(timer); fn(...args) } }
    timers.set(timer, timer)
    return timer
  })
  clearTimer = spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
    if (!timers.delete(timer)) nativeClearTimeout(timer)
  })
  spawnLogin = (exe, args, options) => {
    const child = new Child()
    child.home = options.env.GROK_HOME
    calls.push({ exe, args, options, child })
    children.add(child)
    queueMicrotask(() => behavior(child, options))
    return child
  }
})

afterEach(() => {
  for (const child of children) child.close(1)
  setTimer.mockRestore()
  clearTimer.mockRestore()
  spawnLogin = undefined
  for (const [k, v] of Object.entries(realEnv)) v === undefined ? delete process.env[k] : (process.env[k] = v)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const homes = () => existsSync(join(config, "opencode-grok-auth")) ? readdirSync(join(config, "opencode-grok-auth")) : []
const fire = (ms) => {
  const timer = [...timers.values()].find((t) => t.ms === ms)
  expect(timer).toBeDefined()
  timer.fire()
}
const drained = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const authorize = async (signal) => (await GrokAuthPlugin({})).auth.methods[0].authorize(undefined, { signal })
const existing = () => writeFileSync(join(cliHome, "auth.json"), JSON.stringify(theirs))
function complete(child, what = account) {
  if (what) writeFileSync(join(child.home, "auth.json"), JSON.stringify(what))
  child.output("✓ Signed in\n")
  child.close(0)
}
function released(signal) {
  expect(children.size).toBe(0)
  expect(timers.size).toBe(0)
  if (signal) expect(getEventListeners(signal, "abort")).toHaveLength(0)
  for (const { child } of calls) {
    expect(child.stdout.listenerCount("data")).toBe(0)
    expect(child.stderr.listenerCount("data")).toBe(0)
    expect(child.listenerCount("error")).toBe(0)
    expect(child.listenerCount("exit")).toBe(0)
    expect(child.listenerCount("close")).toBe(0)
  }
}

test("pre-aborted sign-in allocates no home and starts no CLI", async () => {
  existing()
  const c = new AbortController()
  c.abort()
  await expect(authorize(c.signal)).rejects.toThrow()
  expect(calls).toHaveLength(0)
  expect(homes()).toEqual([])
  expect(JSON.parse(readFileSync(join(cliHome, "auth.json"), "utf8"))).toEqual(theirs)
  released(c.signal)
})

test("cancellation during the initial credential read starts no CLI or new home", async () => {
  existing()
  const auth = (await GrokAuthPlugin({})).auth
  const c = new AbortController()
  const pending = auth.methods[0].authorize(undefined, { signal: c.signal })
  c.abort()
  await expect(pending).rejects.toThrow()
  expect(calls).toHaveLength(0)
  expect(homes()).toEqual([])
  released(c.signal)
})

test("an asynchronous spawn error releases its home and retains the error", async () => {
  existing()
  behavior = (child) => child.emit("error", new Error("CLI unavailable"))
  await expect(authorize()).rejects.toThrow("CLI unavailable")
  expect(homes()).toEqual([])
  released()
})

test("startup failure releases its new home and preserves the CLI diagnosis", async () => {
  existing()
  spawnLogin = () => { throw new Error("spawn denied") }
  await expect(authorize()).rejects.toThrow("spawn denied")
  expect(homes()).toEqual([])
  released()
})

test("cancelling while waiting for the link reaps the CLI before removing only its new home", async () => {
  existing()
  const c = new AbortController()
  const pending = authorize(c.signal)
  await drained()
  expect(homes()).toHaveLength(1)
  c.abort()
  await expect(pending).rejects.toThrow()
  expect(calls[0].child.kills).toEqual(["SIGKILL"])
  expect(homes()).toEqual([])
  expect(JSON.parse(readFileSync(join(cliHome, "auth.json"), "utf8"))).toEqual(theirs)
  released(c.signal)
})

test("a no-link timeout keeps the last CLI network diagnosis, with bounded output handling", async () => {
  existing()
  behavior = (child) => {
    for (let i = 0; i < 1024; i++) child.output("x".repeat(8192))
    child.output("\n\u001b[31mError: error sending request for url (https://auth.x.ai/oauth2/device/code): proxy refused\u001b[0m\n", true)
  }
  const pending = authorize()
  await drained()
  fire(30_000)
  await expect(pending).rejects.toThrow("Error: error sending request for url (https://auth.x.ai/oauth2/device/code): proxy refused")
  expect(homes()).toEqual([])
  released()
})

test("a silent failed CLI retains the reachability diagnostic and leaves an existing CLI home alone", async () => {
  behavior = (child) => child.close(1)
  await expect(authorize()).rejects.toThrow("can this machine reach auth.x.ai?")
  expect(existsSync(cliHome)).toBe(true)
  released()
})

test("a callback can cancel a running device login and retries start cleanly", async () => {
  existing()
  behavior = (child) => child.output(`${LINK}\n`)
  const a = await authorize()
  const c = new AbortController()
  const pending = a.callback(undefined, { signal: c.signal })
  c.abort()
  expect((await pending).type).toBe("failed")
  expect(homes()).toEqual([])
  released(c.signal)

  behavior = (child) => { child.output(`${LINK}\n`); complete(child) }
  const retry = await authorize()
  expect((await retry.callback()).type).toBe("success")
  expect(homes()).toHaveLength(1)
  released()
})

test("cancellation reaps the writer without waiting on a browser's inherited pipes", async () => {
  existing()
  behavior = (child) => child.output(`${LINK}\n`)
  const a = await authorize()
  const child = calls[0].child
  child.kill = (signal) => {
    child.kills.push(signal)
    queueMicrotask(() => { child.exited = true; children.delete(child); child.emit("exit", null, signal) })
    return true
  }
  const c = new AbortController()
  const pending = a.callback(undefined, { signal: c.signal })
  c.abort()
  expect((await pending).type).toBe("failed")
  expect(homes()).toEqual([])
  child.emit("close", null)
  released(c.signal)
})

test("callback cancellation interrupts torn-file retry timers as well as the device wait", async () => {
  existing()
  behavior = (child) => {
    child.output(`${LINK}\n`)
    writeFileSync(join(child.home, "auth.json"), "")
    child.close(0)
  }
  const a = await authorize()
  const c = new AbortController()
  const pending = a.callback(undefined, { signal: c.signal })
  await drained()
  expect([...timers.values()].some((t) => t.ms === 100)).toBe(true)
  c.abort()
  expect((await pending).type).toBe("failed")
  expect(homes()).toEqual([])
  released(c.signal)
})

test("an abandoned callback expires and cleans a successful but unsaved new home", async () => {
  existing()
  behavior = (child) => { child.output(`${LINK}\n`); complete(child) }
  const a = await authorize()
  expect(homes()).toHaveLength(1)
  fire(600_000)
  await drained()
  expect(homes()).toEqual([])
  expect((await a.callback()).type).toBe("failed")
  released()
})

test("the device deadline also stops a running callback, without deleting the CLI home", async () => {
  behavior = (child) => child.output(`${LINK}\n`)
  const a = await authorize()
  const pending = a.callback()
  fire(600_000)
  expect((await pending).type).toBe("failed")
  expect(calls[0].child.kills).toEqual(["SIGKILL"])
  expect(existsSync(cliHome)).toBe(true)
  released()
})

test("authorize cancellation remains active after the link, including before callback", async () => {
  existing()
  const c = new AbortController()
  behavior = (child) => { child.output(`${LINK}\n`); complete(child) }
  const a = await authorize(c.signal)
  c.abort()
  await drained()
  expect(homes()).toEqual([])
  expect((await a.callback()).type).toBe("failed")
  released(c.signal)
})

test("a successful email-less sign-in is saved once; a repeated or pre-aborted callback cannot delete it", async () => {
  existing()
  const c = new AbortController()
  const away = join(dir, "do-not-write-auth.json")
  process.env.GROK_AUTH_PATH = away
  behavior = (child) => { child.output(`${LINK}\n`); complete(child) }
  const a = await authorize(c.signal)
  const [r, repeated] = await Promise.all([a.callback(), a.callback()])
  expect(a.url).toBe(LINK)
  expect(a.opened).toBe(process.platform === "win32" || process.platform === "darwin")
  expect(r).toEqual(repeated)
  expect(r.accountId).toBe("u-1")
  expect(r.type).toBe("success")
  expect(calls[0].args).toEqual(["login", "--device-auth"])
  expect(calls[0].options.cwd).toBe(process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME)
  expect(calls[0].options.env.GROK_AUTH_PATH).toBeUndefined()
  if (!a.opened) expect(calls[0].options.env.BROWSER).toBe("true")
  expect(existsSync(away)).toBe(false)
  c.abort()
  expect(await a.callback(undefined, { signal: c.signal })).toEqual(r)
  expect(existsSync(join(r.refresh, "auth.json"))).toBe(true)
  expect(homes()).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(cliHome, "auth.json"), "utf8"))).toEqual(theirs)
  released(c.signal)
})

test("a pre-aborted first callback cleans its unsaved new home", async () => {
  existing()
  behavior = (child) => { child.output(`${LINK}\n`); complete(child) }
  const a = await authorize()
  const c = new AbortController()
  c.abort()
  expect((await a.callback(undefined, { signal: c.signal })).type).toBe("failed")
  expect(homes()).toEqual([])
  released(c.signal)
})

test("a failed CLI after printing a link cleans its home without waiting for a callback", async () => {
  existing()
  behavior = (child) => child.output(`${LINK}\n`)
  const a = await authorize()
  calls[0].child.output("device approval denied\n", true)
  calls[0].child.close(1)
  await drained()
  expect(homes()).toEqual([])
  expect(await a.callback()).toEqual({ type: "failed", error: "device approval denied" })
  released()
})

test("a token's subject identifies an X sign-in when email and user_id are absent", async () => {
  existing()
  const key = `e30.${Buffer.from(JSON.stringify({ sub: "u-sub", iss: "https://auth.x.ai" })).toString("base64url")}.sig`
  behavior = (child) => { child.output(`${LINK}\n`); complete(child, { [scope]: { key, email: null, expires_at: later } }) }
  const a = await authorize()
  expect((await a.callback()).accountId).toBe("u-sub")
  released()
})

test("a successful CLI that leaves no usable account preserves the existing file diagnostics", async () => {
  existing()
  behavior = (child) => { child.output(`${LINK}\n`); complete(child, { [scope]: { key: "tok", email: null, expires_at: later } }) }
  let a = await authorize()
  expect((await a.callback()).error).toContain("names no account")
  expect(homes()).toEqual([])
  released()

  behavior = (child) => { child.output(`${LINK}\n`); complete(child, null) }
  a = await authorize()
  expect((await a.callback()).error).toContain("left no sign-in where this plugin reads it")
  expect(homes()).toEqual([])
  released()

  behavior = (child) => { child.output(`${LINK}\n`); complete(child, { [scope]: { email: "g@x.ai" } }) }
  a = await authorize()
  expect((await a.callback()).error).toContain(`has ${scope}, none with a token`)
  expect(homes()).toEqual([])
  released()
})
