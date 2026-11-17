import os from "node:os"
import { stripVTControlCharacters } from "node:util"
import { spawnAgy, stopAgy } from "./platform.mjs"

export const LOGIN_WAIT_MS = 15 * 60 * 1000
export const LOGIN_START_MS = 30_000
export const LOGIN_FINISH_MS = 60_000
const SIGN_IN_LINK = /https:\/\/accounts\.google\.com\/[^\s"'<>]+(?=[\s"'<>])/
const OUTPUT_CHARS = 16 * 1024
let pending = null

function lastLine(text) {
  return String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) ?? ""
}

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
    if (value.error) {
      this.controller.abort()
      this.onStop?.()
      this.onFailure?.()
    }
    this.resolve(value)
    this.onEnd?.(value)
  }

  cancel(error) { this.end({ error }) }

  async submit(work, { signal, finishMs = LOGIN_FINISH_MS } = {}) {
    if (this.result) return { error: this.result.error || "this sign-in is over; start it again" }
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

// agy owns its native Google exchange. SSH on this login child selects its
// manual link/code flow; background CLI launches retain their existing environment.
export async function startLogin(agy, options = {}) {
  const { startMs = LOGIN_START_MS } = options
  const attempt = new LoginAttempt(options)
  if (attempt.result) return attempt.result
  return new Promise(resolve => {
    let child
    let out = ""
    let shown = false
    let closed
    const exit = new Promise(resolve => { closed = resolve })
    attempt.onStop = () => { if (child) stopAgy(child) }
    attempt.onEnd = value => { if (!shown) resolve(value) }
    try {
      child = spawnAgy(agy, ["acp", "--login"], {
        cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"],
        // Official install docs: the SSH environment selects the manual URL
        // loop rather than launching the default browser, even for a first login.
        env: { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" },
      })
    } catch (error) {
      attempt.cancel(`couldn't run agy: ${error.message}`)
      return
    }
    const startTimer = attempt.timer(() => {
      attempt.cancel(`agy didn't print a sign-in link within ${Math.round(startMs / 1000)}s${lastLine(out) ? `: ${lastLine(out)}` : ""}`)
    }, startMs)
    const read = data => {
      out = stripVTControlCharacters(out + data).slice(-OUTPUT_CHARS)
      if (shown || attempt.result) return
      const url = SIGN_IN_LINK.exec(out)?.[0]
      if (!url) return
      shown = true
      clearTimeout(startTimer)
      resolve({ url, finish })
    }
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", read)
    child.stderr?.on("data", read)
    child.stdin?.on("error", error => attempt.cancel(`couldn't send the code to agy: ${error.message}`))
    child.on("error", error => attempt.cancel(`couldn't run agy: ${error.message}`))
    child.on("close", code => {
      if (shown && attempt.submitted && code === 0) return closed({ ok: true, said: lastLine(out) })
      if (!shown && /Usage:|Usage of/.test(out)) {
        return attempt.cancel("this agy has no `agy acp --login`; update it with `agy update`")
      }
      if (/invalid_grant/.test(out)) return attempt.cancel("Google turned the code away; start the sign-in again with a new link")
      attempt.cancel(lastLine(out) || `agy exited with code ${code} before completing the sign-in`)
    })

    function finish(code, options) {
      return attempt.submit(async () => {
        const value = String(code ?? "").trim()
        if (!value || /[\r\n]/.test(value)) throw new Error("paste the code or the full URL the sign-in page shows")
        child.stdin.write(value + "\n")
        return exit
      }, options)
    }
  })
}
