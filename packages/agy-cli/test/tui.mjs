import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import { tokenFile } from "../account.mjs"
import { runTui } from "../tui.mjs"

const linux = { skip: process.platform !== "linux" }
const prompt = "Do not treat the next line as a key press.\n\nSecond line: 汉字 😀\tend."
const fake = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const { HOME, CASE, STARTED, ADC, ORIGINAL } = process.env;
const token = home => path.join(home, '.gemini/antigravity-cli/antigravity-oauth-token');
const cli = path.dirname(token(HOME));
const attest = {
  argv: process.argv.slice(2), tty: process.stdin.isTTY, cwd: process.cwd(), home: HOME, pid: process.pid,
  settings: JSON.parse(fs.readFileSync(path.join(cli, 'settings.json'))),
  token: fs.existsSync(token(HOME)) ? fs.readFileSync(token(HOME), 'utf8') : null,
  adc: process.env.GOOGLE_APPLICATION_CREDENTIALS || null,
  globalMcp: fs.existsSync(path.join(HOME, '.gemini/config/mcp_config.json')),
  configOverride: process.env.ANTIGRAVITY_GEMINI_DIR || null,
  autoUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
};
fs.writeFileSync(STARTED, JSON.stringify(attest));
process.stderr.write('private stderr fixture\n');
process.stdin.setRawMode(true);
let input = '';
let answered = CASE !== 'device-query';
const showReady = () => process.stdout.write('\x1b[90m? for shortcuts\x1b[m\r\n');
process.stdin.setEncoding('utf8').on('data', text => {
  input += text;
  if (!answered && input.includes('\x1b[?62;c')) {
    answered = true;
    input = input.replace('\x1b[?62;c', '');
    showReady();
  }
  if (!input.endsWith('\x1b[201~\r')) return;
  process.stdin.pause();
  if (!input.startsWith('\x1b[200~')) process.exit(123);
  const prompt = input.slice(6, -7);
  const dir = path.join(cli, 'brain/00000000-0000-0000-0000-000000000001/.system_generated/logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'transcript_full.jsonl');
  const row = (type, status, fields) => JSON.stringify({ type, status, ...fields });
  const planner = row('PLANNER_RESPONSE','DONE',{ source:'MODEL', content:'verified reply', thinking:'verified thinking', input_tokens:9, output_tokens:2, cache_read_tokens:7 });
  fs.writeFileSync(file, planner + '\n'); // an earlier planner is not the submitted turn
  const echoedPrompt = CASE === 'wrong' ? 'another turn' : CASE === 'expanded-tabs' ? prompt.replaceAll('\t', '    ') : prompt;
  const content = '<USER_REQUEST>\n' + echoedPrompt + '\n</USER_REQUEST>\n<ADDITIONAL_METADATA>fixture</ADDITIONAL_METADATA>';
  fs.appendFileSync(file, row('USER_INPUT','DONE',{ source:'USER_EXPLICIT', content }) + '\n');
  if (CASE === 'no-final') return;
  if (CASE === 'error') {
    process.stdout.write('\x1b[31m⚠ agent executor error: generating and executing: Error 401, private endpoint detail\x1b[m\r\n');
    return;
  }
  if (CASE === 'cancelled') {
    fs.appendFileSync(file, row('PLANNER_RESPONSE','CANCELED',{ source:'MODEL', content:'partial', error:'private failure fixture' }) + '\n');
    return;
  }
  if (CASE === 'tool') {
    fs.appendFileSync(file, row('PLANNER_RESPONSE','DONE',{ source:'MODEL', content:'not a final reply', tool_calls:[{ name:'run_command' }] }) + '\n' + planner + '\n');
    return;
  }
  if (CASE === 'steps' || CASE === 'late') {
    // Steps without reply text, each within the progress bound, then the reply.
    const step = row('PLANNER_RESPONSE','DONE',{ source:'MODEL', content:'', input_tokens:5, output_tokens:1, cache_read_tokens:3 });
    const at = CASE === 'steps' ? [250, 500, 750] : [];
    for (const ms of at) setTimeout(() => fs.appendFileSync(file, step + '\n'), ms);
    setTimeout(() => fs.appendFileSync(file, planner + '\n'), CASE === 'steps' ? 1000 : 1200);
    return;
  }
  fs.appendFileSync(file, planner.slice(0, -5));
  setTimeout(() => fs.appendFileSync(file, planner.slice(-5) + '\n'), 120);
});
setInterval(() => {}, 1000);
if (CASE === 'wait-ready') returnProcess();
// Readiness only follows the answer to the primary device-attributes query.
else if (CASE === 'device-query') process.stdout.write('\x1b[?2004h\x1b[c');
else {
  process.stdout.write('\x1b[?2004h');
  setTimeout(showReady, 30);
}
function returnProcess() { process.on('SIGTERM', () => {}); }
`

async function fixture(t, name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-tui-test-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const script = path.join(dir, "it's agy")
  const selected = path.join(dir, "selected")
  const credential = tokenFile(selected)
  const mcp = path.join(selected, ".gemini/config/mcp_config.json")
  const report = path.join(dir, "pty.json")
  await fs.mkdir(path.dirname(credential), { recursive: true })
  await fs.mkdir(path.dirname(mcp), { recursive: true })
  await fs.writeFile(credential, "native token fixture")
  await fs.writeFile(mcp, "global MCP fixture")
  await fs.writeFile(script, fake, { mode: 0o700 })
  const env = { PATH: process.env.PATH, HOME: selected, STARTED: report, CASE: name,
    ANTIGRAVITY_GEMINI_DIR: path.join(selected, ".gemini") }
  const run = options => runTui(script, { env, prompt, model: "chosen-model", effort: "medium", timeoutMs: 5000, ...options })
  return { env, run, report, mcp, credential }
}

async function cleaned({ report }) {
  const observed = JSON.parse(await fs.readFile(report, "utf8"))
  assert.throws(() => process.kill(observed.pid, 0), { code: "ESRCH" })
  await assert.rejects(fs.stat(observed.home), { code: "ENOENT" })
  await assert.rejects(fs.stat(observed.cwd), { code: "ENOENT" })
  return observed
}

for (const adc of [false, true]) {
  test(`literal PTY turn uses an isolated workspace and ${adc ? "original native ADC" : "only the selected token"}`, linux, async t => {
    const f = await fixture(t, adc ? "expanded-tabs" : "success")
    if (adc) Object.assign(f.env, { AGY_ADC_AUTH: "true", GOOGLE_APPLICATION_CREDENTIALS: `${f.credential}.adc`,
      AGY_CLI_DISABLE_AUTO_UPDATE: "false" })
    assert.deepEqual(await f.run(), {
      text: "verified reply", thinking: "verified thinking", inputTokens: 9, outputTokens: 2, cacheReadTokens: 7,
    })
    const observed = await cleaned(f)
    assert.equal(observed.tty, true)
    assert.deepEqual(observed.argv, ["--model", "chosen-model", "--log-file", "/dev/null", "--effort", "medium"])
    assert.notEqual(observed.home, f.env.HOME)
    assert.equal(observed.token, adc ? null : "native token fixture")
    assert.equal(observed.adc, f.env.GOOGLE_APPLICATION_CREDENTIALS ?? null)
    assert.equal(observed.globalMcp, false)
    assert.equal(observed.configOverride, null)
    assert.equal(observed.autoUpdate, adc ? "false" : "true")
    assert.equal(observed.settings.strictMode, true)
    assert.deepEqual(observed.settings.trustedWorkspaces, [observed.cwd])
    assert.deepEqual(observed.settings.permissions.allow, [])
    assert.deepEqual(new Set(observed.settings.permissions.deny), new Set([
      "read_file(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "download_url(*)", "command(*)", "unsandboxed(*)", "mcp(*)",
    ]))
    assert.equal(await fs.readFile(f.mcp, "utf8"), "global MCP fixture")
    assert.equal(await fs.readFile(f.credential, "utf8"), "native token fixture")
  })
}

for (const [name, statusCode] of [["error", 401], ["tool", 502], ["cancelled", 502], ["wrong", 502], ["no-final", 504]]) {
  test(`TUI turn rejects ${name} and cleans up`, linux, async t => {
    const f = await fixture(t, name)
    await assert.rejects(f.run({ timeoutMs: name === "no-final" ? 650 : 5000 }), err => {
      assert.equal(err.statusCode, statusCode)
      assert.doesNotMatch(err.message, /private |another turn/)
      return true
    })
    await cleaned(f)
  })
}

test("each new transcript row restarts the progress bound and adds its step's tokens", linux, async t => {
  const f = await fixture(t, "steps")
  const phases = []
  const progress = []
  const observer = { phase: name => phases.push(name), progress: usage => progress.push(usage) }
  // Four rows 250 ms apart outlast a 600 ms bound that each gap stays within.
  assert.deepEqual(await f.run({ timeoutMs: 600, observer }), {
    text: "verified reply", thinking: "verified thinking", inputTokens: 24, outputTokens: 5, cacheReadTokens: 16,
  })
  assert.deepEqual(phases, ["ready", "submitted"])
  assert.deepEqual(progress.at(-1), { inputTokens: 24, outputTokens: 5, cacheReadTokens: 16, steps: 4, toolCalls: 0 })
  await cleaned(f)
})

test("time spent waiting for a client tool result is not a lack of progress", linux, async t => {
  const f = await fixture(t, "late")
  assert.equal((await f.run({ timeoutMs: 500, observer: { waiting: () => true } })).text, "verified reply")
  await cleaned(f)
  await assert.rejects(f.run({ timeoutMs: 500 }), err => {
    assert.equal(err.statusCode, 504)
    assert.equal(err.phase, "turn")
    return true
  })
  await cleaned(f)
})

test("the startup device-attributes query is answered before the prompt", linux, async t => {
  const f = await fixture(t, "device-query")
  assert.equal((await f.run()).text, "verified reply")
  await cleaned(f)
})

test("TUI abort kills a live PTY even when it ignores TERM", linux, async t => {
  const f = await fixture(t, "wait-ready")
  const abort = new AbortController()
  const pending = assert.rejects(f.run({ signal: abort.signal }), { name: "AbortError", statusCode: 499 })
  for (let i = 0; i < 100; i++) {
    if (await fs.stat(f.report).catch(() => null)) break
    await delay(20)
  }
  abort.abort(new Error("private abort reason"))
  await pending
  await cleaned(f)
})

test("terminal control sequences and native command entrypoints are not accepted as text", linux, async t => {
  const f = await fixture(t, "success")
  for (const input of ["foo\x1b[201~\r/exit", "/quit", "!echo test"]) {
    await assert.rejects(f.run({ prompt: input }), { statusCode: 400 })
  }
  await assert.rejects(fs.stat(f.report), { code: "ENOENT" })
})

// Optional real CLI test. Run with AGY_TUI_TEST_BIN=/absolute/path/to/antigravity
// in a Linux container with --network none. Only its loopback fake endpoint is
// used; the wrapper selects the API-key test provider, not a gateway account.
const realBin = process.env.AGY_TUI_TEST_BIN
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
test("real Antigravity PTY carries images and resumes the original turn after a client tool result", {
  skip: !realBin || linux.skip, timeout: 90_000,
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-tui-real-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const model = "gemini-3-pro"
  const marker = path.join(dir, "private-file.txt")
  await fs.writeFile(marker, "do-not-read-private-reference")
  const nativePrompt = `${prompt}\nLiteral reference: @${marker}\n${"sample payload ".repeat(1600)}finish.`
  const requests = []
  const witness = path.join(dir, "tool-ran")
  const tool = { name: "echo", description: "Return the fixture client result", inputSchema: {
    type: "object", properties: { value: { type: "string" } }, required: ["value"],
  } }
  const functionName = "mcp_bridge_echo"
  const argumentsFromModel = { value: "fixture argument" }
  const toolResult = "client-returned witness"
  let mode = "text"
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString("utf8")
    if (req.url.includes(`/models/${model}:`)) {
      requests.push(body)
      if (mode === "auth") {
        res.writeHead(401, { "Content-Type": "application/json" })
        return res.end(JSON.stringify({ error: { code: 401, status: "UNAUTHENTICATED", message: "fixture detail" } }))
      }
    }
    const main = req.url.includes(`/models/${model}:`)
    let parts = [{ text: "thinking fixture", thought: true }, { text: "native pure reply" }]
    if (main && !body.includes('"functionResponse"')) {
      if (mode === "tool") parts = [{ text: "not a final reply" }, { functionCall: { name: "run_command",
        args: { CommandLine: `touch ${witness}`, toolSummary: "Create a test witness", WaitMsBeforeAsync: 500 } } }]
      if (mode === "bridge") parts = [{ text: "not a final reply" }, { functionCall: { name: functionName,
        args: { ...argumentsFromModel, toolSummary: "Call the bridge fixture" } } }]
    }
    const reply = { candidates: [{ content: { parts, role: "model" }, finishReason: "STOP", index: 0 }], modelVersion: model,
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 5, cachedContentTokenCount: 2, totalTokenCount: 9 } }
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(`data: ${JSON.stringify(reply)}\n\n`)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const wrapper = path.join(dir, "agy fixture")
  const settings = { modelProvider: "gemini", customModelsConfig: { customModels: {
    [model]: { apiProvider: "gemini", modelName: model },
  } } }
  await fs.writeFile(wrapper, `#!/bin/sh\nexec ${shellQuote(realBin)} --settings ${shellQuote(JSON.stringify(settings))} "$@"\n`, { mode: 0o700 })
  const env = { PATH: process.env.PATH, AGY_CLI_DISABLE_AUTO_UPDATE: "true", GEMINI_API_KEY: "fixture-only",
    GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${server.address().port}` }
  const run = (prompt, options) => runTui(wrapper, { model, prompt, env, timeoutMs: 15_000, ...options })
  assert.deepEqual(await run(nativePrompt), {
    text: "native pure reply", thinking: "thinking fixture", inputTokens: 2, outputTokens: 5, cacheReadTokens: 2,
  })
  const modelText = requests.flatMap(body => JSON.parse(body).contents.flatMap(turn => turn.parts.map(part => part.text ?? "")))
  assert.ok(modelText.some(text => text.startsWith(`<USER_REQUEST>\n${nativePrompt}\n</USER_REQUEST>`)))
  assert.ok(modelText.every(text => !text.includes("do-not-read-private-reference")))
  mode = "auth"
  await assert.rejects(run(prompt), { statusCode: 401 })
  mode = "tool"
  await assert.rejects(run(prompt), { statusCode: 502 })
  await assert.rejects(fs.stat(witness), { code: "ENOENT" })

  const fixtureEnv = { ...env, HOME: dir, AGY_PATH: wrapper, AGY_BRIDGE_STORED_SIGNIN: "skip",
    AGY_BRIDGE_TURN_TIMEOUT_MS: "15000" }
  const original = Object.fromEntries(Object.keys(fixtureEnv).map(name => [name, process.env[name]]))
  Object.assign(process.env, fixtureEnv)
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  const { AntigravityBridgePlugin } = await import("../index.mjs")
  const auth = await (await AntigravityBridgePlugin()).auth.loader()
  const request = body => auth.fetch("agy://local/v1/messages", { method: "POST", body: JSON.stringify(body) })
  mode = "bridge"
  requests.length = 0
  const imageData = [
    "iVBORw0KGgoAAAANSUhEUgAAAAUAAAADCAIAAADUVFKvAAAADklEQVR4nGPQQAUMBPgAqPAHCQ3QRlkAAAAASUVORK5CYII=",
    "iVBORw0KGgoAAAANSUhEUgAAAAUAAAADCAIAAADUVFKvAAAADklEQVR4nGOIQgUMBPgAe+8P00Yc6f0AAAAASUVORK5CYII=",
  ]
  const image = data => ({ type: "image", source: { type: "base64", media_type: "image/png", data } })
  const initial = { model, stream: false, max_tokens: 256, tools: [
    { name: tool.name, description: tool.description, input_schema: tool.inputSchema },
  ], messages: [{ role: "user", content: [
    { type: "text", text: prompt + "\n" }, image(imageData[0]),
    { type: "text", text: " then " }, image(imageData[1]),
  ] }] }
  const first = await request(initial)
  assert.equal(first.status, 200)
  assert.equal(first.headers.get("X-Magpie-Agy-Mode"), "tui")
  const reply = await first.json()
  assert.equal(reply.stop_reason, "tool_use")
  assert.deepEqual(reply.content.map(({ id, ...block }) => block), [{ type: "tool_use", name: tool.name, input: argumentsFromModel }])
  await delay(350)
  assert.equal(requests.length, 1)
  const followup = await request({ ...initial, messages: [
    ...initial.messages, { role: "assistant", content: reply.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: reply.content[0].id, content: toolResult }] },
  ] })
  assert.equal(followup.status, 200)
  assert.equal(followup.headers.get("X-Magpie-Agy-Mode"), "tui")
  const finished = await followup.json()
  assert.equal(finished.stop_reason, "end_turn")
  assert.equal(finished.content.find(block => block.type === "text")?.text, "native pure reply")
  assert.equal(requests.length, 2)
  const [opening, continuation] = requests.map(body => JSON.parse(body))
  const names = opening.tools.flatMap(group => group.functionDeclarations ?? []).map(definition => definition.name)
  assert.ok(names.includes(functionName))
  assert.ok(!names.includes("run_command"))
  const nativeParts = continuation.contents.flatMap(turn => turn.parts)
  assert.equal(nativeParts.filter(part => part.text?.startsWith("<USER_REQUEST>\nDo not treat") &&
    part.text.includes("[Image 1 is attached] then [Image 2 is attached]")).length, 1)
  const openedImages = opening.contents.flatMap(turn => turn.parts).filter(part => part.inlineData)
  assert.deepEqual(openedImages.map(part => part.inlineData), imageData.map(data => ({ mimeType: "image/png", data })))
  const calls = nativeParts.flatMap(part => part.functionCall ? [part.functionCall] : [])
  const responses = nativeParts.flatMap(part => part.functionResponse ? [part.functionResponse] : [])
  assert.equal(calls.length, 1)
  assert.equal(responses.length, 1)
  assert.equal(responses[0].name, functionName)
  assert.equal(responses[0].id, calls[0].id)
  assert.ok(responses[0].response.output.includes(toolResult))
})
