import os from "node:os"
import { stripVTControlCharacters } from "node:util"
import { spawnAgy, stopAgy } from "./platform.mjs"

// agy owns Google's OAuth exchange and credential storage. Its terminal
// login prints a link and takes the code or the landing page's whole URL,
// so the same flow works locally, over SSH and in Docker.
export const LOGIN_WAIT_MS = 15 * 60 * 1000
export const LOGIN_START_MS = 30_000
export const LOGIN_FINISH_MS = 60_000

// Wait for the delimiter: a stream chunk may end halfway through the URL.
const SIGN_IN_LINK = /https:\/\/accounts\.google\.com\/[^\s"'<>]+(?=[\s"'<>])/
const OUTPUT_CHARS = 16 * 1024
let pending = null

function lastLine(text) {
  return String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) ?? ""
}

// One native login at a time, as before. onFailure releases a new account's
// home even when the user never reaches the callback (cancel/expiry/retry).
export function startLogin(agy, { waitMs = LOGIN_WAIT_MS, startMs = LOGIN_START_MS, signal, onFailure } = {}) {
  if (signal?.aborted) {
    onFailure?.()
    return Promise.resolve({ error: "the sign-in was cancelled" })
  }
  pending?.cancel("another sign-in was started; use its new link")
  return new Promise((resolve) => {
    let child
    try {
      child = spawnAgy(agy, ["acp", "--login"], { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] })
    } catch (err) {
      onFailure?.()
      resolve({ error: `couldn't run agy: ${err.message}` })
      return
    }
    let out = ""
    let shown = false
    let submitted = false
    let result = null
    let finishTimer
    let complete
    const done = new Promise(resolve => { complete = resolve })
    const attempt = { cancel: error => end({ error }, true) }
    pending = attempt
    const onAbort = () => attempt.cancel("the sign-in was cancelled")
    const startTimer = setTimeout(() => {
      attempt.cancel(`agy didn't print a sign-in link within ${Math.round(startMs / 1000)}s${lastLine(out) ? `: ${lastLine(out)}` : ""}`)
    }, startMs)
    const waitTimer = setTimeout(() => attempt.cancel("the sign-in link expired; start the sign-in again"), waitMs)
    waitTimer.unref?.()

    function end(value, terminate = false) {
      if (result) return
      result = value
      clearTimeout(startTimer)
      clearTimeout(waitTimer)
      clearTimeout(finishTimer)
      signal?.removeEventListener("abort", onAbort)
      if (pending === attempt) pending = null
      if (terminate) stopAgy(child)
      if (value.error) onFailure?.()
      complete(value)
      // A startup failure must release authorize too, not just finish.
      if (!shown) resolve(value)
    }

    const read = (data) => {
      out = stripVTControlCharacters(out + data).slice(-OUTPUT_CHARS)
      if (shown || result) return
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
    child.stdin?.on("error", err => attempt.cancel(`couldn't send the code to agy: ${err.message}`))
    child.on("error", err => end({ error: `couldn't run agy: ${err.message}` }, true))
    child.on("close", code => {
      if (shown && submitted && code === 0) return end({ ok: true, said: lastLine(out) })
      const said = lastLine(out)
      if (!shown && /Usage:|Usage of/.test(out)) {
        return end({ error: "this agy can't sign in from magpie (it has no `agy acp --login`). Update it with `agy update`, or run `agy` in a terminal once to sign in, then try again." })
      }
      if (/invalid_grant/.test(out)) {
        return end({ error: "Google turned the code away: start the sign-in again and paste the code or full URL from that new page." })
      }
      end({ error: said || `agy exited with code ${code} before completing the sign-in` })
    })
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()

    async function finish(code, { signal: callbackSignal, finishMs = LOGIN_FINISH_MS } = {}) {
      if (result) return { error: result.error || "this sign-in is over; start it again" }
      if (submitted) return { error: "this sign-in is already checking a code" }
      const value = String(code ?? "").trim()
      if (!value || /[\r\n]/.test(value)) {
        attempt.cancel("paste the code or the full URL the sign-in page shows")
        return result
      }
      const cancelled = () => attempt.cancel("the sign-in was cancelled")
      callbackSignal?.addEventListener("abort", cancelled, { once: true })
      try {
        if (callbackSignal?.aborted) cancelled()
        if (result) return result
        submitted = true
        finishTimer = setTimeout(() => attempt.cancel(`agy didn't finish the sign-in within ${Math.round(finishMs / 1000)}s`), finishMs)
        try { child.stdin.write(value + "\n") } catch (err) {
          attempt.cancel(`couldn't send the code to agy: ${err.message}`)
        }
        return await done
      } finally {
        clearTimeout(finishTimer)
        callbackSignal?.removeEventListener("abort", cancelled)
      }
    }
  })
}
