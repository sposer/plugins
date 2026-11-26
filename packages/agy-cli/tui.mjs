import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { terminalCredential, tokenFile } from "./account.mjs"
import { prepareTuiInput } from "./tui-input.mjs"

const SCRIPT = "/usr/bin/script"
const MAX_TRANSCRIPT = 32 * 1024 * 1024
const PASTE_ON = "\x1b[?2004h"
const READY = "? for shortcuts"
// AGY 1.5.18 measured under a second to readiness and to the submitted row.
// These bounds only end a terminal that never gets there.
const READY_TIMEOUT = 30_000
const SUBMIT_TIMEOUT = 30_000
// Primary device attributes, which AGY asks for at startup.
const DEVICE_QUERY = /\x1b\[0?c/g
const DEVICE_ANSWER = "\x1b[?62;c"
const BRIDGE_SERVER = "bridge"
const BRIDGE_AGENT = "magpie-tui-bridge"
const MCP_SERVER_PATH = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url))
const bridgeModelName = name => `mcp_${BRIDGE_SERVER}_${name}`
// Local action namespaces in https://antigravity.google/docs/permissions?tab=cli.
const DENY_LOCAL = ["read_file", "write_file", "read_url", "execute_url", "download_url", "command", "unsandboxed"]
  .map(action => `${action}(*)`)

function bridgeToolNames(mcp) {
  if (mcp === undefined) return []
  if (!Array.isArray(mcp?.tools) || !Number.isInteger(mcp.port) || mcp.port < 1 || mcp.port > 65535 ||
      typeof mcp.token !== "string" || !mcp.token) {
    throw tuiError("invalid TUI MCP configuration")
  }
  const names = mcp.tools.map(tool => tool?.name)
  // These names go inside individual permission selectors, never as patterns.
  if (names.some(name => typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name))) {
    throw tuiError("invalid TUI MCP tool name", 400)
  }
  return names
}

function tuiError(message, statusCode = 502) {
  return Object.assign(new Error(`agy bridge: ${message}`), { statusCode })
}

function cancelled() {
  return Object.assign(tuiError("the TUI turn was cancelled", 499), { name: "AbortError" })
}

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function setup(root, env, mcp, toolNames) {
  const home = path.join(root, "home")
  const cwd = path.join(root, "work")
  const cli = path.dirname(tokenFile(home))
  const cache = path.join(cli, "cache")
  await fs.mkdir(cwd, { mode: 0o700 })
  await fs.mkdir(cache, { recursive: true, mode: 0o700 })

  // Do not load settings, MCP, plugins or other state from the selected HOME.
  const credential = terminalCredential(env)
  if (credential && !credential.adc) {
    let token
    try { token = await fs.readFile(credential.file) } catch (err) {
      if (err.code !== "ENOENT") throw err
    }
    if (token) await fs.writeFile(tokenFile(home), token, { mode: 0o600 })
  }
  const write = (file, object) => fs.writeFile(file, JSON.stringify(object), { mode: 0o600 })
  // --settings in 1.5.18 does not accept strictMode. Trust only the empty
  // workspace created above; trusting it does not override the explicit denies.
  const bridge = toolNames.length > 0
  await write(path.join(cli, "settings.json"), {
    strictMode: true,
    trustedWorkspaces: [cwd],
    permissions: {
      allow: toolNames.map(name => `mcp(${BRIDGE_SERVER}/${name})`),
      ask: [],
      deny: bridge ? DENY_LOCAL : [...DENY_LOCAL, "mcp(*)"],
    },
  })
  if (bridge) {
    // Use the same stdio configuration written by `agy mcp add` in the private HOME.
    // The agent adds no local tools and inherits only this private MCP catalog.
    const config = path.join(path.dirname(cli), "config")
    const agent = path.join(cwd, ".agents", "agents", BRIDGE_AGENT)
    await fs.mkdir(config, { recursive: true, mode: 0o700 })
    await fs.mkdir(agent, { recursive: true, mode: 0o700 })
    await write(path.join(config, "mcp_config.json"), { mcpServers: {
      [BRIDGE_SERVER]: {
        command: process.execPath,
        args: [MCP_SERVER_PATH],
        env: { AGY_BRIDGE_CONTROL_PORT: String(mcp.port), AGY_BRIDGE_TOKEN: mcp.token },
      },
    } })
    await fs.writeFile(path.join(agent, "agent.md"), [
      "---",
      `name: ${BRIDGE_AGENT}`,
      "description: Bridges only client-declared tools",
      "mainAgent: true",
      "subagent: false",
      "tools: []",
      "inheritMcp: true",
      "inheritCustomizations: false",
      "excludeDefaultComponents: true",
      "---",
      "Use only the client MCP tools for tool calls.",
      "",
    ].join("\n"), { mode: 0o600 })
  }
  // Local UI state for an already configured gateway account. Do not send
  // wizard keystrokes (which can also toggle the default data-use checkbox).
  await write(path.join(cache, "onboarding.json"), {
    consumerOnboardingComplete: true, enterpriseOnboardingComplete: true, onboardingComplete: true,
  })

  const local = {
    ...env,
    HOME: home,
    ...(credential?.adc ? { GOOGLE_APPLICATION_CREDENTIALS: credential.file } : {}),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    NO_COLOR: undefined,
    AGY_CLI_DISABLE_AUTO_UPDATE: env.AGY_CLI_DISABLE_AUTO_UPDATE ?? "true",
    AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "true",
    SSH_CONNECTION: env.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 0",
  }
  for (const name of ["ANTIGRAVITY_GEMINI_DIR", "ANTIGRAVITY_CONFIG_REL_DIR",
    "ANTIGRAVITY_APP_DATA_DIR", "ANTIGRAVITY_EXECUTABLE_DATA_DIR", "ANTIGRAVITY_PROJECT_ID",
    "AGY_CLI_INTERACTIVE_HEADLESS", "AGY_CLI_NONINTERACTIVE_HEADLESS", "AGY_CLI_OSC7501_MESSAGES"]) delete local[name]
  return { cwd, env: local, brain: path.join(cli, "brain") }
}

function reportedFailure(screen) {
  // Match the UI's own error banner, not arbitrary words in model output.
  const failure = /\x1b\[31m⚠ (?:agent executor error|Error:)[^\r\n]*(?=[\r\n])/i.exec(screen)?.[0]
  if (!failure) return null
  const status = Number(/\bError (4\d\d|5\d\d)\b/i.exec(failure)?.[1])
  return tuiError("the native TUI turn failed", status || 502)
}

const tokens = (row, key) => Number.isSafeInteger(row[key]) && row[key] >= 0 ? row[key] : 0

// decision: read completed native transcript rows; not PTY repaint bytes
// because edits and wrapping are not append-only model text. Revisit when AGY
// exposes reply deltas before step completion (docs/decisions/001-native-agy-tool-routing.md).
// Reads the rows AGY appends for the submitted turn, from the last read offset.
class Transcript {
  #brain
  #file
  #offset = 0
  #decoder = new StringDecoder("utf8")
  // A partially written last row is not part of the turn yet.
  #carry = ""
  #requestPrefix
  #expandedPrefix
  #allowedToolCalls
  #reply

  constructor(brain, prompt, allowedToolCalls) {
    this.#brain = brain
    this.#requestPrefix = `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>`
    // In 1.5.18 the TUI can expand pasted tabs to four spaces on short inputs.
    this.#expandedPrefix = this.#requestPrefix.replaceAll("\t", "    ")
    this.#allowedToolCalls = allowedToolCalls
    this.#reset()
  }

  #reset() {
    this.#offset = 0
    this.#decoder = new StringDecoder("utf8")
    this.#carry = ""
    this.#reply = undefined
    this.submitted = false
    this.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, steps: 0, toolCalls: 0 }
  }

  // Returns whether new rows were read.
  async read() {
    try {
      if (!this.#file) {
        const dirs = (await fs.readdir(this.#brain, { withFileTypes: true })).filter(entry => entry.isDirectory() &&
          /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(entry.name))
        if (!dirs.length) return false
        if (dirs.length !== 1) throw tuiError("more than one native TUI conversation was created")
        this.#file = path.join(this.#brain, dirs[0].name, ".system_generated", "logs", "transcript_full.jsonl")
      }
      const stat = await fs.stat(this.#file)
      if (!stat.isFile() || stat.size > MAX_TRANSCRIPT) throw tuiError("the native TUI transcript is too large or invalid")
      // AGY appends rows. A shorter file was rewritten, so read it again from the start.
      if (stat.size < this.#offset) this.#reset()
      if (stat.size === this.#offset) return false
      const handle = await fs.open(this.#file, "r")
      let read
      try {
        const buffer = Buffer.alloc(stat.size - this.#offset)
        read = (await handle.read(buffer, 0, buffer.length, this.#offset)).bytesRead
        this.#offset += read
        this.#feed(this.#decoder.write(buffer.subarray(0, read)))
      } finally {
        await handle.close()
      }
      return read > 0
    } catch (err) {
      if (err.code !== "ENOENT") throw err
      return false
    }
  }

  #feed(text) {
    const lines = (this.#carry + text).split("\n")
    this.#carry = lines.pop()
    for (const line of lines) if (line) this.#row(JSON.parse(line))
  }

  #row(row) {
    if (row.type === "USER_INPUT") {
      const content = typeof row.content === "string" ? row.content : ""
      const matches = content.startsWith(this.#requestPrefix) || (this.#expandedPrefix !== this.#requestPrefix &&
        content.replaceAll("\t", "    ").startsWith(this.#expandedPrefix))
      if (this.submitted || row.source !== "USER_EXPLICIT" || row.status !== "DONE" || !matches) {
        throw tuiError("the native TUI transcript did not match the submitted turn")
      }
      this.submitted = true
      return
    }
    if (!this.submitted) return
    if (row.error || /^(?:ERROR|FAILED|INVALID|CANCEL(?:L?ED)|ABORTED)$/.test(row.status) || row.type === "ERROR") {
      throw tuiError("the native TUI turn failed")
    }
    const planner = row.type === "PLANNER_RESPONSE" && row.source === "MODEL" && row.status === "DONE"
    if (planner) {
      // Every completed planner step carries the tokens of its own model call.
      this.usage.inputTokens += tokens(row, "input_tokens")
      this.usage.outputTokens += tokens(row, "output_tokens")
      this.usage.cacheReadTokens += tokens(row, "cache_read_tokens")
      this.usage.steps++
    }
    if (row.tool_calls?.length) {
      if (!this.#allowedToolCalls.size) throw tuiError("the native TUI requested a tool in text-only mode")
      if (!planner || !Array.isArray(row.tool_calls) || !row.tool_calls.every(call => this.#allowedToolCalls.has(call?.name))) {
        throw tuiError("the native TUI requested an unapproved tool")
      }
      // One step can request several calls; AGY then sends them to MCP one at a time.
      this.usage.toolCalls += row.tool_calls.length
      // DONE refers to the planner step, not the turn. The MCP request may still be waiting.
      this.#reply = undefined
      return
    }
    if (!planner || typeof row.content !== "string" || !row.content.trim()) return
    this.#reply = { text: row.content, thinking: typeof row.thinking === "string" ? row.thinking : "" }
  }

  // The completed reply with the token totals of every step in the turn.
  result() {
    if (this.#carry || !this.#reply) return undefined
    const { inputTokens, outputTokens, cacheReadTokens } = this.usage
    return { ...this.#reply, inputTokens, outputTokens, cacheReadTokens }
  }
}

function launch(agyPath, model, effort, local, pidFile, bridge) {
  // decision: use native default mode with explicit denies; not plan because
  // agy rewrites the prompt as /plan and injects planning/artifact instructions.
  const args = [agyPath, "--model", model, "--log-file", "/dev/null"]
  if (bridge) args.push("--agent", BRIDGE_AGENT)
  if (effort) args.push("--effort", effort)
  // util-linux script creates a second session whose leader is its command
  // shell. exec preserves that PID and lets cleanup signal the entire PTY group.
  const command = `printf '%s' "$$" > ${quote(pidFile)} && exec ${args.map(quote).join(" ")}`
  return spawn(SCRIPT, ["-q", "-e", "-E", "never", "-c", command, "/dev/null"], {
    ...local, stdio: ["pipe", "pipe", "ignore"],
  })
}

async function waitClosed(closed, ms) {
  const timer = new AbortController()
  try { return await Promise.race([closed.then(() => true), delay(ms, false, { signal: timer.signal })]) }
  finally { timer.abort() }
}

async function stop(child, closed, pidFile) {
  async function signalGroup(signal) {
    try {
      const pid = Number(await fs.readFile(pidFile, "utf8"))
      if (Number.isSafeInteger(pid) && pid > 1) {
        process.kill(-pid, signal)
        return true
      }
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "ESRCH") throw err
    }
    return false
  }
  if (!await signalGroup("SIGTERM")) child.kill("SIGTERM")
  await waitClosed(closed, 500)
  await signalGroup("SIGKILL")
  if (!await waitClosed(closed, 500)) {
    child.kill("SIGKILL")
    await closed
  }
  child.stdin.destroy()
}

// timeoutMs bounds the time a submitted turn may go without a new transcript
// row; startup has its own shorter bounds. observer.waiting() is true while the
// bridge holds one of this turn's tool calls for the client, which is not a
// lack of progress. observer.progress receives the turn's token totals and call
// count after new rows, and observer.phase the "ready" and "submitted" milestones.
export async function runTui(agyPath, {
  prompt, parts, model, effort, signal, timeoutMs = 120_000, env = {}, mcp, observer = {},
}) {
  if (signal?.aborted) throw cancelled()
  if (process.platform !== "linux") throw tuiError("TUI mode requires Linux and util-linux script", 503)
  if (typeof model !== "string" || !model || typeof agyPath !== "string" || !agyPath) {
    throw tuiError("TUI mode requires an agy executable and model", 400)
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw tuiError("invalid TUI timeout", 400)
  const toolNames = bridgeToolNames(mcp)
  const allowedToolCalls = new Set(toolNames.map(bridgeModelName))
  let root, child, closed
  const wake = new AbortController()
  const abort = () => wake.abort()
  signal?.addEventListener("abort", abort, { once: true })
  let problem
  let phase = "ready"
  let deadline
  const limit = ms => { deadline = performance.now() + ms }
  const pty = { chars: 0, pasteMode: false, deviceQueries: 0 }
  const expired = () => Object.assign(tuiError({
    ready: "the native TUI did not become ready",
    submit: "the native TUI did not accept the prompt",
    turn: "the native TUI turn made no progress",
  }[phase], 504), phase === "ready" ? { detail: { ...pty } } : {})
  const check = () => {
    if (signal?.aborted) throw cancelled()
    if (problem) throw problem
    if (performance.now() >= deadline) throw expired()
  }
  const sleep = async ms => {
    try { await delay(Math.max(0, Math.min(ms, deadline - performance.now())), undefined, { signal: wake.signal }) }
    catch (err) { if (err.name !== "AbortError") throw err }
  }
  const pause = async ms => {
    await sleep(ms)
    check()
  }
  limit(Math.min(READY_TIMEOUT, timeoutMs))
  try {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "magpie-agy-tui-"))
    const local = await setup(root, env, mcp, toolNames)
    const input = await prepareTuiInput(root, { prompt, parts, env: local.env })
    const text = input.expectedPrompt
    local.env = input.env
    const pidFile = path.join(root, "pty.pid")
    check()
    child = launch(path.resolve(agyPath), model, effort, local, pidFile, toolNames.length > 0)
    closed = new Promise(resolve => child.once("close", resolve))
    child.once("error", () => { problem ||= tuiError("could not launch the native TUI or util-linux script", 503); abort() })
    child.once("close", () => { problem ||= tuiError("the native TUI exited before a complete turn"); abort() })
    child.stdin.on("error", () => { problem ||= tuiError("could not send input to the native TUI"); abort() })
    let ready = false
    let screen = ""
    // decision: answer the startup device-attributes query as a terminal does;
    // not leave it unanswered because AGY 1.5.18 reached readiness sooner with
    // the answer. Answers stop before the paste so they never land in the prompt.
    // Its other startup queries stay unanswered, so AGY keeps the legacy key
    // encoding that the paste and Enter use.
    let answering = true
    let queryTail = ""
    child.stdout.setEncoding("utf8").on("data", chunk => {
      pty.chars += chunk.length
      if (answering) {
        const scan = queryTail + chunk
        let end = 0
        for (const match of scan.matchAll(DEVICE_QUERY)) {
          pty.deviceQueries++
          child.stdin.write(DEVICE_ANSWER)
          end = match.index + match[0].length
        }
        // A query split across chunks is at most three characters long so far.
        queryTail = scan.slice(Math.max(end, scan.length - 3))
      }
      screen = (screen + chunk).slice(-8192)
      pty.pasteMode ||= screen.includes(PASTE_ON)
      if (!ready && pty.pasteMode && screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes(READY)) ready = true
      const failure = reportedFailure(screen)
      if (failure) { problem ||= failure; abort() }
    })
    while (!ready) await pause(35)
    check()
    observer.phase?.("ready")
    phase = "submit"
    // Each image attachment has its own bound inside the paste.
    limit(timeoutMs)
    answering = false
    // decision: paste via stdin, not --prompt-interactive because argv exposes
    // gateway prompts to other processes running as the same user.
    await input.paste(child.stdin, pause, () => screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""))
    limit(Math.min(SUBMIT_TIMEOUT, timeoutMs))
    const transcript = new Transcript(local.brain, text, allowedToolCalls)
    for (;;) {
      await transcript.read()
      check()
      if (transcript.submitted) break
      await pause(75)
    }
    observer.phase?.("submitted")
    phase = "turn"
    limit(timeoutMs)
    observer.progress?.({ ...transcript.usage })
    for (;;) {
      const result = transcript.result()
      if (result) return result
      await sleep(75)
      if (observer.waiting?.()) limit(timeoutMs)
      // Read before checking the bound, so a row written just before it counts.
      if (await transcript.read()) {
        limit(timeoutMs)
        observer.progress?.({ ...transcript.usage })
      }
      check()
    }
  } catch (err) {
    // Do not forward native output, filesystem paths, or arbitrary signal reasons.
    if (err instanceof Error && Number.isInteger(err.statusCode)) throw Object.assign(err, { phase: err.phase ?? phase })
    throw Object.assign(tuiError("could not run or read the native TUI"), { phase })
  } finally {
    signal?.removeEventListener("abort", abort)
    try {
      if (child) await stop(child, closed, path.join(root, "pty.pid"))
      if (signal?.aborted) throw cancelled()
    } finally {
      if (root) await fs.rm(root, { force: true, recursive: true }).catch(() => {
        throw tuiError("could not clean up the private TUI directory")
      })
    }
  }
}
