import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { tokenFile } from "./account.mjs"

const SCRIPT = "/usr/bin/script"
const MAX_TRANSCRIPT = 32 * 1024 * 1024
const PASTE_ON = "\x1b[?2004h"
const READY = "? for shortcuts"
// All action namespaces in https://antigravity.google/docs/permissions?tab=cli.
const DENY = ["read_file", "write_file", "read_url", "execute_url", "download_url", "command", "unsandboxed", "mcp"]
  .map(action => `${action}(*)`)

function tuiError(message, statusCode = 502) {
  return Object.assign(new Error(`agy bridge: ${message}`), { statusCode })
}

function cancelled() {
  return Object.assign(tuiError("the TUI turn was cancelled", 499), { name: "AbortError" })
}

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function setup(root, env) {
  const home = path.join(root, "home")
  const cwd = path.join(root, "work")
  const cli = path.dirname(tokenFile(home))
  const cache = path.join(cli, "cache")
  await fs.mkdir(cwd, { mode: 0o700 })
  await fs.mkdir(cache, { recursive: true, mode: 0o700 })

  // With native ADC, leave the original explicit credential path in env. Do
  // not load settings, MCP, plugins or other state from the selected HOME.
  if (env.HOME && !(env.AGY_ADC_AUTH === "true" && env.GOOGLE_APPLICATION_CREDENTIALS)) {
    let token
    try { token = await fs.readFile(tokenFile(env.HOME)) } catch (err) {
      if (err.code !== "ENOENT") throw err
    }
    if (token) await fs.writeFile(tokenFile(home), token, { mode: 0o600 })
  }
  const write = (file, object) => fs.writeFile(file, JSON.stringify(object), { mode: 0o600 })
  // --settings in 1.5.18 does not accept strictMode. Trust only the empty
  // workspace created above; trusting it does not override the explicit denies.
  await write(path.join(cli, "settings.json"), {
    strictMode: true,
    trustedWorkspaces: [cwd],
    permissions: { allow: [], ask: [], deny: DENY },
  })
  // Local UI state for an already configured gateway account. Do not send
  // wizard keystrokes (which can also toggle the default data-use checkbox).
  await write(path.join(cache, "onboarding.json"), {
    consumerOnboardingComplete: true, enterpriseOnboardingComplete: true, onboardingComplete: true,
  })

  const local = {
    ...env,
    HOME: home,
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

function parseTranscript(serialized, prompt) {
  let input = false
  let result
  const requestPrefix = `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>`
  // In 1.5.18 the TUI can expand pasted tabs to four spaces on short inputs.
  const expandedPrefix = requestPrefix.replaceAll("\t", "    ")
  // Writes are line-delimited. A partially written last row is not a result.
  const lines = serialized.split("\n")
  const partial = lines.pop()
  for (const line of lines) {
    if (!line) continue
    const row = JSON.parse(line)
    if (row.type === "USER_INPUT") {
      const content = typeof row.content === "string" ? row.content : ""
      const matches = content.startsWith(requestPrefix) || (expandedPrefix !== requestPrefix &&
        content.replaceAll("\t", "    ").startsWith(expandedPrefix))
      if (input || row.source !== "USER_EXPLICIT" || row.status !== "DONE" || !matches) {
        throw tuiError("the native TUI transcript did not match the submitted turn")
      }
      input = true
      continue
    }
    if (!input) continue
    if (row.error || /^(?:ERROR|FAILED|INVALID|CANCEL(?:L?ED)|ABORTED)$/.test(row.status) || row.type === "ERROR") {
      throw tuiError("the native TUI turn failed")
    }
    if (row.tool_calls?.length) throw tuiError("the native TUI requested a tool in text-only mode")
    if (row.type !== "PLANNER_RESPONSE" || row.source !== "MODEL" || row.status !== "DONE") continue
    if (typeof row.content !== "string" || !row.content.trim()) continue
    const count = key => Number.isSafeInteger(row[key]) && row[key] >= 0 ? row[key] : 0
    result = {
      text: row.content,
      thinking: typeof row.thinking === "string" ? row.thinking : "",
      inputTokens: count("input_tokens"),
      outputTokens: count("output_tokens"),
      cacheReadTokens: count("cache_read_tokens"),
    }
  }
  return partial ? undefined : result
}

function transcriptReader(brain, prompt) {
  let file, previousSize, previousTime
  return async () => {
    try {
      if (!file) {
        const dirs = (await fs.readdir(brain, { withFileTypes: true })).filter(entry => entry.isDirectory() &&
          /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(entry.name))
        if (!dirs.length) return
        if (dirs.length !== 1) throw tuiError("more than one native TUI conversation was created")
        file = path.join(brain, dirs[0].name, ".system_generated", "logs", "transcript_full.jsonl")
      }
      const stat = await fs.stat(file)
      if (!stat.isFile() || stat.size > MAX_TRANSCRIPT) throw tuiError("the native TUI transcript is too large or invalid")
      if (stat.size === previousSize && stat.mtimeMs === previousTime) return
      const bytes = await fs.readFile(file, "utf8")
      if (Buffer.byteLength(bytes) > MAX_TRANSCRIPT) throw tuiError("the native TUI transcript is too large")
      previousSize = stat.size
      previousTime = stat.mtimeMs
      return parseTranscript(bytes, prompt)
    } catch (err) {
      if (err.code !== "ENOENT") throw err
    }
  }
}

function launch(agyPath, model, effort, local, pidFile) {
  // decision: use native default mode with explicit denies; not plan because
  // agy rewrites the prompt as /plan and injects planning/artifact instructions.
  const args = [agyPath, "--model", model, "--log-file", "/dev/null"]
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

export async function runTui(agyPath, { prompt, model, effort, signal, timeoutMs = 120_000, env = {} }) {
  if (signal?.aborted) throw cancelled()
  if (process.platform !== "linux") throw tuiError("TUI mode requires Linux and util-linux script", 503)
  if (typeof prompt !== "string") throw tuiError("TUI mode requires a text prompt", 400)
  prompt = prompt.replace(/\r\n?/g, "\n").trim()
  // Only literal text enters the editor. Keys/escape sequences and the TUI's
  // slash-command and shell entrypoints are not part of this runner's input.
  if (!prompt || /^[!/]/.test(prompt) || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(prompt)) {
    throw tuiError("the prompt is not supported as literal TUI input", 400)
  }
  if (typeof model !== "string" || !model || typeof agyPath !== "string" || !agyPath) {
    throw tuiError("TUI mode requires an agy executable and model", 400)
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw tuiError("invalid TUI timeout", 400)
  const deadline = performance.now() + timeoutMs
  let root, child, closed
  const wake = new AbortController()
  const abort = () => wake.abort()
  signal?.addEventListener("abort", abort, { once: true })
  let problem
  const check = () => {
    if (signal?.aborted) throw cancelled()
    if (problem) throw problem
    if (performance.now() >= deadline) throw tuiError("the TUI turn timed out", 504)
  }
  const pause = async ms => {
    try { await delay(Math.max(0, Math.min(ms, deadline - performance.now())), undefined, { signal: wake.signal }) }
    catch (err) { if (err.name !== "AbortError") throw err }
    check()
  }
  try {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "magpie-agy-tui-"))
    const local = await setup(root, env)
    const pidFile = path.join(root, "pty.pid")
    check()
    child = launch(path.resolve(agyPath), model, effort, local, pidFile)
    closed = new Promise(resolve => child.once("close", resolve))
    child.once("error", () => { problem ||= tuiError("could not launch the native TUI or util-linux script", 503); abort() })
    child.once("close", () => { problem ||= tuiError("the native TUI exited before a complete turn"); abort() })
    child.stdin.on("error", () => { problem ||= tuiError("could not send input to the native TUI"); abort() })
    let ready = false
    let pasteEnabled = false
    let screen = ""
    child.stdout.setEncoding("utf8").on("data", chunk => {
      screen = (screen + chunk).slice(-8192)
      pasteEnabled ||= screen.includes(PASTE_ON)
      if (!ready && pasteEnabled && screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes(READY)) ready = true
      const failure = reportedFailure(screen)
      if (failure) { problem ||= failure; abort() }
    })
    while (!ready) await pause(35)
    check()
    // decision: paste via stdin, not --prompt-interactive because argv exposes
    // gateway prompts to other processes running as the same user.
    child.stdin.write(`\x1b[200~${prompt}\x1b[201~`)
    await pause(35)
    child.stdin.write("\r")
    const read = transcriptReader(local.brain, prompt)
    for (;;) {
      check()
      const result = await read()
      check()
      if (result) return result
      await pause(75)
    }
  } catch (err) {
    // Do not forward native output, filesystem paths, or arbitrary signal reasons.
    if (err instanceof Error && Number.isInteger(err.statusCode)) throw err
    throw tuiError("could not run or read the native TUI")
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
