// Load the real bridge in isolation. Only the native launcher, child commands
// and the loopback transport are substituted; requests and control messages
// still reach the public fetch path and the real control connection handler.
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import vm from "node:vm"

const require = createRequire(import.meta.url)
const INDEX_URL = new URL("../index.mjs", import.meta.url)
const RUNTIME = "agy-testkit:runtime"
const RUNTIME_NAMES = ["Date", "setTimeout", "clearTimeout", "process"]
const PRELUDE = `import { ${RUNTIME_NAMES.join(", ")} } from "${RUNTIME}";\n`

if (typeof vm.SourceTextModule !== "function") {
  const child = spawnSync(process.execPath, [...process.execArgv, "--experimental-vm-modules", ...process.argv.slice(1)], { stdio: "inherit" })
  if (child.error) throw child.error
  process.exit(child.status ?? 1)
}

export const MESSAGES_URL = "agy://local/v1/messages"
export const COUNT_TOKENS_URL = "agy://local/v1/messages/count_tokens"
export const tick = () => new Promise(resolve => setImmediate(resolve))
export const modelsOutput = rows => rows.map(([id, name]) => `${id}  ${name}`).join("\n") + "\n"

function createTimers() {
  const live = new Set()
  return {
    setTimeout(fn, ms, ...args) {
      const timer = setTimeout(() => { live.delete(timer); fn(...args) }, ms)
      live.add(timer)
      return timer
    },
    clearTimeout(timer) {
      live.delete(timer)
      clearTimeout(timer)
    },
    refed: () => [...live].filter(timer => timer.hasRef()),
    clear() {
      for (const timer of live) clearTimeout(timer)
      live.clear()
    },
  }
}

class Command extends EventEmitter {
  constructor(children, behavior) {
    super()
    this.children = children
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.exitCode = null
    this.signalCode = null
    children.add(this)
    if (!behavior.hang) {
      const deliver = () => {
        if (!children.has(this)) return
        if (behavior.error) {
          children.delete(this)
          this.emit("error", new Error("fixture child error"))
          return
        }
        if (behavior.stdout) this.stdout.emit("data", behavior.stdout)
        if (behavior.stderr) this.stderr.emit("data", behavior.stderr)
        this.finish(behavior.code ?? 0, null)
      }
      this.delivery = behavior.delayMs ? setTimeout(deliver, behavior.delayMs) : setImmediate(deliver)
    }
  }

  finish(code, signal) {
    if (!this.children.delete(this)) return
    clearImmediate(this.delivery)
    clearTimeout(this.delivery)
    this.exitCode = code
    this.signalCode = signal
    setImmediate(() => this.emit("close", code, signal))
  }

  kill(signal = "SIGTERM") {
    this.finish(null, signal)
    return true
  }
}

class ControlSocket extends EventEmitter {
  writable = true
  reply = new Promise(resolve => { this.resolveReply = resolve })

  setEncoding() { return this }

  end(data) {
    if (!this.writable) return
    this.writable = false
    this.resolveReply(data ? JSON.parse(data) : null)
    setImmediate(() => this.emit("close"))
  }

  destroy() { this.end() }
}

function synthetic(exports, identifier) {
  const names = Object.keys(exports).filter(name => /^[A-Za-z_$][\w$]*$/.test(name))
  return new vm.SyntheticModule(names, function init() {
    for (const name of names) this.setExport(name, exports[name])
  }, { identifier })
}

export async function createBridgeKit(options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bridge-test-"))
  const home = path.join(tmp, "home")
  const bin = path.join(tmp, "empty-bin")
  fs.mkdirSync(home)
  fs.mkdirSync(bin)
  function makeFakeAgy(name) {
    const dir = path.join(tmp, "agy-bin", name)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, process.platform === "win32" ? "agy.exe" : "agy")
    // The fake spawn never executes this file.
    fs.writeFileSync(file, "", { mode: 0o755 })
    return file
  }
  const agyPath = makeFakeAgy("agy-a")
  const env = {
    PATH: bin,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(tmp, "localappdata"),
    XDG_STATE_HOME: path.join(tmp, "state"),
    ...(options.agyPath === null ? {} : { AGY_PATH: agyPath }),
    ...(options.storedSignIn === undefined ? { AGY_BRIDGE_STORED_SIGNIN: "skip" } : {}),
    ...options.env,
  }
  let now = Date.UTC(2026, 10, 4, 12)
  const RealDate = Date
  class FakeDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  const timers = createTimers()
  const children = new Set()
  const unexpected = []
  const sockets = new Set()
  const listeners = []
  let controlHandler
  const kit = {
    tmp, home, agyPath, makeFakeAgy, env, children, timers,
    advance(ms) { now += ms },
    modelsSpawns: [], helpSpawns: [], tuiRuns: [],
    modelsBehavior: options.modelsBehavior ?? { stdout: "gemini-4-argon-high  Gemini 4 Argon (High)\n" },
  }
  // Keep per-instance process environment and platform, including child
  // options built by account.mjs. Direct process listeners are cleaned up.
  const fakeProcess = new Proxy(process, {
    get(target, property) {
      if (property === "env") return env
      if (property === "platform") return options.platform ?? "linux"
      if (property === "on" || property === "once") return (event, listener) => {
        listeners.push([event, listener])
        return target[property](event, listener)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const unexpectedCommand = (file, args) => {
    unexpected.push({ file, args })
    throw new Error(`unexpected child command: ${file} ${args.join(" ")}`)
  }
  const overrides = {
    "node:child_process": {
      spawn(file, args = [], opts = {}) {
        const call = { file, args, env: opts.env, opts }
        if (file === "/usr/bin/script" && options.onTuiLaunch) {
          options.onTuiLaunch(args)
          throw new Error("fixture stops before opening a PTY")
        }
        if (args[0] === "--help") {
          kit.helpSpawns.push(call)
          return new Command(children, { stderr: options.topHelp })
        }
        const subcommand = args[0] === "--settings" ? args[2] : args[0]
        if (subcommand !== "models") return unexpectedCommand(file, args)
        kit.modelsSpawns.push(call)
        const behavior = typeof kit.modelsBehavior === "function" ? kit.modelsBehavior(call) : kit.modelsBehavior
        return new Command(children, behavior)
      },
      spawnSync: unexpectedCommand,
      // Never query the host keyring.
      execFile(_file, _args, opts, callback) {
        if (typeof opts === "function") callback = opts
        const stored = options.storedSignIn
        setImmediate(() => stored === "missing" || stored === undefined
          ? callback(Object.assign(new Error("not found (fixture)"), { code: 44 }), "", "")
          : callback(null, stored, ""))
      },
    },
    "node:os": { homedir: () => home, tmpdir: () => tmp },
    "node:net": {
      createServer(handler) {
        controlHandler = handler
        return {
          once() { return this },
          listen(_port, _host, ready) { setImmediate(ready); return this },
          unref() { return this },
          close() {},
          address: () => ({ address: "127.0.0.1", port: 45999 }),
        }
      },
    },
  }
  const cache = new Map([
    [RUNTIME, synthetic({ Date: FakeDate, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, process: fakeProcess }, RUNTIME)],
  ])
  if (!options.onTuiLaunch) {
    cache.set(new URL("../tui.mjs", import.meta.url).href, synthetic({ runTui(file, args) {
      kit.tuiRuns.push({ file, ...args })
      if (!options.runTui) throw new Error("unexpected native TUI launch")
      return options.runTui(file, args)
    } }, "fixture-tui"))
  }
  function moduleAt(key) {
    if (cache.has(key)) return cache.get(key)
    let module
    if (key.startsWith("file:")) {
      module = new vm.SourceTextModule(PRELUDE + fs.readFileSync(new URL(key), "utf8"), {
        identifier: key,
        initializeImportMeta(meta) { meta.url = key },
      })
    } else {
      const real = require(key)
      const exports = { ...real, ...overrides[key] }
      exports.default = overrides[key] ? { ...(real.default ?? real), ...overrides[key] } : (real.default ?? real)
      module = synthetic(exports, key)
    }
    cache.set(key, module)
    return module
  }
  kit.finishChildren = async () => {
    for (const child of children) child.kill("SIGKILL")
    await tick()
  }
  kit.dispose = async () => {
    for (const socket of sockets) socket.destroy()
    await kit.finishChildren()
    for (const [event, listener] of listeners) process.removeListener(event, listener)
    timers.clear()
    fs.rmSync(tmp, { recursive: true, force: true })
    assert.deepEqual(unexpected, [], "only native catalog commands may be spawned")
  }
  try {
    const root = moduleAt(INDEX_URL.href)
    await root.link((specifier, ref) => moduleAt(specifier.startsWith(".") ? new URL(specifier, ref.identifier).href : specifier))
    await root.evaluate()
    kit.plugin = await root.namespace.AntigravityBridgePlugin()
    const loader = await kit.plugin.auth.loader()
    kit.models = ctx => kit.plugin.provider.models(undefined, ctx)
    kit.fetch = (input, init) => loader.fetch(input, init)
    kit.request = (body, init = {}) => kit.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(body), ...init })
    kit.control = message => {
      assert.ok(controlHandler, "the bridge must open its tool control server")
      const socket = new ControlSocket()
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
      controlHandler(socket)
      socket.emit("data", JSON.stringify(message) + "\n")
      return socket.reply
    }
    return kit
  } catch (error) {
    await kit.dispose()
    throw error
  }
}

export async function readSse(response) {
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  const blocks = new Map()
  const content = []
  let usage, stopReason
  for (const frame of (await response.text()).split("\n\n")) {
    const lines = frame.split("\n")
    const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim()
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n")
    if (!data) continue
    const value = JSON.parse(data)
    if (event === "content_block_start") blocks.set(value.index, { ...value.content_block, json: "" })
    if (event === "content_block_delta") {
      const block = blocks.get(value.index)
      const delta = value.delta
      if (delta.type === "text_delta") block.text += delta.text
      if (delta.type === "thinking_delta") block.thinking += delta.thinking
      if (delta.type === "signature_delta") block.signature = delta.signature
      if (delta.type === "input_json_delta") block.json += delta.partial_json
    }
    if (event === "content_block_stop") {
      const block = blocks.get(value.index)
      if (block.type === "tool_use") block.input = block.json ? JSON.parse(block.json) : {}
      delete block.json
      blocks.delete(value.index)
      content.push(block)
    }
    if (event === "message_delta") {
      usage = value.usage
      stopReason = value.delta?.stop_reason
    }
    if (event === "error") throw new Error(`SSE error: ${JSON.stringify(value.error)}`)
  }
  return { content, stopReason, usage }
}

export function baseBody(overrides = {}) {
  return {
    model: "agy-cli/gemini-4-argon[1m]",
    max_tokens: 4096,
    stream: true,
    messages: [{ role: "user", content: "start the task" }],
    tools: [{ name: "Read", description: "Read a file.", input_schema: {
      type: "object", properties: { path: { type: "string" } }, required: ["path"],
    } }],
    ...overrides,
  }
}
