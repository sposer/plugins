// Runs the suites in test/ (brought over from gitxm/yce-magpie-agy, MIT) in
// separate Bun processes: some mock built-ins or change the environment.
import { expect, test } from "bun:test"
import path from "node:path"

const dir = path.join(import.meta.dir, "test")
const hook = path.join(dir, "cp-hook.mjs")

function run(args, timeout) {
  const result = Bun.spawnSync({ cmd: [process.execPath, ...args], cwd: dir, env: { ...process.env, AGY_BRIDGE_STORED_SIGNIN: "skip" }, stdout: "pipe", stderr: "pipe", timeout })
  const output = result.stdout.toString() + result.stderr.toString()
  if (result.exitCode !== 0) console.error(output)
  return { code: result.exitCode, output }
}

for (const [name, mocks] of [
  ["platform.mjs", true],
  ["compat.mjs", false],
  ["prefill.mjs", false],
  ["usage.mjs", true],
  ["signin.mjs", false],
  ["login.mjs", true],
  ["oauth.mjs", false],
  ["catalog.mjs", false],
  ["tool-budget.mjs", false],
  ["tool-schema.mjs", false],
  ["tui-routing.mjs", false],
  ["tui.mjs", false],
]) {
  test(`test/${name}`, () => {
    // Bun's 5s default is too short for the process-spawning suites on a loaded machine.
    const { code, output } = run(["test", "--timeout", "120000", ...(mocks ? ["--preload", hook] : []), `./${name}`], 240_000)
    expect(code, output).toBe(0)
  }, 250_000)
}

for (const name of ["re2-pattern-unit.mjs", "array-items-unit.mjs", "documents-unit.mjs"]) {
  test(`test/${name}`, () => {
    const { code, output } = run([path.join(dir, name)], 60_000)
    expect(code, output).toBe(0)
  }, 70_000)
}
