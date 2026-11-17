import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { EventEmitter } from "node:events"
import { startLogin } from "../login.mjs"

const spawn = childProcess.spawn
const children = []
const LINK = "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=one"
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture() {
  childProcess.spawn = (file, args, options) => {
    const child = new EventEmitter()
    child.launch = { file, args, options }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdout.setEncoding = child.stderr.setEncoding = () => {}
    child.stdin = new EventEmitter()
    child.input = []
    child.stdin.write = value => { child.input.push(value); child.onInput?.(); return true }
    child.stdin.end = () => {}
    child.kill = () => { child.stopped = true; queueMicrotask(() => child.emit("close", null)); return true }
    children.push(child)
    return child
  }
  syncBuiltinESMExports()
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill()
  await tick()
  childProcess.spawn = spawn
  syncBuiltinESMExports()
})

async function opened(options = {}) {
  const pending = startLogin("agy", options)
  const child = children.at(-1)
  child.stdout.emit("data", LINK + "\nPaste the code: ")
  return { login: await pending, child }
}

test("a cancelled authorize starts no agy process", async () => {
  fixture()
  const controller = new AbortController()
  controller.abort()
  const result = await startLogin("agy", { signal: controller.signal, startMs: 10 })
  assert.ok(result.error)
  assert.equal(children.length, 0)
})

test("the complete sign-in link is collected across stdout and stderr chunks", async () => {
  fixture()
  const pending = startLogin("agy")
  const child = children.at(-1)
  assert.equal(child.launch.options.env.SSH_CONNECTION, "127.0.0.1 0 127.0.0.1 0")
  assert.deepEqual(child.launch.args, ["acp", "--login"])
  let settled = false
  pending.then(() => { settled = true })
  child.stdout.emit("data", "\u001b[32m" + LINK.slice(0, 50))
  await tick()
  assert.equal(settled, false)
  child.stderr.emit("data", LINK.slice(50) + "\u001b[0m\nPaste the code: ")
  const login = await pending
  assert.equal(login.url, LINK)
  child.onInput = () => queueMicrotask(() => child.emit("close", 0))
  assert.equal((await login.finish(" full-page-url ")).ok, true)
  assert.deepEqual(child.input, ["full-page-url\n"])
})

test("cancelling while the link is starting releases the wait and its resources", async () => {
  fixture()
  const controller = new AbortController()
  let failures = 0
  const pending = startLogin("agy", { signal: controller.signal, onFailure: () => failures++ })
  const child = children.at(-1)
  controller.abort()
  assert.ok((await pending).error)
  assert.equal(child.stopped, true)
  await tick()
  assert.equal(failures, 1)
})

test("an abandoned account is cleaned when the sign-in expires or is replaced", async () => {
  fixture()
  let failures = 0
  const first = await opened({ onFailure: () => failures++ })
  const second = await opened({ waitMs: 10, onFailure: () => failures++ })
  assert.equal(first.child.stopped, true)
  assert.ok((await first.login.finish("old-code")).error)
  assert.deepEqual(first.child.input, [])
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(second.child.stopped, true)
  assert.ok((await second.login.finish("late-code")).error)
  assert.equal(failures, 2)
})

test("a cancelled callback never submits a code, even when already aborted", async () => {
  fixture()
  for (const before of [true, false]) {
    const controller = new AbortController()
    let failures = 0
    const { login, child } = await opened({ onFailure: () => failures++ })
    if (before) controller.abort()
    const done = login.finish("code", { signal: controller.signal })
    if (!before) controller.abort()
    assert.ok((await done).error)
    assert.equal(child.stopped, true)
    assert.deepEqual(child.input, before ? [] : ["code\n"])
    assert.equal(failures, 1)
  }
})

test("a callback submits its code once and succeeds only after agy exits successfully", async () => {
  fixture()
  let failures = 0
  const { login, child } = await opened({ onFailure: () => failures++ })
  const done = login.finish("code")
  assert.ok((await login.finish("second-code")).error)
  assert.deepEqual(child.input, ["code\n"])
  child.emit("close", 0)
  assert.equal((await done).ok, true)
  assert.equal(failures, 0)
  assert.ok((await login.finish("reused-code")).error)
})

test("process failures and both deadlines end the login and call cleanup once", async () => {
  fixture()
  let failures = 0
  const opts = { onFailure: () => failures++ }
  const noLink = startLogin("agy", { ...opts, startMs: 10 })
  assert.ok((await noLink).error)
  const slow = await opened(opts)
  assert.ok((await slow.login.finish("code", { finishMs: 10 })).error)
  assert.equal(slow.child.stopped, true)
  const broken = await opened(opts)
  const done = broken.login.finish("code")
  broken.child.stdin.emit("error", new Error("pipe closed"))
  assert.ok((await done).error)
  const denied = await opened(opts)
  const deniedDone = denied.login.finish("code")
  denied.child.stderr.emit("data", 'oauth2: "invalid_grant"\n')
  denied.child.emit("close", 1)
  assert.ok((await deniedDone).error)
  await tick()
  assert.equal(failures, 4)
})
