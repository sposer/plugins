import { AsyncLocalStorage } from "node:async_hooks"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// More than one Google account. agy keeps one sign-in where it looks for
// it: the system keyring (one entry, "gemini"/"antigravity"), or, where it
// uses none, the file .gemini/antigravity-cli/antigravity-oauth-token under
// its home folder. So the first account is agy's own, as it always was,
// and every other account gets a home folder of its own: its agy runs
// (sign-in, models, usage, requests) are started with HOME (USERPROFILE on
// Windows) there, and with SSH_CONNECTION set, which agy reads as "a
// session over SSH" and so keeps the sign-in in that file rather than in
// the keyring every account would share. agy 1.5 does so on macOS, Windows
// and Linux (WSL and no-D-Bus Linux use the file already).
//
// The account's home is in its saved sign-in (metadata.agyHome, a folder
// name under accountsDir), and the work done for it runs in accountScope,
// which childEnv (platform.mjs) and the stored sign-in's read (signin.mjs)
// follow.

export const accountScope = new AsyncLocalStorage()

const HOME_ID = /^[a-z0-9]{8,32}$/

// accountsDir is where the other accounts' homes are kept.
export function accountsDir(env = process.env) {
  const base = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(base, "magpie-agy-bridge", "accounts")
}

// homeOf is the folder of the account home id names, or null when id
// isn't one (never a path out of accountsDir).
export function homeOf(id, env = process.env) {
  return typeof id === "string" && HOME_ID.test(id) ? path.join(accountsDir(env), id) : null
}

// homeIdOfAuth is the home a saved sign-in names, "" for agy's own.
export function homeIdOfAuth(auth) {
  const id = auth?.metadata?.agyHome
  return typeof id === "string" && HOME_ID.test(id) ? id : ""
}

// currentHome is the home of the account the current work is for, null
// for agy's own.
export function currentHome() {
  return accountScope.getStore()?.home ?? null
}

// inAccount runs fn for the account at home (null: agy's own).
export function inAccount(home, fn) {
  return accountScope.run({ home: home || null }, fn)
}

export function tokenFile(home) {
  return path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")
}

export function adcFile(home) {
  return path.join(home, ".gemini", "antigravity-cli", "oauth-client.json")
}

// Both imports and interactive login write through this account-home owner.
// The consumer snapshot also supplies the account name and direct quota read.
export function writeTokenFile(home, text, adc = null) {
  const file = tokenFile(home)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  if (adc) fs.writeFileSync(adcFile(home), JSON.stringify(adc), { mode: 0o600 })
  fs.writeFileSync(file, text, { mode: 0o600 })
}

// accountEnv is what every CLI path (models, usage and ACP) consumes.
export function accountEnv(home, platform = process.platform) {
  const adc = fs.existsSync(adcFile(home))
  return {
    HOME: home,
    ...(platform === "win32" ? { USERPROFILE: home } : {}),
    SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0",
    // decision: custom Google clients use agy's native ADC authorized_user;
    // not consumer token JSON because it cannot express a custom OAuth client.
    // Isolated native tracer: custom client refresh -> Code Assist bearer.
    ...(adc ? { AGY_ADC_AUTH: "true", GOOGLE_APPLICATION_CREDENTIALS: adcFile(home) } : {}),
  }
}

// newHome makes a home for an account being added: { id, home }.
export function newHome(env = process.env) {
  const id = randomBytes(8).toString("hex")
  const home = homeOf(id, env)
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  return { id, home }
}

export function dropHome(home) {
  if (!home) return
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
}
