import fs from "node:fs"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { stripVTControlCharacters } from "node:util"
import { currentHome, tokenFile } from "./account.mjs"
import { childEnv } from "./platform.mjs"
import { parseStored } from "./signin.mjs"

export const LOGIN_WAIT_MS = 15 * 60 * 1000
export const LOGIN_START_MS = 30_000
export const LOGIN_FINISH_MS = 60_000
const GOOGLE_MENU = "> 1. Google OAuth"
const CODE_FIELD = "authorization code..."
const OSC_LINK = /\x1b\]8;[^;\x1b\x07]*;(https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s\x1b\x07]+)(?:\x07|\x1b\\)/
const OSC = /\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g
const OUTPUT_CHARS = 16 * 1024
let pending = null

// One owner for native and configured login attempts: replacement, cancellation,
// deadlines and single submission. onFailure releases only the unfinished home.
export class LoginAttempt {
  constructor({ signal, onFailure, waitMs = LOGIN_WAIT_MS } = {}) {
    pending?.cancel("another sign-in was started; use its new link")
    this.controller = new AbortController()
    this.onFailure = onFailure
    this.signal = signal
    this.timers = new Set()
    this.done = new Promise(resolve => { this.resolve = resolve })
    this.onAbort = () => this.cancel("the sign-in was cancelled")
    pending = this
    signal?.addEventListener("abort", this.onAbort, { once: true })
    this.timer(() => this.cancel("the sign-in link expired; start the sign-in again"), waitMs).unref?.()
    if (signal?.aborted) this.onAbort()
  }

  timer(fn, ms) {
    const timer = setTimeout(fn, ms)
    this.timers.add(timer)
    return timer
  }

  end(value) {
    if (this.result) return
    this.result = value
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.signal?.removeEventListener("abort", this.onAbort)
    if (pending === this) pending = null
    const finish = () => {
      if (value.error) this.onFailure?.()
      this.resolve(value)
      this.onEnd?.(value)
    }
    if (value.error) {
      this.controller.abort()
      const stopping = this.onStop?.()
      if (stopping) {
        stopping.then(finish, finish)
        return
      }
    }
    finish()
  }

  cancel(error) { this.end({ error }) }

  async submit(work, { signal, finishMs = LOGIN_FINISH_MS } = {}) {
    if (this.result) return this.result.error ? this.done : { error: "this sign-in is over; start it again" }
    if (this.submitted) return { error: "this sign-in is already checking a code" }
    this.submitted = true
    const cancel = () => this.cancel("the sign-in was cancelled")
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) cancel()
    if (!this.result) {
      this.timer(() => this.cancel("the sign-in didn't finish in time; start it again"), finishMs)
      try {
        Promise.resolve(work(this.controller.signal)).then(value => this.end(value), error => this.cancel(error.message))
      } catch (error) { this.cancel(error.message) }
    }
    try { return await this.done } finally { signal?.removeEventListener("abort", cancel) }
  }
}

// decision: drive the native terminal login menu; not the CLI's print-mode
// sign-in prompt because that command would run a model turn after sign-in.
// Revisit when agy exposes a standalone native sign-in command.
export async function startLogin(agy, options = {}) {
  const home = currentHome()
  if (!home) return { error: "native sign-in needs a new account home" }
  const file = tokenFile(home)
  if (fs.existsSync(file)) return { error: "this account home already has a sign-in" }
  const { startMs = LOGIN_START_MS } = options
  const attempt = new LoginAttempt(options)
  if (attempt.result) return attempt.result
  if (process.platform !== "linux" || typeof globalThis.Bun?.Terminal !== "function") {
    attempt.cancel("native sign-in requires Bun terminal support on Linux; use OAuth configuration, tokens, or an import instead")
    return attempt.done
  }
  return new Promise(resolve => {
    let child, terminal, stopping, poll, complete
    let out = ""
    let selected = false
    let shown = false
    const decoder = new StringDecoder("utf8")
    const startTimer = attempt.timer(() => {
      attempt.cancel("agy didn't show the native Google sign-in prompt; check `agy` in a terminal or use OAuth configuration")
    }, startMs)
    const stop = () => stopping ??= (async () => {
      clearInterval(poll)
      try {
        if (child) {
          child.kill("SIGKILL")
          await child.exited
        }
      } finally { terminal?.close() }
    })()
    attempt.onStop = stop
    attempt.onEnd = value => { if (!shown) resolve(value) }

    // The interactive CLI remains open after authentication. Only accept a
    // credential it wrote in this fresh home, then close the CLI before probing.
    function checkToken() {
      if (!complete || attempt.result || stopping) return false
      try {
        if (parseStored(fs.readFileSync(file, "utf8")).state !== "present") return false
      } catch (error) {
        if (error.code === "ENOENT") return false
        attempt.cancel("couldn't read the new agy sign-in")
        return true
      }
      stop().then(() => complete({ ok: true }), () => attempt.cancel("couldn't close the agy sign-in terminal"))
      return true
    }

    function read(term, data) {
      if (attempt.result || stopping) return
      out = (out + decoder.write(data)).slice(-OUTPUT_CHARS)
      const screen = stripVTControlCharacters(out.replace(OSC, ""))
      if (!selected && screen.includes(GOOGLE_MENU) && screen.includes("Navigate · enter Select")) {
        selected = true
        out = ""
        try { term.write("\r") } catch { attempt.cancel("couldn't select Google OAuth in agy") }
      } else if (selected && !shown && screen.includes(CODE_FIELD)) {
        // Read the OSC 8 target, not the rendered URL, which wraps across lines.
        const url = OSC_LINK.exec(out)?.[1]
        if (!url) return
        shown = true
        out = ""
        clearTimeout(startTimer)
        resolve({ url, finish })
      } else if (complete && screen.includes("Press any key to go back.")) {
        attempt.cancel(/invalid_grant/i.test(screen)
          ? "Google turned the code away; start the sign-in again with a new link"
          : "agy couldn't complete Google sign-in; start the sign-in again or check `agy` in a terminal")
      }
    }

    try {
      // SSH selects the manual URL/code flow. Keep CLI state and credentials
      // in the new account home even if the host sets its own config paths.
      const env = childEnv(process.env, {
        TERM: "xterm-256color",
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_STATE_HOME: path.join(home, ".local", "state"),
        AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "true",
      })
      for (const key of ["AGY_ADC_AUTH", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI", "GEMINI_API_KEY", "GOOGLE_API_KEY",
        "ANTIGRAVITY_GEMINI_DIR", "ANTIGRAVITY_CONFIG_REL_DIR", "ANTIGRAVITY_APP_DATA_DIR", "ANTIGRAVITY_EXECUTABLE_DATA_DIR",
        "ANTIGRAVITY_PROJECT_ID", "AGY_CLI_INTERACTIVE_HEADLESS", "AGY_CLI_NONINTERACTIVE_HEADLESS", "NO_COLOR"]) delete env[key]
      terminal = new Bun.Terminal({ cols: 160, rows: 40, data: read })
      child = Bun.spawn([path.resolve(agy), "--log-file", "/dev/null"], { cwd: home, env, terminal })
      child.exited.then(() => {
        if (!stopping && !checkToken()) attempt.cancel("agy exited before completing Google sign-in")
      }, () => attempt.cancel("couldn't run the native agy sign-in terminal"))
    } catch {
      attempt.cancel("couldn't start the native agy sign-in terminal")
    }

    function finish(code, options) {
      return attempt.submit(() => new Promise(resolveFinish => {
        const value = String(code ?? "").trim()
        if (!value || /[^\x21-\x7e]/.test(value)) throw new Error("paste the code or the full URL the sign-in page shows")
        complete = resolveFinish
        terminal.write(value + "\r")
        poll = setInterval(checkToken, 100)
      }), options)
    }
  })
}
