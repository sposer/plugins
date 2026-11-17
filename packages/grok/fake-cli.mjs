// A portable stand-in at the CLI process boundary. No installed grok, shell,
// symlink privileges or external network is needed by renewal tests.
import { mock } from "bun:test"
import * as childProcess from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const realExecFile = childProcess.execFile
const handlers = new Map()
mock.module("node:child_process", () => ({ ...childProcess, execFile: (file, ...args) => handlers.has(file) ? handlers.get(file)(...args) : realExecFile(file, ...args) }))

export function fakeCLI(root, later, delay = 0) {
  const bin = join(root, "bin")
  const exe = join(bin, process.platform === "win32" ? "grok.exe" : "grok")
  mkdirSync(bin)
  writeFileSync(exe, "test executable; execFile is intercepted")
  // decision: intercept execFile; not alias /bin/sh because Windows cannot
  // execute that fixture and symlink creation may require elevation.
  handlers.set(exe, (args, options, done) => {
    if (args[0] === "--version") return done(null, "grok 1.0.88", "")
    if (args.length !== 1 || args[0] !== "models") throw new Error("Unexpected CLI operation in renewal test")
    const home = options.env.GROK_HOME
    const mode = options.env.FAKE_GROK
    let runs = 0
    try { runs = Number(readFileSync(join(home, "runs"), "utf8")) } catch {}
    writeFileSync(join(home, "runs"), String(++runs))
    setTimeout(() => {
      if (mode === "renew") writeFileSync(join(home, "auth.json"), JSON.stringify({ a: { key: `tok-${runs}`, email: "g@x.ai", expires_at: later } }))
      else if (mode === "logout") rmSync(join(home, "auth.json"), { force: true })
      else if (mode === "slow") writeFileSync(join(home, "slow"), "done")
      else if (mode !== "same") return done(Object.assign(new Error("fixture CLI failed"), { code: 1 }), "", "silent refresh outcome=Failed(SelfHealing)")
      done(null, "", "")
    }, mode === "slow" ? 2000 : delay)
  })
  return { bin, dispose: () => handlers.delete(exe) }
}
