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
process.stdin.setEncoding('utf8').on('data', text => {
  input += text;
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
  fs.appendFileSync(file, planner.slice(0, -5));
  setTimeout(() => fs.appendFileSync(file, planner.slice(-5) + '\n'), 120);
});
setInterval(() => {}, 1000);
if (CASE === 'wait-ready') returnProcess();
else {
  process.stdout.write('\x1b[?2004h');
  setTimeout(() => process.stdout.write('\x1b[90m? for shortcuts\x1b[m\r\n'), 30);
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
test("real Antigravity PTY completes a text turn against a loopback Gemini fixture", { skip: !realBin || linux.skip }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-tui-real-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const model = "gemini-3-pro"
  const marker = path.join(dir, "private-file.txt")
  await fs.writeFile(marker, "do-not-read-private-reference")
  const nativePrompt = `${prompt}\nLiteral reference: @${marker}\n${"sample payload ".repeat(1600)}finish.`
  const requests = []
  const witness = path.join(dir, "tool-ran")
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
    const parts = mode === "tool" && req.url.includes(`/models/${model}:`) && !body.includes('"functionResponse"')
      ? [{ text: "not a final reply" }, { functionCall: { name: "run_command",
        args: { CommandLine: `touch ${witness}`, toolSummary: "Create a test witness", WaitMsBeforeAsync: 500 } } }]
      : [{ text: "thinking fixture", thought: true }, { text: "native pure reply" }]
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
  const run = prompt => runTui(wrapper, { model, prompt, env, timeoutMs: 15_000 })
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
})
