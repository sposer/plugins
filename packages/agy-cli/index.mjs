import { agyCandidates, childEnv, spawnAgy, stopAgy } from "./platform.mjs"
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { agyRefusal, createUsageReader } from "./usage.mjs"
import { catalogRows, storeCatalogRows } from "./model-ids.mjs"
import { backgroundBlocked, cannotSignIn, forgetStoredSignIn, storedEmail, storedSignInNow } from "./signin.mjs"
import { sanitizePatternFields } from "./re2-pattern.mjs"
import { LoginAttempt, startLogin } from "./login.mjs"
import { CODE_PROMPTS, TOKEN_PROMPTS, configuredLogin, nativeClient, oauthConfig, tokenLogin } from "./oauth.mjs"
import { accountsDir, currentHome, dropHome, homeIdOfAuth, homeOf, inAccount, newHome, terminalCredential, writeTokenFile } from "./account.mjs"
import { IMPORT_FROM, importedAccounts, tokenFileText } from "./import.mjs"
import { AGY_MANUAL, installAgy, keepAgyCurrent } from "./install.mjs"
import { documentRefusal, documentText } from "./documents.mjs"
import { ensureGeminiArrayItems } from "./array-items.mjs"
import { expandToolSchema } from "./tool-schema.mjs"
import { fitTools } from "./tool-budget.mjs"
import { processExists } from "./proc.mjs"
import { outgoing } from "./cloak.mjs"
import { runTui } from "./tui.mjs"
import { parseTuiInput } from "./tui-input.mjs"

const PROVIDER_ID = "agy-cli"
// AGY process slots include turns waiting for a client tool result.
function maxProcs() {
  return positiveTimeout(process.env.AGY_BRIDGE_MAX_PROCS, 16)
}
// Longest time a native turn may go without a new transcript row, excluding
// time spent waiting for a client tool result.
const TURN_TIMEOUT_MS = positiveTimeout(process.env.AGY_BRIDGE_TURN_TIMEOUT_MS, 5 * 60 * 1000)
// Longest time a native turn waits for one client tool result.
const TOOL_TIMEOUT_MS = 30 * 60 * 1000
// Under slot pressure, a turn whose client has held a tool call this long gives up its slot.
const EVICT_WAIT_MS = 30_000
// A tool_use response waits this long for the transcript row of its planner step.
const USAGE_SYNC_MS = 1000
const NO_RETRY_HEADERS = { "x-should-retry": "false" }
const CONTROL_LINE_LIMIT = 16 * 1024 * 1024
const NPM_ANTHROPIC = "@ai-sdk/anthropic"
const FORWARD_THINKING = process.env.AGY_BRIDGE_THINKING !== "0"

// Known native model families to show until `agy models` answers.
const FALLBACK_MODELS = [
  { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", effort: "high" },
  { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", effort: "medium" },
  { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)", effort: "low" },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", effort: "high" },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", effort: "medium" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", effort: "low" },
]

const tuiTurns = new Set()
const sessions = new Map()
const tuiCalls = new Map()
let cachedAgyPath
let cachedAgySearchKey
let controlServer
let controlServerPromise
function positiveTimeout(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function configuredTimeout(name, fallback) {
  return Object.hasOwn(process.env, name)
    ? positiveTimeout(process.env[name], fallback)
    : fallback
}

function findAgy() {
  // Re-search whenever an input of the search changes (AGY_PATH, PATH/Path,
  // LOCALAPPDATA, home): a cached path from an old environment may be gone.
  const home = os.homedir()
  const env = process.env
  const searchKey = JSON.stringify([env.AGY_PATH, env.PATH, env.Path, env.LOCALAPPDATA, env.XDG_DATA_HOME, home])
  // and whenever the path found is gone: an agy removed while magpie ran
  // is installed again by the next sign-in, not spawned where it was
  if (cachedAgyPath && cachedAgySearchKey === searchKey) {
    try {
      fs.accessSync(cachedAgyPath, fs.constants.X_OK)
      return cachedAgyPath
    } catch {}
  }
  cachedAgyPath = null
  cachedAgySearchKey = searchKey
  const candidates = agyCandidates(env, home)
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      cachedAgyPath = candidate
      return candidate
    } catch {}
  }
  return null
}

// Ask for --settings once per binary so the list uses subscription rather than API-key settings.
const topHelpText = new Map()
function topHelp(agyPath) {
  let key = agyPath
  try {
    const st = fs.statSync(agyPath)
    key += `\0${st.mtimeMs}\0${st.size}`
  } catch {}
  let probe = topHelpText.get(key)
  if (!probe) {
    probe = execOnce(agyPath, ["--help"], { timeoutMs: 10_000, unrefTimer: true }).then(({ err, stdout, stderr, timedOut }) => {
      if (err || timedOut) topHelpText.delete(key)
      return stdout + stderr
    })
    topHelpText.set(key, probe)
  }
  return probe
}

export const MODELS_SETTINGS = JSON.stringify({ modelProvider: "" })

export async function modelsArgs(agyPath) {
  return /^\s*--settings\b/m.test(await topHelp(agyPath)) ? ["--settings", MODELS_SETTINGS, "models"] : ["models"]
}

function execOnce(file, args, opts = {}) {
  return new Promise((resolve) => {
    const { signal, unrefTimer, ...spawnOpts } = opts
    const cancelled = () => ({ err: new DOMException("the sign-in was cancelled", "AbortError"), stdout: "", stderr: "", code: null, timedOut: false })
    if (signal?.aborted) return resolve(cancelled())
    let child
    try {
      child = spawnAgy(file, args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...spawnOpts,
        windowsHide: true,
      })
    } catch (err) {
      resolve({ err, stdout: "", stderr: "", code: null, timedOut: false })
      return
    }
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      signal?.removeEventListener("abort", onAbort)
      stopAgy(child)
      // A grandchild can hold the pipes open after the kill; never wait for close.
      resolve({ err: null, stdout, stderr, code: null, timedOut })
    }, opts.timeoutMs ?? 30_000)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      stopAgy(child)
      resolve(cancelled())
    }
    // Background work (the model catalog refresh) must never hold Node's exit.
    // A caller that awaits the result keeps the deadline referenced.
    if (unrefTimer) timer.unref?.()
    try {
      child.stdout.on("data", (data) => { stdout += data })
      child.stderr.on("data", (data) => { stderr += data })
      child.on("error", (err) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        resolve({ err, stdout, stderr, code: null, timedOut })
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        resolve({ err: null, stdout, stderr, code, timedOut })
      })
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) onAbort()
    } catch (err) {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      stopAgy(child)
      resolve({ err, stdout, stderr, code: null, timedOut })
    }
  })
}

async function listAgyModels(agyPath) {
  // a listing nobody asked for doesn't run an agy that would start its own
  // Google sign-in (signin.mjs); the catalog it has stays
  if (await backgroundBlocked()) return null
  const { err, stdout, stderr, code, timedOut } = await execOnce(agyPath, await modelsArgs(agyPath), { timeoutMs: 15_000, unrefTimer: true })
  // null, not FALLBACK_MODELS: a failed listing must not overwrite a dynamic catalog.
  if (err || timedOut || code !== 0) {
    if (!err && !timedOut) noteRefusal(agyRefusal(`${stderr}\n${stdout}`))
    return null
  }
  noteRefusal("")
  return parseAgyModels(stdout)
}

// What the last `agy models` of each account said when Google turned the
// account away at agy's eligibility check (agyRefusal), "" when it listed.
// models() says it instead of serving a fallback list as if agy had
// answered, and a turn that then can't pick its model says it too.
const refusals = new Map()

function noteRefusal(why) {
  const home = currentHome() ?? ""
  if (why) refusals.set(home, why)
  else refusals.delete(home)
}

function refusalOf() {
  return refusals.get(currentHome() ?? "") || ""
}

// parseAgyModels reads `agy models` output: one "<id>  <name>" per line.
function parseAgyModels(stdout) {
  const out = []
  for (const raw of String(stdout ?? "").split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const match = /^(\S+)\s+(.+)$/.exec(line)
    if (!match) continue
    const id = match[1]
    const name = match[2].trim()
    const effort = /-(high|medium|low|minimal|xhigh|max)$/i.exec(id)?.[1]?.toLowerCase()
    out.push({ id, name, effort })
  }
  return out.length ? out : null
}

function reusableTerminalCredential() {
  const credential = terminalCredential(childEnv())
  if (!credential) return
  try {
    if (fs.statSync(credential.file).isFile()) return credential
  } catch {}
}

// A successful native listing verifies the account and seeds its model catalog.
async function probeSignedIn(agy, { signal, fileStorage } = {}) {
  const cancelled = () => ({ ok: false, why: "the sign-in was cancelled" })
  if (signal?.aborted) return cancelled()
  // no sign-in stored, or one agy failed with: `agy models` would start
  // agy's own Google sign-in (on Windows, a browser no shim stops), so the
  // caller goes on to magpie's own sign-in link instead
  const blocked = await backgroundBlocked({ fresh: true })
  if (signal?.aborted) return cancelled()
  if (blocked) return { ok: false, why: blocked }
  const env = fileStorage ? { AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "true" } : undefined
  const probe = await execOnce(agy, await modelsArgs(agy), { timeoutMs: 15_000, signal, env })
  if (signal?.aborted) return cancelled()
  const listed = !probe.err && !probe.timedOut && probe.code === 0 &&
    probe.stdout.split("\n").some(line => /^\S+\s+\S/.test(line.trim()))
  if (listed) {
    const list = parseAgyModels(probe.stdout)
    if (list) {
      useAgyPath(agy)
      storeListedCatalog(agy, list, Date.now())
    }
    return signal?.aborted ? cancelled() : { ok: true }
  }
  // Google turned the account away (#3501): signing in again took, and
  // Google still refuses it; say so, not agy's last line alone
  const refused = !probe.err && !probe.timedOut ? agyRefusal(`${probe.stderr}\n${probe.stdout}`) : ""
  if (refused) {
    noteRefusal(refused)
    return { ok: false, why: refused }
  }
  const why = probe.timedOut
    ? "`agy models` timed out after 15s"
    : `\`agy models\` says: ${(probe.stderr || probe.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1) || probe.err?.message || `exit ${probe.code}`}`
  return { ok: false, why }
}

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"]
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000
const MODEL_CATALOG_FAST_WAIT_MS = 500
const MODEL_CATALOG_RETRY_MS = 5_000

// Native model listings and refreshes belong to the selected account.
const modelStates = new Map()

function ms() {
  const home = currentHome() ?? ""
  let state = modelStates.get(home)
  if (!state) {
    state = {
      cachedModelCatalog: fallbackModelCatalog(),
      modelCatalogRefreshPromise: null,
    }
    modelStates.set(home, state)
  }
  return state
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}

function catalogOf(entry) {
  return entry.catalog ??= buildModelCatalog(entry.list)
}

function modelFamilyId(model) {
  if (!model.effort) return ""
  return model.id.slice(0, -(model.effort.length + 1))
}

// Orchestrator pairs a planner (Carbon or Argon) with Gemini 4 Hydrogen,
// which applies edits and runs builds with agy's own tools. The bridge's agent
// has only the client's tools (tools: [] in its private agent), so the handoff
// can't happen here and an Orchestrator turn is its planner alone, at a fixed
// thinking level. It isn't listed, and a request naming it is told which
// model it would really get.
function isOrchestrator(model) {
  const id = typeof model === "string" ? model : model?.id ?? ""
  const name = typeof model === "string" ? "" : model?.name ?? ""
  return /^gemini-[a-z0-9.]*-?orchestrator/i.test(id) || /^Orchestrator\b/i.test(name)
}

function orchestratorPlanner(id) {
  return /argon|g1-pro/i.test(id) ? "gemini-4-argon" : "gemini-4-carbon"
}

function orchestratorRefusal(id) {
  const planner = orchestratorPlanner(id)
  return `agy bridge: ${id} (Orchestrator) is not served: its Gemini 4 Hydrogen handoff needs agy's own tools, which the bridge leaves to your client, so it would run as ${planner} alone. Choose ${planner}, or gemini-4-hydrogen, with the effort you want.`
}

function buildModelCatalog(list) {
  list = list.filter(model => !isOrchestrator(model))
  const raw = new Map(list.map(model => [model.id, model]))
  const families = new Map()
  for (const model of list) {
    const id = modelFamilyId(model)
    if (!id) continue
    if (!families.has(id)) families.set(id, [])
    families.get(id).push(model)
  }
  for (const [id, variants] of families) {
    const efforts = new Set(variants.map(model => model.effort))
    if (variants.length < 2 || efforts.size !== variants.length || raw.has(id)) {
      families.delete(id)
    }
  }

  const models = []
  const routes = new Map()
  const added = new Set()
  for (const model of list) {
    const id = modelFamilyId(model)
    const family = families.get(id)
    if (!family) {
      models.push(model)
      continue
    }
    if (added.has(id)) continue
    added.add(id)
    const sorted = [...family].sort((a, b) => EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort))
    const efforts = sorted.map(variant => variant.effort)
    const byEffort = new Map(sorted.map(variant => [variant.effort, variant.id]))
    const defaultEffort = byEffort.has("high") ? "high" : efforts[efforts.length - 1]
    const defaultModel = sorted.find(variant => variant.effort === defaultEffort)
    const baseName = defaultModel.name.replace(/\s+\((?:minimal|low|medium|high|xhigh|max)\)$/i, "").trim()
    models.push({
      id,
      name: baseName && baseName !== defaultModel.id ? baseName : id,
      variants: efforts,
    })
    routes.set(id, { byEffort, efforts, defaultEffort })
  }
  // agy publishes only medium for this family, so the generic multi-variant
  // grouping above cannot supply its verified bare-name alias.
  if (raw.has("gpt-oss-120b-medium") && !raw.has("gpt-oss-120b") && !routes.has("gpt-oss-120b")) {
    models.push({ id: "gpt-oss-120b", name: "GPT-OSS 120B" })
    routes.set("gpt-oss-120b", {
      byEffort: new Map([["medium", "gpt-oss-120b-medium"]]),
      efforts: ["medium"],
      defaultEffort: "medium",
    })
  }
  return { models, routes, raw }
}

function selectTerminalModel(agyPath, model, body, headers) {
  // Serve from the same account catalog used for discovery, without running a
  // second CLI process on the request path.
  useAgyPath(agyPath)
  const { routes, raw } = catalogOf(ms().cachedModelCatalog)
  const effort = requestedEffort(body, headers)
  const family = routes.get(model)
  if (!family) return { model, effort: raw.get(model)?.effort ? "" : effort }
  let selected = family.defaultEffort
  if (effort) {
    const target = EFFORT_ORDER.indexOf(effort)
    let bestDistance = Infinity
    // Variants are sorted in ascending order: equal distances choose the
    // higher native effort, as in model discovery's existing routing.
    for (const variant of family.efforts) {
      const distance = Math.abs(EFFORT_ORDER.indexOf(variant) - target)
      if (distance <= bestDistance) {
        selected = variant
        bestDistance = distance
      }
    }
  }
  return { model: family.byEffort.get(selected), effort: "" }
}

function fallbackModelCatalog(agyPath = null, { replace = false } = {}) {
  // The usage reader names ids on its windows from the catalog being served;
  // a new account's static start doesn't replace another account's real list.
  if (replace || !catalogRows()) storeCatalogRows(FALLBACK_MODELS)
  return { agyPath, list: FALLBACK_MODELS, catalog: null, isFallback: true, fetchedAt: 0, lastAttemptAt: null }
}

// Keep the last native list for a cold start while a refresh runs.
const SAVED_CATALOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

function modelCatalogFile() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(base, "magpie-agy-bridge", "models.json")
}

// catalogKey is the account's entry for agyPath in models.json: agy's own
// account keeps the executable's path as before, another account adds its
// home (#1229).
function catalogKey(agyPath) {
  const home = currentHome()
  return home ? `${agyPath}#${path.basename(home)}` : agyPath
}

function validModelRow(row) {
  return row && typeof row.id === "string" && /^\S+$/.test(row.id) && typeof row.name === "string" &&
    (row.effort === undefined || EFFORT_ORDER.includes(row.effort))
}

function readSavedCatalog(agyPath) {
  if (!agyPath) return null
  try {
    const data = JSON.parse(fs.readFileSync(modelCatalogFile(), "utf8"))
    const entry = data?.version === 1 && data.byAgy && Object.hasOwn(data.byAgy, catalogKey(agyPath)) ? data.byAgy[catalogKey(agyPath)] : null
    if (!entry || !Number.isFinite(entry.at) || Date.now() - entry.at > SAVED_CATALOG_MAX_AGE_MS) return null
    // A half-written or hand-edited file means "unknown": the fallback serves.
    if (!Array.isArray(entry.list) || !entry.list.length || !entry.list.every(validModelRow)) return null
    return entry.list.map(savedRow)
  } catch {
    return null
  }
}

function savedRow({ id, name, effort }) {
  return effort ? { id, name, effort } : { id, name }
}

function saveCatalog(agyPath, list) {
  if (!agyPath) return
  const file = modelCatalogFile()
  try {
    withStateLock(file, () => {
      let byAgy = {}
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"))
        if (data?.version === 1 && data.byAgy && typeof data.byAgy === "object") byAgy = data.byAgy
      } catch {}
      const key = catalogKey(agyPath)
      byAgy[key] = { at: Date.now(), list: list.map(savedRow) }
      const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      fs.writeFileSync(temp, JSON.stringify({ version: 1, byAgy }) + "\n", { mode: 0o600 })
      fs.renameSync(temp, file)
    })
  } catch {}
}

function startingModelCatalog(agyPath) {
  const saved = readSavedCatalog(agyPath)
  if (!saved) return fallbackModelCatalog(agyPath, { replace: true })
  storeCatalogRows(saved)
  return { agyPath, list: saved, catalog: null, isFallback: false, fetchedAt: 0, lastAttemptAt: null }
}

function useAgyPath(agyPath) {
  if (ms().cachedModelCatalog.agyPath === agyPath) return
  ms().cachedModelCatalog = startingModelCatalog(agyPath)
  ms().modelCatalogRefreshPromise = null
}

function storeListedCatalog(agyPath, list, lastAttemptAt) {
  saveCatalog(agyPath, list)
  // The usage reader names ids on its windows from the catalog being served.
  storeCatalogRows(list)
  ms().cachedModelCatalog = {
    agyPath,
    list,
    catalog: null,
    isFallback: false,
    fetchedAt: Date.now(),
    lastAttemptAt,
  }
}

// OpenCode reads the model list again when an account's background refresh settles.
function catalogWarming() {
  const pending = [...modelStates.values()].map(state => state.modelCatalogRefreshPromise).filter(Boolean)
  return pending.length ? Promise.allSettled(pending) : null
}

// A native listing may outlast the host's models() deadline. Wait briefly and
// keep the last successful catalog when the refresh fails.
async function loadModelCatalog(agyPath) {
  useAgyPath(agyPath)
  const state = ms()
  const current = state.cachedModelCatalog
  const now = Date.now()
  if (!agyPath || !current.isFallback && now - current.fetchedAt < MODEL_CATALOG_TTL_MS) return catalogOf(current)
  if (!state.modelCatalogRefreshPromise &&
      (current.lastAttemptAt === null || now - current.lastAttemptAt >= MODEL_CATALOG_RETRY_MS)) {
    current.lastAttemptAt = now
    const refresh = listAgyModels(agyPath).then(list => {
      if (list?.length && state.cachedModelCatalog === current) storeListedCatalog(agyPath, list, now)
    }).catch(() => {}).finally(() => {
      if (state.modelCatalogRefreshPromise === refresh) state.modelCatalogRefreshPromise = null
    })
    state.modelCatalogRefreshPromise = refresh
  }
  if (state.modelCatalogRefreshPromise) {
    let timer
    try {
      await Promise.race([state.modelCatalogRefreshPromise, new Promise(resolve => {
        timer = setTimeout(resolve, MODEL_CATALOG_FAST_WAIT_MS)
      })])
    } finally {
      clearTimeout(timer)
    }
  }
  return catalogOf(state.cachedModelCatalog)
}

function modelLimits(id) {
  const family = id.replace(/\[1m\]$/i, "").replace(/-(?:minimal|low|medium|high|xhigh|max)$/i, "")
  if (/^(?:gemini-4-argon|gemini-3\.8-flash)$/i.test(family)) return { context: 1048576, output: 65536 }
  // Gemini 4 Carbon (Ultra plans): the numbers Antigravity's own model list gives it
  if (/^gemini-4-carbon$/i.test(family)) return { context: 1048576, output: 262144 }
  if (/^claude-(?:opus|sonnet)-5-5$/i.test(family)) return { context: 1000000, output: 64000 }
  // Antigravity's own model list (internal/provider/testdata/antigravity-models-2026-10-20.json
  // in magpie): maxTokens/maxOutputTokens
  if (/^claude-(?:sonnet-4-6|opus-4-6)(?:-thinking)?$/i.test(family)) return { context: 250000, output: 64000 }
  if (/^gemini-3\.5-flash$/i.test(family)) return { context: 1048576, output: 65536 }
  if (/^gemini-3\.1-flash-lite$/i.test(family)) return { context: 1048576, output: 65535 }
  // Gemini 4 Hydrogen: Google's own API listing (models.dev's google provider)
  if (/^gemini-4-hydrogen$/i.test(family)) return { context: 1048576, output: 65536 }
  if (/^gpt-oss-120b$/i.test(family)) return { context: 131072, output: 32768 }
  return undefined
}

function normalizeEffort(value) {
  const direct = String(value || "").trim().toLowerCase()
  if (direct === "ultra") return "max"
  return EFFORT_ORDER.includes(direct) ? direct : ""
}

function requestedEffort(body, headers) {
  const forced = normalizeEffort(process.env.AGY_BRIDGE_EFFORT)
  if (forced) return forced
  const thinking = body.thinking?.type
  if (thinking === "disabled") return ""
  // decision: prefer Magpie's picked level; not the translated body because
  // protocol limits and output caps can lower the body's thinking budget.
  const picked = normalizeEffort(new Headers(headers).get("x-magpie-effort"))
  if (picked) return picked
  const generic = [body.reasoning_effort, body.reasoningEffort, body.reasoning?.effort,
    body.generationConfig?.thinkingConfig?.thinkingLevel].map(normalizeEffort).find(Boolean)
  if (generic) return generic
  if (thinking !== "enabled" && thinking !== "adaptive") return ""
  const direct = normalizeEffort(body.output_config?.effort)
  if (direct) return direct
  const budget = Number(body.thinking?.budget_tokens)
  if (!Number.isFinite(budget) || budget <= 0) return ""
  if (budget <= 4096) return "low"
  if (budget <= 12000) return "medium"
  if (budget <= 24000) return "high"
  return "xhigh"
}

class UnsupportedContent extends Error {
  constructor(what, hint) {
    super(`agy bridge: ${what} is not supported${hint ? `. ${hint}` : ""}`)
    this.statusCode = 400
  }
}

// An upstream failure inside a healthy agy session. The process keeps its
// conversation, so a client retry continues without replaying history.
// streamErrorOf is the error event a failed turn ends its stream with. A
// refusal of the request itself (invalid_request_error: a system prompt
// Antigravity turns away) names its status, 400: magpie's gateway reads a
// stream error's status from the error's own status field first and from
// its words after, and this one's words quote Antigravity's "code 429", so
// without it the client got a 429 and retried a request that can't pass
// every minute (plugins#1151).
function resultText(result) {
  return (result?.content || []).map((part) => part?.type === "text" ? part.text : "[image returned by tool]").join("\n\n")
}

export const IMAGE_FOLLOWS = "[The image this tool returned is attached to the next message.]"

function resultHasImage(result) {
  return (result?.content || []).some((part) => part?.type === "image")
}

// A tool result as agy gets it over MCP: agy writes an MCP image to a file
// ("[Resource offloaded to file://…/media_0.jpg]") and the model never sees
// it, so each image is left out with a line saying where it went.
function toPromptParts(content) {
  if (!content) return []
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return [{ type: "text", text: String(content) }]
  const out = []
  for (const part of content) {
    if (!part) continue
    if (part.type === "text") {
      if (!part.text) continue
      if (out.at(-1)?.type === "text") out.at(-1).text += part.text
      else out.push({ type: "text", text: part.text })
    } else if (part.type === "image" && part.data) {
      out.push({ type: "image", data: part.data, mimeType: part.mimeType || "image/png" })
    }
  }
  return out
}

function mergePromptParts(first, second) {
  const a = toPromptParts(first)
  const b = toPromptParts(second)
  if (!a.length) return b
  if (!b.length) return a
  return toPromptParts([...a, { type: "text", text: "\n\n" }, ...b])
}

// Hold a short-lived lockfile around read-merge-rename so concurrent bridge
// processes do not overwrite one another's native model listings.
function withStateLock(file, fn) {
  const lock = `${file}.lock`
  let fd = null
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const waitBuf = new Int32Array(new SharedArrayBuffer(4))
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        fd = fs.openSync(lock, "wx", 0o600)
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }))
        break
      } catch (error) {
        if (error?.code !== "EEXIST") break
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 5_000) {
            const owner = JSON.parse(fs.readFileSync(lock, "utf8"))
            if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
              if (!processExists(owner.pid)) fs.unlinkSync(lock)
            }
          }
        } catch {}
        Atomics.wait(waitBuf, 0, 0, 5)
      }
    }
    if (fd === null) return
    return fn()
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch {}
      try { fs.unlinkSync(lock) } catch {}
    }
  }
}

function replayHistoryProblem(body, resultBlocks) {
  const calls = lastAssistantCalls(trailingMessages(body).history)
  if (!calls.length) return "no_tool_use"
  const ids = new Set()
  for (const call of calls) {
    if (typeof call.id !== "string" || !call.id || ids.has(call.id)) return "bad_tool_use_id"
    ids.add(call.id)
    if (typeof call.name !== "string" || !call.name) return "bad_tool_use_name"
    const input = call.input ?? {}
    if (!input || typeof input !== "object" || Array.isArray(input)) return "bad_tool_use_input"
  }
  const answered = new Set()
  for (const block of resultBlocks) {
    if (!ids.has(block.tool_use_id) || answered.has(block.tool_use_id)) return "unmatched_tool_result"
    answered.add(block.tool_use_id)
  }
  return answered.size === ids.size ? null : "missing_tool_result"
}

function stableJSON(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item)
}

function parseUserImage(block) {
  if (block?.type !== "image") return null
  const mediaType = String(block.source?.media_type || "").toLowerCase()
  return imageContent({ ...block, source: { ...block.source, media_type: mediaType === "image/jpg" ? "image/jpeg" : mediaType } })
}

function parseUserDocumentText(block, inToolResult = false) {
  if (block?.type !== "document") return ""
  const text = documentText(block, { inToolResult })
  if (text === null) {
    const { what, hint } = documentRefusal(block)
    throw new UnsupportedContent(what, hint)
  }
  return text
}

function parseSearchResultText(block) {
  if (block?.type !== "search_result") return ""
  const header = [block.title, block.source].filter((item) => typeof item === "string" && item.trim()).join(" — ")
  const body = Array.isArray(block.content)
    ? block.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n")
    : typeof block.content === "string" ? block.content : ""
  return header ? `[search result: ${header}]\n${body}\n[end of search result]` : body
}

const SERVER_TOOL_RESULT_BLOCK_TYPES = new Set([
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
  "mcp_tool_result",
  "advisor_tool_result",
])

const ASSISTANT_ALLOWED_BLOCK_TYPES = new Set([
  "text",
  "tool_use",
  "thinking",
  "redacted_thinking",
  "server_tool_use",
  "mcp_tool_use",
  "container_upload",
  ...SERVER_TOOL_RESULT_BLOCK_TYPES,
])

function renderServerAssistantBlock(block) {
  if (!block || typeof block !== "object") return ""
  if (block.type === "server_tool_use" || block.type === "mcp_tool_use") {
    return `[server tool call ${block.name || block.type} id=${block.id || ""} args=${JSON.stringify(block.input ?? {})}]`
  }
  if (block.type === "container_upload") {
    return block.file_id ? `[container upload ${block.file_id}]` : ""
  }
  if (SERVER_TOOL_RESULT_BLOCK_TYPES.has(block.type)) {
    return `[${block.type}${block.tool_use_id ? " id=" + block.tool_use_id : ""}] ${JSON.stringify(block.content ?? "")}`
  }
  return ""
}

const MAGPIE_PLACEHOLDER_NOTICE = "Values written like {{NAME_ab12cd34}} are placeholders for real values. Use them exactly as written, in replies and in tool calls alike: they are filled in with the real values before anything runs. Don't ask to verify them, and don't replace them with examples."
const MAGPIE_PLACEHOLDER_NOTICE_RE = /(?:^|\n\n)Values written like \{\{NAME_ab12cd34\}\} are placeholders for real values\. Use them exactly as written, in replies and in tool calls alike: they are filled in with the real values before anything runs\. Don't ask to verify them, and don't replace them with examples\.(?=\s|$)/g

function stripMagpiePlaceholderNotice(text) {
  if (typeof text !== "string" || !text.includes("{{NAME_ab12cd34}}")) return text
  return text.replace(MAGPIE_PLACEHOLDER_NOTICE_RE, "")
}

// Clear tool_use.input values so a later history comparison can ignore
// client-canonicalized arguments after raw tool_use ids and names match.
function stripToolUseInputs(messages) {
  if (!Array.isArray(messages)) return messages
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((block) => block?.type === "tool_use"
        ? { type: "tool_use", id: block.id, name: block.name, input: {} }
        : block)
      : message.content,
  }))
}

function stripBillingHeader(text) {
  let s = String(text ?? "")
  s = s.replace(/^[ \t]*x-anthropic-billing-header:[^\n]*\n?/gmi, "")
  s = s.replace(/^[ \t]*cch=[0-9a-fA-F]+;?[ \t]*\n?/gmi, "")
  return s
}

const ISO_DATE = String.raw`20\d{2}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?`
const LOCALE_DATE = String.raw`(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?`
const CLOCK_VALUE = String.raw`(?:${ISO_DATE}|${LOCALE_DATE}|\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?)`
const AGENT_CLOCK_LINE_RE = new RegExp(
  String.raw`^(?:#{1,6}\s*)?(?:(?:(?:current\s+)?(?:date|time|datetime|today|now)|today(?:'s)?\s+date|(?:the\s+)?current\s+(?:date|time|datetime))\s*[:：]\s*${CLOCK_VALUE}|(?:(?:the\s+)?current\s+(?:date|time|datetime)|today(?:'s)?\s+date)\s+is\s+${CLOCK_VALUE})\s*\.?$`,
  "i",
)

function isAgentClockLine(line) {
  return AGENT_CLOCK_LINE_RE.test(String(line ?? "").trim())
}

function stripAgentClockLines(text) {
  const s = String(text ?? "")
  if (!s) return s
  return s.split(/(\n)/).map((part) => (part === "\n" || !isAgentClockLine(part) ? part : "")).join("")
}

// System prompt and session instructions: billing headers plus known agent
// clock lines. User text is never passed through this helper.
function stripVolatileSystem(text) {
  return stripAgentClockLines(stripBillingHeader(text))
}

function instructionsIdentity(text) {
  return compactIdentity(stripVolatileSystem(text))
}

function asciiLower(s) {
  return String(s ?? "").replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32))
}

function replaceClosedSystemReminders(text, replacer) {
  const s = String(text ?? "")
  if (!s) return s
  const open = "<system-reminder"
  const close = "</system-reminder>"
  const lower = asciiLower(s)
  let out = ""
  let i = 0
  while (i < s.length) {
    const start = lower.indexOf(open, i)
    if (start === -1) {
      out += s.slice(i)
      break
    }
    const afterName = start + open.length
    if (afterName < s.length && /[A-Za-z0-9_]/.test(s[afterName])) {
      out += s.slice(i, afterName)
      i = afterName
      continue
    }
    const gt = s.indexOf(">", afterName)
    if (gt === -1) {
      out += s.slice(i)
      break
    }
    const closeAt = lower.indexOf(close, gt + 1)
    if (closeAt === -1) {
      // No closer after this tag means none exists later either; keep the rest
      // verbatim so later openers do not rescan the same suffix.
      out += s.slice(i)
      break
    }
    const end = closeAt + close.length
    out += s.slice(i, start) + replacer(s.slice(start, end))
    i = end
  }
  return out
}

function stripVolatileOpening(text) {
  return replaceClosedSystemReminders(stripBillingHeader(text), (block) => stripAgentClockLines(block))
}

function historyKey(messages) {
  const rows = []
  const ids = new Map()
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content ?? "" }]
    for (const block of blocks) {
      if (!block) continue
      if (block.type === "thinking" || block.type === "redacted_thinking" ||
        block.type === "tool_addition" || block.type === "tool_removal") continue
      let value
      if (typeof block === "string" || block.type === "text") {
        value = { type: "text", text: stripVolatileOpening(stripMagpiePlaceholderNotice(typeof block === "string" ? block : block.text || "")) }
      } else if (block.type === "document") {
        value = { type: "text", text: parseUserDocumentText(block) }
      } else if (block.type === "search_result") {
        value = { type: "text", text: parseSearchResultText(block) }
      } else if (block.type === "image") {
        const image = parseUserImage(block)
        value = { type: "image", mimeType: image.mimeType, sha256: digest(image.data) }
      } else if (block.type === "tool_use") {
        const ordinal = ids.size + 1
        ids.set(block.id, ordinal)
        value = { type: "tool_use", id: ordinal, name: block.name, input: block.input ?? {} }
      } else if (block.type === "tool_result") {
        const result = toolResult(block)
        // An image a tool returned is keyed by its hash, as a user's image
        // is, not copied whole into the key on every round-trip (plugins#1137).
        const content = result.content.map((part) => part.type === "image"
          ? { type: "image", mimeType: part.mimeType, sha256: digest(part.data) }
          : part)
        value = { type: "tool_result", id: ids.get(block.tool_use_id) ?? block.tool_use_id, ...result, content }
      } else if (block.type === "server_tool_use" || block.type === "mcp_tool_use" ||
        block.type === "container_upload" || SERVER_TOOL_RESULT_BLOCK_TYPES.has(block.type)) {
        value = { type: block.type, name: block.name || "", content: renderServerAssistantBlock(block) }
      } else {
        value = block
      }
      let row = rows.at(-1)
      if (!row || row.role !== message.role) {
        row = { role: message.role, content: [] }
        rows.push(row)
      }
      const last = row.content.at(-1)
      if (last?.type === "text" && value.type === "text") last.text += value.text
      else row.content.push(value)
    }
  }
  for (const row of rows) {
    row.content = row.content.filter(block => block.type !== "text" || (block.text = block.text.trim()) !== "")
  }
  return stableJSON(rows.filter(row => row.content.length))
}

// Assistant-prefill support: a trailing text-only assistant message is a
// client-side prefill (chat/roleplay frontends, "continue"/"impersonate"
// flows, bot frameworks). Keep the run in the tail so the session ledger
// (expectedMessages, client bytes) stays aligned with the client's own
// history across turns, and render it as a continuation carrier instead of
// the system-reminder treatment. AGY_BRIDGE_PREFILL=0 restores the stock
// reject; AGY_BRIDGE_PREFILL_CARRIER_NOTE overrides the carrier's note line.
const prefillTailEnabled = () => process.env.AGY_BRIDGE_PREFILL !== "0"
const prefillCarrierNote = () => process.env.AGY_BRIDGE_PREFILL_CARRIER_NOTE
  || "(system note: the fragment below is part of your own unfinished reply; continue exactly from where it stops, and do not repeat it.)"

// Concatenated text of an assistant message, skipping thinking metadata blocks,
// or null when the message carries tool/non-text blocks. Empty string means "no content".
function assistantTextOf(message) {
  if (!message || message.role !== "assistant") return null
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return null
  let text = ""
  for (const block of message.content) {
    if (!block) return null
    if (block.type === "thinking" || block.type === "redacted_thinking") continue
    if (block.type !== "text" || typeof block.text !== "string") return null
    text += block.text
  }
  return text
}

// History/tail positions for a request that ends with an assistant prefill
// run: runStart = first message of the trailing text-only assistant run,
// boundary = history split point (after the last assistant message before the
// run, the session ledger's newest entry). Returns null when the request does
// not end with a text-only assistant run. Known limits: a request combining a
// live tool_result with a prefill tail is rejected in validateBody; a run with
// no user message before it (contiguous assistant tail, e.g. a client re-sending
// a completed reply with a prefill appended) puts the whole run in the tail, so
// that one turn degrades to a fresh session (safe, self-healing).
function prefillRun(messages) {
  const last = messages.at(-1)
  if (!last || last.role !== "assistant") return null
  if (assistantTextOf(last) === null) return null
  let runStart = messages.length
  while (runStart > 0 && messages[runStart - 1]?.role === "assistant" && assistantTextOf(messages[runStart - 1]) !== null) runStart--
  let boundary = runStart
  while (boundary > 0 && messages[boundary - 1]?.role !== "assistant") boundary--
  return { runStart, boundary }
}

function renderPrefillCarrierParts(message) {
  const body = (assistantTextOf(message) || "").trim()
  if (!body) return []
  return [{ type: "text", text: `${prefillCarrierNote()}\n${body}` }]
}

function trailingMessages(body) {
  body = canonicalBody(body)
  const run = prefillTailEnabled() ? prefillRun(body.messages) : null
  if (run) {
    return { history: body.messages.slice(0, run.boundary), messages: body.messages.slice(run.boundary) }
  }
  let start = body.messages.length
  while (start > 0 && body.messages[start - 1].role !== "assistant") start--
  return { history: body.messages.slice(0, start), messages: body.messages.slice(start) }
}

function lastAssistantCalls(messages) {
  let start = messages.length
  while (start > 0 && messages[start - 1].role === "assistant") start--
  return messages.slice(start).flatMap(message => Array.isArray(message.content)
    ? message.content.filter(block => block.type === "tool_use") : [])
}

// A bridge call's id, as #handleMcpCall makes it.
const BRIDGE_CALL_ID = /^toolu_[0-9a-f]{24}$/

// Hermes Agent unrolls a batching call it executes, tool_call({calls: [a, b,
// c]}), into one tool_call per entry in its own history: the first keeps the
// bridge's id, the others get ids of Hermes' own (call_<hex>), and each gets
// a result (NieiR, plugins#1150). No call but the first is agy's, so their
// results matched nothing and the turn ended in 409. Folded back here, the
// round is the one agy made: one call, its input's array the entries joined
// in order, and one result, the entries' results joined in order. Folded
// only when a run of same-named calls opens with a bridge id, every other
// one has an id the bridge never makes, and every input is an object with
// the same single array field.
function foldSplitCalls(body) {
  const messages = body?.messages
  if (!Array.isArray(messages)) return body
  let changed = false
  const out = messages.map((message) => message)
  for (let index = 0; index < out.length; index++) {
    const message = out[index]
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue
    const uses = message.content.filter((block) => block?.type === "tool_use")
    if (uses.length < 2) continue
    const head = uses[0]
    if (!BRIDGE_CALL_ID.test(head.id ?? "") || uses.slice(1).some((use) => BRIDGE_CALL_ID.test(use.id ?? "") || !use.id)) continue
    if (uses.some((use) => use.name !== head.name)) continue
    const keyOf = (use) => {
      const input = use.input
      if (!input || typeof input !== "object" || Array.isArray(input)) return null
      const keys = Object.keys(input)
      return keys.length === 1 && Array.isArray(input[keys[0]]) ? keys[0] : null
    }
    const key = keyOf(head)
    if (!key || uses.some((use) => keyOf(use) !== key)) continue
    const ids = new Set(uses.map((use) => use.id))
    if (ids.size !== uses.length) continue
    // the results: in the messages after this one, up to the next assistant
    const results = []
    let end = index + 1
    while (end < out.length && out[end]?.role !== "assistant") end++
    for (let at = index + 1; at < end; at++) {
      const content = out[at]?.content
      if (!Array.isArray(content)) continue
      for (const block of content) if (block?.type === "tool_result" && ids.has(block.tool_use_id)) results.push(block)
    }
    // a round still waiting has no results; one with some missing is left as it is
    if (results.length && results.length !== uses.length) continue
    const folded = { ...head, input: { [key]: uses.flatMap((use) => use.input[key]) } }
    out[index] = { ...message, content: message.content.filter((block) => block?.type !== "tool_use" || block === head).map((block) => (block === head ? folded : block)) }
    if (results.length) {
      const byId = new Map(results.map((block) => [block.tool_use_id, block]))
      const parts = (block) => typeof block.content === "string" ? [{ type: "text", text: block.content }]
        : Array.isArray(block.content) ? block.content : block.content == null ? [] : [block.content]
      const ordered = uses.map((use) => byId.get(use.id))
      const merged = { ...byId.get(head.id), content: ordered.flatMap(parts) }
      if (ordered.every((block) => block.is_error)) merged.is_error = true
      else delete merged.is_error
      for (let at = index + 1; at < end; at++) {
        const content = out[at]?.content
        if (!Array.isArray(content) || !content.some((block) => block?.type === "tool_result" && ids.has(block.tool_use_id))) continue
        out[at] = { ...out[at], content: content.flatMap((block) => {
          if (block?.type !== "tool_result" || !ids.has(block.tool_use_id)) return [block]
          return block.tool_use_id === head.id ? [merged] : []
        }) }
      }
      // a message left with nothing (its results all folded away) goes
      for (let at = end - 1; at > index; at--) {
        if (Array.isArray(out[at]?.content) && out[at].content.length === 0) { out.splice(at, 1); end-- }
      }
    }
    changed = true
  }
  return changed ? { ...body, messages: out } : body
}

function systemText(body) {
  if (!body.system) return ""
  return typeof body.system === "string" ? body.system : body.system.map((block) => block.text || "").join("\n")
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((block) => (typeof block === "string" ? block : block?.type === "text" ? block.text || "" : "")).join("")
}

// Streaming clients may inline the opening system prompt, then hoist it into
// `system` on a non-streaming retry. Trailing system notifications remain turn
// content, as in the existing protocol; only the opening prefix is lifted. (A
// wider rule that also lifted system messages before the first assistant would
// change a conversation's key between its first and second turn.)
function canonicalBody(body) {
  const messages = body?.messages
  if (!Array.isArray(messages)) return body
  let count = 0
  while (count < messages.length && messages[count]?.role === "system") count++
  if (!count || count === messages.length) return body
  const parts = [systemText(body), ...messages.slice(0, count).map((message) => contentText(message.content))]
  return { ...body, system: parts.filter((text) => text.trim()).join("\n\n"), messages: messages.slice(count) }
}

// inline: the opening system text arrived as messages; hoisted: in the system field.
function compactIdentity(text) {
  return String(text ?? "").replace(/\s+/g, "")
}

function sameInstructions(a, b) {
  return instructionsIdentity(a) === instructionsIdentity(b)
}

// The model is not part of the key: agy switches models inside a live session.
function requestSessionScope(fetchInput, init) {
  const headers = new Headers(
    init?.headers ?? (fetchInput instanceof Request ? fetchInput.headers : undefined) ?? {},
  )
  const rawSession = headers.get("x-magpie-session")?.trim() || ""
  const session = /^magpie-[0-9a-f]{24}$/.test(rawSession) ? "" : rawSession.slice(0, 128)
  const subagent = (headers.get("x-magpie-subagent")?.trim() || "").slice(0, 64)
  return session || subagent ? `${session}\n${subagent}` : ""
}

function appendSchemaHint(node, hint) {
  if (!hint) return
  if (typeof node.description === "string" && node.description.trim()) {
    if (!node.description.includes(hint)) node.description = `${node.description} (${hint})`
  } else {
    node.description = hint
  }
}


// Sanitize JSON Schema constructs that agy's Google Code Assist translator
// converts into invalid Schema protos (e.g. union types leaving stale array/object
// keywords, or non-string/empty enum entries producing `enum[0]: cannot be empty`).
function sanitizeInputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema
  const out = { ...schema }

  if (Array.isArray(out.type)) {
    const types = out.type.filter((item) => typeof item === "string")
    const nullable = types.includes("null")
    const nonNull = types.filter((item) => item !== "null")
    if (nonNull.length > 1) {
      let chosen = nonNull[0]
      if (nonNull.includes("array") && out.items !== undefined) chosen = "array"
      else if (nonNull.includes("object") && (out.properties !== undefined || out.additionalProperties !== undefined)) {
        chosen = "object"
      }
      out.type = nullable ? [chosen, "null"] : chosen
      appendSchemaHint(out, `Accepts types: ${types.join(" | ")}`)
    } else if (nonNull.length === 1) {
      out.type = nullable ? [nonNull[0], "null"] : nonNull[0]
    }
  }

  const resolvedType = typeof out.type === "string"
    ? out.type
    : Array.isArray(out.type)
      ? out.type.find((item) => item !== "null") || null
      : null

  if (resolvedType && resolvedType !== "array") {
    delete out.items
    delete out.prefixItems
    delete out.minItems
    delete out.maxItems
    delete out.uniqueItems
    delete out.contains
  }
  if (resolvedType && resolvedType !== "object") {
    delete out.properties
    delete out.patternProperties
    delete out.required
    delete out.minProperties
    delete out.maxProperties
    delete out.dependentRequired
  }

  if (Array.isArray(out.enum)) {
    const invalidEnum = out.enum.length === 0 ||
      (resolvedType && resolvedType !== "string") ||
      out.enum.some((item) => typeof item !== "string" || item.length === 0)
    if (invalidEnum) {
      if (out.enum.length) {
        appendSchemaHint(out, `Allowed values: ${out.enum.map((item) => JSON.stringify(item)).join(", ")}`)
      }
      delete out.enum
    }
  }

  if (out.const !== undefined && (typeof out.const !== "string" || out.const.length === 0 || (resolvedType && resolvedType !== "string"))) {
    appendSchemaHint(out, `Must equal: ${JSON.stringify(out.const)}`)
    delete out.const
  }

  if (out.properties && typeof out.properties === "object" && !Array.isArray(out.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) => [key, sanitizeInputSchema(value)]),
    )
    if (Array.isArray(out.required)) {
      const filtered = out.required.filter((key) => typeof key === "string" && Object.hasOwn(out.properties, key))
      if (filtered.length) out.required = filtered
      else delete out.required
    }
  }
  if (out.patternProperties && typeof out.patternProperties === "object" && !Array.isArray(out.patternProperties)) {
    out.patternProperties = Object.fromEntries(
      Object.entries(out.patternProperties).map(([key, value]) => [key, sanitizeInputSchema(value)]),
    )
  }
  if (out.additionalProperties && typeof out.additionalProperties === "object" && !Array.isArray(out.additionalProperties)) {
    out.additionalProperties = sanitizeInputSchema(out.additionalProperties)
  }
  if (Array.isArray(out.items)) {
    out.items = out.items.map((item) => sanitizeInputSchema(item))
  } else if (out.items && typeof out.items === "object") {
    out.items = sanitizeInputSchema(out.items)
  }
  if (Array.isArray(out.prefixItems)) {
    out.prefixItems = out.prefixItems.map((item) => sanitizeInputSchema(item))
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(out[key])) out[key] = out[key].map((item) => sanitizeInputSchema(item))
  }
  if (out.not && typeof out.not === "object" && !Array.isArray(out.not)) {
    out.not = sanitizeInputSchema(out.not)
  }
  for (const defsKey of ["$defs", "definitions"]) {
    if (out[defsKey] && typeof out[defsKey] === "object" && !Array.isArray(out[defsKey])) {
      out[defsKey] = Object.fromEntries(
        Object.entries(out[defsKey]).map(([key, value]) => [key, sanitizeInputSchema(value)]),
      )
    }
  }
  for (const key of ["propertyNames", "contains", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems"]) {
    if (out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = sanitizeInputSchema(out[key])
    }
  }
  if (out.dependentSchemas && typeof out.dependentSchemas === "object" && !Array.isArray(out.dependentSchemas)) {
    out.dependentSchemas = Object.fromEntries(
      Object.entries(out.dependentSchemas).map(([key, value]) => [key, sanitizeInputSchema(value)]),
    )
  }
  // agy (Go/RE2) will reject the whole toolbox if any pattern is only valid as
  // ECMA-262. Translate or drop those patterns here; tool-call arguments in
  // the response are plain JSON and do not need a reverse transform.
  sanitizePatternFields(out)
  return out
}

function normalizeTools(body) {
  if (!Array.isArray(body.tools) || !body.tools.length) return []
  const choice = body.tool_choice
  if (choice === "none" || choice?.type === "none") return []
  const selected = choice?.type === "tool" ? choice.name : null
  const seen = new Set()
  const tools = []
  for (const tool of body.tools) {
    if (!tool || typeof tool.name !== "string" || !tool.name) {
      throw new UnsupportedContent("a tool without a valid name")
    }
    if (seen.has(tool.name)) throw new UnsupportedContent(`duplicate tool ${tool.name}`)
    seen.add(tool.name)
    if (selected && tool.name !== selected) continue
    const rawSchema = tool.input_schema ?? { type: "object", properties: {} }
    if (!rawSchema || typeof rawSchema !== "object" || Array.isArray(rawSchema)) {
      throw new UnsupportedContent(`an invalid schema for tool ${tool.name}`)
    }
    const inputSchema = ensureGeminiArrayItems(sanitizeInputSchema(expandToolSchema(rawSchema)))
    // agy adds its own required toolSummary to MCP tools. A duplicate makes
    // the resulting JSON Schema invalid before the agent can start.
    if (tool.name === "run_command" && Array.isArray(inputSchema.required)) {
      inputSchema.required = inputSchema.required.filter((key) => key !== "toolSummary")
    }
    tools.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema,
    })
  }
  if (selected && !tools.length) throw new UnsupportedContent(`tool_choice names undeclared tool ${selected}`)
  return tools
}

function blockText(block) {
  if (typeof block === "string") return block
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new UnsupportedContent("a non-object content block")
  }
  if (block.type === "text") return typeof block.text === "string" ? block.text : ""
  if (block.type === "tool_addition" || block.type === "tool_removal") return ""
  if (block.type === "tool_reference" && typeof block.tool_name === "string") {
    return `Loaded tool: ${block.tool_name}`
  }
  if (block.type === "document") return parseUserDocumentText(block)
  if (block.type === "search_result") return parseSearchResultText(block)
  if (block.type === "image") {
    parseUserImage(block)
    return "[image]"
  }
  if (block.type === "tool_result") {
    const inner = Array.isArray(block.content)
      ? block.content.map((part) => {
        if (part?.type === "image") return "[image returned by tool]"
        if (part?.type === "document") return parseUserDocumentText(part, true)
        return blockText(part)
      }).join("")
      : String(block.content ?? "")
    return `[tool result${block.tool_use_id ? " id=" + block.tool_use_id : ""}]\n${inner}\n[end of tool result]`
  }
  if (block.type === "tool_use") throw new UnsupportedContent("a tool_use block in a user message")
  throw new UnsupportedContent(`a content block of type ${JSON.stringify(block.type)}`)
}

function messageText(message) {
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) return message.content.map(blockText).join("")
  return String(message.content ?? "")
}

function imageContent(block) {
  const source = block.source
  if (source?.type !== "base64") {
    throw new UnsupportedContent("an image source other than base64; provide inline image data instead of a URL")
  }
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(source.media_type)) {
    throw new UnsupportedContent("an image media type other than PNG, JPEG, GIF or WebP")
  }
  if (typeof source.data !== "string" || !source.data ||
    source.data.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(source.data.replace(/={1,2}$/, ""))) {
    throw new UnsupportedContent("invalid base64 image data")
  }
  return { type: "image", data: source.data, mimeType: source.media_type }
}

// Keep text adjacent to its images, including when an old conversation has to
// be replayed. Never interpolate image bytes into the text seen by the model.
function appendPrompt(out, content) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content
  for (const block of blocks) {
    const last = out.at(-1)
    if (last?.type === "text" && block.type === "text") last.text += block.text
    else out.push({ ...block })
  }
}

function renderAssistantTurn(message) {
  const parts = []
  const blocks = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: String(message.content ?? "") }]
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text || "")
    else if (block.type === "tool_use") {
      parts.push(`[tool call ${block.name} id=${block.id || ""} args=${JSON.stringify(block.input ?? {})}]`)
    } else {
      const rendered = renderServerAssistantBlock(block)
      if (rendered) parts.push(rendered)
    }
  }
  return parts.join("\n")
}

function outputFormatReminder(body) {
  const format = body?.output_config?.format || body?.response_format
  if (!format || typeof format !== "object") return []
  if (format.type === "json_schema") {
    const schema = format.schema ?? format.json_schema?.schema
    if (schema && typeof schema === "object") {
      return [{
        type: "text",
        text: `<system-reminder>\nStructured output requirement: Respond ONLY with a single valid JSON value (no Markdown code fences, no backticks, and no explanatory prose before or after) conforming strictly to this JSON Schema:\n${JSON.stringify(schema)}\n</system-reminder>`,
      }]
    }
  }
  if (format.type === "json_object") {
    return [{
      type: "text",
      text: "<system-reminder>\nStructured output requirement: Respond ONLY with a single valid JSON object (no Markdown code fences, no backticks, and no explanatory prose before or after).\n</system-reminder>",
    }]
  }
  return []
}

function workDirNote(callerWorkDir) {
  return `The caller's working directory is ${JSON.stringify(callerWorkDir)}. The environment the caller describes (working directory, platform, OS, shell, git status) is where every tool runs. The bridge's temporary workspace only holds its agent configuration; use the caller's environment for tool paths and commands.`
}

const QUEUED_PROMPT_PREFIX_RE = /^(?:The user sent (?:a new message while you were working|the following message)|The [^\r\n]+ plugin sent a message while you were working):\n([\s\S]*)$/
const QUEUED_PROMPT_SUFFIX_RE = /\n\n(?:This is how Claude Code surfaces (?:messages the user sends|prompts [^\r\n]+ submits) mid-turn[\s\S]*|IMPORTANT: After completing your current task, you MUST address the user's message above\. Do not ignore it\.|Please address this message and continue with your tasks\.)\s*$/

function extractQueuedPrompt(raw) {
  if (typeof raw !== "string") return null
  const cleanedRaw = stripMagpiePlaceholderNotice(raw)
  const hadPlaceholder = cleanedRaw !== raw
  let trimmed = cleanedRaw.trim()
  const reminder = /^<system-reminder(?:\s[^>]*)?>([\s\S]*)<\/system-reminder(?:\s[^>]*)?>$/.exec(trimmed)
  if (reminder) trimmed = reminder[1].trim()
  const match = QUEUED_PROMPT_PREFIX_RE.exec(trimmed)
  if (!match) return null
  const unwrapped = match[1].replace(QUEUED_PROMPT_SUFFIX_RE, "").trim()
  if (!hadPlaceholder) return unwrapped
  const placeholderTag = `<system-reminder>\n${MAGPIE_PLACEHOLDER_NOTICE}\n</system-reminder>`
  return unwrapped ? `${unwrapped}\n\n${placeholderTag}` : placeholderTag
}

function renderTurnMessage(message) {
  if (message.role === "user") {
    if (typeof message.content === "string") {
      const queued = extractQueuedPrompt(message.content)
      return queued !== null ? queued : message.content
    }
    if (Array.isArray(message.content)) {
      const out = []
      let afterToolResult = false
      for (const block of message.content) {
        if (block?.type === "tool_result") {
          out.push(blockText(block))
          afterToolResult = true
          continue
        }
        const raw = blockText(block)
        const queued = block?.type === "text" ? extractQueuedPrompt(raw) : null
        const rendered = queued !== null ? queued : raw
        if (rendered && afterToolResult && !rendered.startsWith("\n")) {
          out.push("\n\n" + rendered)
        } else {
          out.push(rendered)
        }
        if (rendered) afterToolResult = false
      }
      return out.join("")
    }
    return messageText(message)
  }
  const blocks = Array.isArray(message.content) ? message.content : [message.content]
  const reminders = []
  const queuedParts = []
  for (const block of blocks) {
    const raw = blockText(block)
    const trimmed = raw.trim()
    if (!trimmed) continue
    const queued = extractQueuedPrompt(trimmed)
    if (queued !== null) {
      if (queued) queuedParts.push(queued)
    } else {
      reminders.push(raw)
    }
  }
  const out = []
  const joinedReminders = reminders.join("").trim()
  if (joinedReminders) {
    out.push(/^<system-reminder(?:\s[^>]*)?>[\s\S]*<\/system-reminder(?:\s[^>]*)?>$/.test(joinedReminders)
      ? joinedReminders
      : `<system-reminder>\n${joinedReminders}\n</system-reminder>`)
  }
  out.push(...queuedParts)
  return out.join("\n\n")
}

function renderTurnMessageParts(message) {
  if (message.role !== "user" || !Array.isArray(message.content)) {
    let text = renderTurnMessage(message)
    // a system or developer message later in the chat is system text too
    if (message.role === "system" || message.role === "developer") text = outgoing(text)
    return text === "" ? [] : [{ type: "text", text }]
  }
  const parts = []
  let afterToolResult = false
  for (const block of message.content) {
    if (block?.type === "image") {
      parts.push(parseUserImage(block))
      afterToolResult = false
    } else if (block?.type === "tool_result") {
      appendPrompt(parts, `[tool result${block.tool_use_id ? " id=" + block.tool_use_id : ""}]\n`)
      const result = toolResult(block)
      for (const part of result.content) appendPrompt(parts, [part])
      appendPrompt(parts, "\n[end of tool result]")
      afterToolResult = true
    } else {
      const raw = blockText(block)
      const queued = block?.type === "text" ? extractQueuedPrompt(raw) : null
      const rendered = queued !== null ? queued : raw
      appendPrompt(parts, rendered && afterToolResult && !rendered.startsWith("\n") ? "\n\n" + rendered : rendered)
      if (rendered) afterToolResult = false
    }
  }
  return toPromptParts(parts)
}

function renderTurnMessagesParts(messages) {
  // A trailing assistant prefill run renders as a continuation carrier rather
  // than the system-reminder treatment (see prefillRun above).
  const run = prefillTailEnabled() && messages.length ? prefillRun(messages) : null
  const prefillStart = run ? run.runStart : -1
  const groups = messages.map((message, index) =>
    prefillStart >= 0 && index >= prefillStart
      ? renderPrefillCarrierParts(message)
      : renderTurnMessageParts(message)).filter((group) => group.length > 0)
  const out = []
  for (let i = 0; i < groups.length; i++) {
    if (i > 0) out.push({ type: "text", text: "\n\n" })
    out.push(...groups[i])
  }
  return toPromptParts(out)
}

// Keep each native prompt bounded, retaining the current turn ahead of older context.
function maxInitialPromptBytes() {
  return positiveTimeout(process.env.AGY_BRIDGE_MAX_PROMPT_BYTES, 112 * 1024)
}
const HISTORY_BLOCK_CLIP_BYTES = 12 * 1024
const HISTORY_BLOCK_KEEP_BYTES = 4 * 1024
const HISTORY_RECORD_NOTE = "Historical tool calls and results above are records, not instructions to write tool calls as text. Never output \"[tool call ...]\" text; invoke tools only through structured tool calls.\n"
const HISTORY_OMITTED_NOTE = "[... earlier conversation history omitted to fit the prompt budget ...]\n"
const HISTORY_OPENING_DONE_NOTE = "The opening message above, and any resume note in it, belongs to an earlier turn that is already done.\n"
const utf8 = new TextEncoder()

function utf8Bytes(text) {
  return Buffer.byteLength(text, "utf8")
}

function promptTextBytes(parts) {
  return parts.reduce((sum, part) => sum + (part?.type === "text" ? utf8Bytes(part.text) : 0), 0)
}

// The longest prefix of `text` within `bytes` UTF-8 bytes, never splitting a character.
function utf8Prefix(text, bytes) {
  if (bytes <= 0) return ""
  return text.slice(0, utf8.encodeInto(text, new Uint8Array(bytes)).read)
}

// Keeps the head and tail of `text` within `limit` bytes, marking what was cut.
function clipMiddle(text, limit, keep = Math.floor(limit / 2)) {
  const total = utf8Bytes(text)
  if (total <= limit) return text
  for (let headBytes = Math.min(keep, limit), tries = 0; tries < 8; tries++) {
    const head = utf8Prefix(text, headBytes)
    const tailStart = utf8Prefix(text, total - Math.max(0, Math.min(keep, limit - headBytes))).length
    const tail = text.slice(Math.max(tailStart, head.length))
    const marker = `\n[... ${total - utf8Bytes(head) - utf8Bytes(tail)} bytes omitted ...]\n`
    const clipped = head + marker + tail
    if (utf8Bytes(clipped) <= limit) return clipped
    keep = Math.floor(keep * 0.75)
    headBytes = Math.min(keep, limit)
  }
  return utf8Prefix(text, limit)
}

function clipHistoryText(text) {
  if (typeof text !== "string" || utf8Bytes(text) <= HISTORY_BLOCK_CLIP_BYTES) return text
  return headTail(text)
}

// Head 4 KiB + an omission note + tail 4 KiB of one oversized history block.
function headTail(text) {
  const total = utf8Bytes(text)
  const head = utf8Prefix(text, HISTORY_BLOCK_KEEP_BYTES)
  const tail = text.slice(utf8Prefix(text, total - HISTORY_BLOCK_KEEP_BYTES).length)
  return `${head}\n[... ${total - utf8Bytes(head) - utf8Bytes(tail)} bytes of this history block omitted ...]\n${tail}`
}

// A copy of a history message whose oversized text blocks, tool results and
// tool-call arguments keep only their head and tail. The original is untouched.
function clipHistoryMessage(message) {
  if (typeof message.content === "string") return { ...message, content: clipHistoryText(message.content) }
  if (!Array.isArray(message.content)) return message
  return {
    ...message,
    content: message.content.map((block) => {
      if (block?.type === "text" && typeof block.text === "string") return { ...block, text: clipHistoryText(block.text) }
      if (block?.type === "tool_result") {
        if (typeof block.content === "string") return { ...block, content: clipHistoryText(block.content) }
        if (Array.isArray(block.content)) {
          return { ...block, content: block.content.map((part) => part?.type === "text" && typeof part.text === "string"
            ? { ...part, text: clipHistoryText(part.text) } : part) }
        }
      }
      if (block?.type === "tool_use") {
        const args = JSON.stringify(block.input ?? {})
        if (utf8Bytes(args) > HISTORY_BLOCK_CLIP_BYTES) return { ...block, input: { truncated_arguments: headTail(args) } }
      }
      return block
    }),
  }
}

function renderHistoryEntry(message) {
  const out = []
  if (message.role === "assistant") {
    appendPrompt(out, `Assistant: ${renderAssistantTurn(message)}\n`)
  } else {
    const queued = message.role !== "user" && extractQueuedPrompt(messageText(message).trim()) !== null
    appendPrompt(out, message.role === "user" || queued ? "Human: " : `${message.role}: `)
    appendPrompt(out, renderTurnMessageParts(message))
    appendPrompt(out, "\n")
  }
  return out
}

// Shrinks the largest text parts (head and tail kept) until the text fits `limit`.
function clipPartsToBytes(parts, limit) {
  const out = parts.map((part) => ({ ...part }))
  for (let guard = 0; guard < 64; guard++) {
    const excess = promptTextBytes(out) - limit
    if (excess <= 0) break
    let largest = null
    for (const part of out) {
      if (part.type === "text" && (!largest || utf8Bytes(part.text) > utf8Bytes(largest.text))) largest = part
    }
    if (!largest) break
    const size = utf8Bytes(largest.text)
    largest.text = clipMiddle(largest.text, Math.max(0, size - excess))
  }
  return out
}

// Claude Code's and DeepSeek Harness's own user-role notes: reminders, context
// notices, local command output, interrupt markers, clock and runtime-context
// snapshots, repeat-tool warnings and mode switches. A user message of these
// alone is not a prompt from the user (#1055).
const LOCAL_COMMAND_RE = /<(local-command-caveat|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g
const DSH_TIME_CONTEXT_RE = /(?:^|\r?\n)Time sampled while preparing turn \d+, step \d+: [^\r\n]+(?:\r?\nBrowser time zone for this request: [^\r\n]+)?(?:\r?\nElapsed since the preceding (?:model-visible message|step context): [^\r\n]+)?/g
const DSH_REPEAT_TOOL_RE = /(?:^|\r?\n)(?:You are repeating the exact same tool call with identical arguments\. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call\.|Repeated tool call detected:\r?\n- tool: [^\r\n]+\r?\n- consecutive_calls: \d+\r?\n- arguments: [^\r\n]+\r?\nThe repeated calls are not making progress\. Do not call this tool with these exact arguments again\. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered\.)/g
const DSH_PLAN_MODE_RE = /(?:^|\r?\n)The user switched this session (?:to plan|back to the default) mode\.(?=\r?\n|$)/g
// DeepSeek Harness sends a runtime-context snapshot as its own user message;
// a gateway that merges user messages into one string could lose text after it.
const DSH_RUNTIME_SNAPSHOT_RE = /^Current runtime context(?:\. This snapshot supersedes earlier runtime-context snapshots\.(?:\r?\n[\s\S]*)?|: none\. Earlier runtime-context snapshots no longer apply\.)$/

function isMetaOnlyUserText(text) {
  const rest = stripMagpiePlaceholderNotice(text)
    .replace(SYSTEM_REMINDER_RE, "")
    .replace(CONTEXT_NOTICE_RE, "")
    .replace(LOCAL_COMMAND_RE, "")
    .replace(DSH_TIME_CONTEXT_RE, "")
    .replace(DSH_REPEAT_TOOL_RE, "")
    .replace(DSH_PLAN_MODE_RE, "")
    .replace(/\[Request interrupted by user(?: for tool use)?\]/g, "")
    .replace(/\[(?:SYSTEM NOTIFICATION|MESSAGE FROM NON-USER SOURCE) - NOT USER INPUT\]/g, "")
    .trim()
  return !rest || DSH_RUNTIME_SNAPSHOT_RE.test(rest)
}

function isToolResultMessage(message) {
  return Array.isArray(message?.content) && message.content.some((block) => block?.type === "tool_result")
}

// A user message with no tool result and something the user wrote or attached.
function isUserTask(message) {
  if (message?.role !== "user") return false
  if (typeof message.content === "string") return !isMetaOnlyUserText(message.content)
  if (!Array.isArray(message.content) || isToolResultMessage(message)) return false
  if (message.content.some((block) => block?.type === "image")) return true
  return message.content.some((block) => !isMetaOnlyUserText(blockText(block)))
}

// Index right after the last completed assistant reply (an assistant run with
// no tool_use), or 0 when the conversation is still in its first turn.
function lastCompletedTurnEnd(history) {
  for (let end = history.length; end > 0;) {
    if (history[end - 1].role !== "assistant") {
      end--
      continue
    }
    let start = end - 1
    while (start > 0 && history[start - 1].role === "assistant") start--
    const hasToolUse = history.slice(start, end).some((message) =>
      Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_use"))
    if (!hasToolUse) return end
    end = start
  }
  return 0
}

// Bounds of the non-assistant, non-tool_result run around `index` when at
// least one message in it is a user task; null when the run is meta-only.
function userTurnRun(history, index) {
  if (index < 0 || index >= history.length) return null
  let start = index
  while (start > 0 && history[start - 1].role !== "assistant" && !isToolResultMessage(history[start - 1])) start--
  let end = index + 1
  while (end < history.length && history[end].role !== "assistant" && !isToolResultMessage(history[end])) end++
  const all = []
  const tasks = []
  const rest = []
  for (let i = start; i < end; i++) {
    if (i === 0) continue
    all.push(i)
    if (isUserTask(history[i])) tasks.push(i)
    else rest.push(i)
  }
  const hasTask = tasks.length > 0 || (start === 0 && end > 0 && isUserTask(history[0]))
  return hasTask ? { all, tasks, rest } : null
}

// The user-turn run that opened the active tool loop, if any.
function loopOpeningRun(history, loopStart) {
  for (let i = loopStart; i < history.length; i++) {
    if (history[i].role === "assistant" || isToolResultMessage(history[i])) break
    if (isUserTask(history[i])) return userTurnRun(history, i)
  }
  return null
}

// The latest user-turn run at or after `loopStart`, never reaching back into
// an earlier completed turn.
function latestLoopTaskRun(history, loopStart) {
  for (let i = history.length - 1; i >= loopStart; i--) {
    if (isUserTask(history[i])) return userTurnRun(history, i)
  }
  return null
}

// Byte size of `indices` (sorted, unique) plus an omission note for each gap.
function keptSliceBytes(indices, totalLength, entries, noteBytes) {
  let bytes = 0
  let next = 0
  for (const i of indices) {
    if (i > next) bytes += noteBytes
    bytes += entries[i].bytes
    next = i + 1
  }
  if (next < totalLength) bytes += noteBytes
  return bytes
}

function clipHistoryEntryParts(parts, limit) {
  if (limit <= 0) return []
  const needNewline = parts.at(-1)?.type === "text" && parts.at(-1).text.endsWith("\n")
  const textLimit = needNewline ? Math.max(0, limit - 1) : limit
  const clipped = clipPartsToBytes(parts, textLimit)
  if (needNewline) {
    const last = clipped.at(-1)
    if (last?.type === "text" && !last.text.endsWith("\n")) last.text += "\n"
  }
  return promptTextBytes(clipped) <= limit ? clipped : clipPartsToBytes(clipped, limit)
}

function clipHistoryEntry(entry, limit) {
  const parts = clipHistoryEntryParts(entry.parts, limit)
  return { parts, bytes: promptTextBytes(parts) }
}

function fillHistoryTail(entries, floor, left, noteBytes) {
  const tail = []
  for (let i = entries.length - 1; i > floor; i--) {
    const cost = entries[i].bytes - (i === floor + 1 ? noteBytes : 0)
    if (cost > left) break
    left -= cost
    tail.unshift(i)
  }
  return { tail, left }
}

// `reserveBytes` is text the caller appends after </current_turn>.
function renderInitialPromptParts(body, callerWorkDir, reserveBytes = 0) {
  const { history, messages: current } = trailingMessages(body)
  const budget = Math.max(0, maxInitialPromptBytes() - reserveBytes)
  const head = []
  const system = systemText(body)
  if (system.trim()) appendPrompt(head, `<external_system_instructions>\n${outgoing(system)}\n</external_system_instructions>\n`)
  if (callerWorkDir) appendPrompt(head, `\n${workDirNote(callerWorkDir)}\n\n`)
  const currentParts = renderTurnMessagesParts(current)
  // A fresh conversation needs no wrapper; it would only add tokens.
  if (!head.length && !history.length) return clipPartsToBytes(currentParts, budget)
  const historyOpen = history.length ? "<conversation_history>\n" : ""
  const historyClose = history.length ? HISTORY_RECORD_NOTE + "</conversation_history>\n\n" : ""
  const turnOpen = "<current_turn>\n"
  const turnClose = "\n</current_turn>"
  const frame = utf8Bytes(historyOpen + historyClose + turnOpen + turnClose)
  // Mandatory segments first: instructions, the frame and the current turn.
  // An oversized current turn keeps its head and tail; instructions shrink
  // only when they alone would not leave the current turn any room.
  let headParts = head
  let turn = currentParts
  if (promptTextBytes(headParts) + frame + promptTextBytes(turn) > budget) {
    const forTurn = Math.max(0, budget - frame - promptTextBytes(headParts))
    turn = clipPartsToBytes(turn, Math.max(forTurn, Math.min(promptTextBytes(turn), Math.floor((budget - frame) / 2))))
    headParts = clipPartsToBytes(headParts, Math.max(0, budget - frame - promptTextBytes(turn)))
  }
  let room = budget - frame - promptTextBytes(headParts) - promptTextBytes(turn)
  const render = (message) => {
    const parts = renderHistoryEntry(message)
    return { parts, bytes: promptTextBytes(parts) }
  }
  const overRoom = (list) => list.reduce((sum, entry) => sum + entry.bytes, 0) > room
  // A replay that fits is sent whole; only one that does not has its big
  // blocks clipped first (#1055).
  let entries = history.map(render)
  if (overRoom(entries)) entries = history.map((message) => render(clipHistoryMessage(message)))
  let kept = entries
  let showOpeningDone = false
  if (overRoom(entries)) {
    const noteBytes = utf8Bytes(HISTORY_OMITTED_NOTE)
    const inToolLoop = current.some(isToolResultMessage)
    const loopStart = inToolLoop ? lastCompletedTurnEnd(history) : history.length
    const openingDoneBytes = utf8Bytes(HISTORY_OPENING_DONE_NOTE)
    let reservedOpeningDone = false
    if (room < noteBytes) {
      kept = []
    } else {
      if (inToolLoop && loopStart > 0 && room >= noteBytes + openingDoneBytes) {
        reservedOpeningDone = true
        room -= openingDoneBytes
      }
      // Keep the opening anchor message and the newest messages that still fit;
      // the early middle of the conversation gives way to omission notes.
      let keep = []
      if (entries.length && keptSliceBytes([0], entries.length, entries, noteBytes) <= room) {
        keep.push(0)
      }
      // Mid tool loop, the user's prompt run that started it says what the loop is
      // for (plus any later user steer run): keep it after the anchor, with a note
      // for each gap (#1053, #1055).
      if (inToolLoop) {
        const runs = [loopOpeningRun(history, loopStart), latestLoopTaskRun(history, loopStart)].filter(Boolean)
        const whole = [...new Set([...keep, ...runs.flatMap((run) => run.all)])].sort((a, b) => a - b)
        if (whole.length > keep.length && keptSliceBytes(whole, entries.length, entries, noteBytes) <= room) {
          keep = whole
        } else {
          const order = [...new Set([...runs.flatMap((run) => run.tasks), ...runs.flatMap((run) => run.rest)])]
          for (const idx of order) {
            if (keep.includes(idx)) continue
            const nextKeep = [...keep, idx].sort((a, b) => a - b)
            if (keptSliceBytes(nextKeep, entries.length, entries, noteBytes) <= room) keep = nextKeep
          }
        }
      }
      let left = room - keptSliceBytes(keep, entries.length, entries, noteBytes)
      const floor = keep.length ? keep.at(-1) : -1
      let { tail, left: remainingLeft } = fillHistoryTail(entries, floor, left, noteBytes)
      const lastIdx = entries.length - 1
      if (lastIdx >= 0 && tail.length === 0 && !keep.includes(lastIdx)) {
        // Never let an oversized history[0] squeeze out the newest turn before <current_turn>.
        if (keep.length === 1 && keep[0] === 0 && lastIdx > 0 && room >= 4096 + noteBytes &&
          entries[0].bytes > Math.floor((room - noteBytes) / 2) &&
          remainingLeft < Math.min(entries[lastIdx].bytes, Math.floor((room - noteBytes) / 2))) {
          const reservedLast = Math.min(entries[lastIdx].bytes, Math.floor((room - noteBytes) / 2))
          entries[0] = clipHistoryEntry(entries[0], Math.max(2048, room - noteBytes - reservedLast))
          left = room - keptSliceBytes(keep, entries.length, entries, noteBytes)
          ;({ tail, left: remainingLeft } = fillHistoryTail(entries, floor, left, noteBytes))
        }
        if (tail.length === 0 && !keep.includes(lastIdx)) {
          const gapSaved = keep.length === 0 ? 0 : (lastIdx === floor + 1 ? noteBytes : 0)
          const avail = remainingLeft + gapSaved
          if (avail >= 512) {
            entries[lastIdx] = clipHistoryEntry(entries[lastIdx], avail)
            tail.unshift(lastIdx)
          }
        }
      }
      const keptIndices = [...keep, ...tail]
      kept = []
      let next = 0
      for (const i of keptIndices) {
        if (i > next) kept.push(null)
        kept.push(entries[i])
        next = i + 1
      }
      if (next < entries.length) kept.push(null)
      showOpeningDone = reservedOpeningDone && keep.includes(0) && kept.includes(null) &&
        keptIndices.some((i) => i >= loopStart && isUserTask(history[i]))
    }
  }
  const out = []
  appendPrompt(out, headParts)
  if (history.length) {
    appendPrompt(out, historyOpen)
    for (const entry of kept) appendPrompt(out, entry ? entry.parts : HISTORY_OMITTED_NOTE)
    if (showOpeningDone) appendPrompt(out, HISTORY_OPENING_DONE_NOTE)
    appendPrompt(out, historyClose)
  }
  appendPrompt(out, turnOpen)
  appendPrompt(out, turn)
  appendPrompt(out, turnClose)
  return promptTextBytes(out) <= budget ? out : clipPartsToBytes(out, budget)
}

function validateBody(body) {
  if (!Array.isArray(body?.messages) || !body.messages.length) {
    throw new UnsupportedContent("a request without messages")
  }
  const trailing = trailingMessages(body)
  const lastRole = body.messages.at(-1)?.role
  // A text-only assistant tail is a client-side prefill (see prefillRun).
  const prefillTail = prefillTailEnabled() && lastRole === "assistant" && assistantTextOf(body.messages.at(-1)) !== null
  const validTailRole = lastRole === "user" || lastRole === "system" || lastRole === "developer" || prefillTail
  if (prefillTail && extractToolResults(body).length) {
    throw new UnsupportedContent("a request combining a live tool_result with an assistant prefill tail")
  }
  if (!validTailRole || (!extractToolResults(body).length &&
    !trailing.messages.some((message) => message.role === "user") && !trailing.history.length)) {
    throw new UnsupportedContent(prefillTail
      ? "a request whose only messages are assistant prefill turns (no user turn to continue from)"
      : "a request whose last message is not from the user or a tool-result notification")
  }
  if (body.system && typeof body.system !== "string") {
    if (!Array.isArray(body.system) || body.system.some((block) => block?.type !== "text")) {
      throw new UnsupportedContent("a non-text system prompt")
    }
  }
  for (const message of body.messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (ASSISTANT_ALLOWED_BLOCK_TYPES.has(block?.type)) continue
        throw new UnsupportedContent(`an assistant content block of type ${JSON.stringify(block?.type)}`)
      }
    } else if (message.role === "system" || message.role === "developer") {
      if (typeof message.content !== "string") {
        if (!Array.isArray(message.content)) throw new UnsupportedContent("a non-text system/developer message")
        for (const block of message.content) {
          if (block?.type === "text" && typeof block.text === "string") continue
          if (block?.type === "tool_addition" || block?.type === "tool_removal") continue
          if (block && typeof block.type === "string" && block.type !== "text") {
            throw new UnsupportedContent(`a non-text system/developer content block of type ${JSON.stringify(block.type)}`)
          }
          throw new UnsupportedContent("a non-text system/developer message")
        }
      }
    } else if (message.role === "user") {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === "tool_result") toolResult(block)
          else if (block?.type === "image") parseUserImage(block)
          else if (block?.type === "text" || typeof block === "string") continue
          else if (block?.type === "document") parseUserDocumentText(block)
          else if (block?.type === "search_result") parseSearchResultText(block)
          else blockText(block)
        }
      } else if (typeof message.content !== "string") {
        messageText(message)
      }
    }
  }
}

function toolResult(block) {
  if (!block || typeof block.tool_use_id !== "string" || !block.tool_use_id) {
    throw new UnsupportedContent("a tool_result without tool_use_id")
  }
  let content
  if (typeof block.content === "string") {
    content = [{ type: "text", text: block.content }]
  } else if (Array.isArray(block.content)) {
    content = block.content.map((part) => {
      if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text }
      if (part?.type === "tool_reference" && typeof part.tool_name === "string") {
        return { type: "text", text: `Loaded tool: ${part.tool_name}` }
      }
      if (part?.type === "document") return { type: "text", text: parseUserDocumentText(part, true) }
      if (part?.type === "search_result") return { type: "text", text: parseSearchResultText(part) }
      if (part?.type === "image" && part.source?.type === "base64" && part.source.data) {
        return {
          type: "image",
          data: part.source.data,
          mimeType: part.source.media_type || "application/octet-stream",
        }
      }
      throw new UnsupportedContent("this tool_result content")
    })
  } else if (block.content == null) {
    content = [{ type: "text", text: "" }]
  } else {
    throw new UnsupportedContent("non-text tool_result content")
  }
  return { content, isError: block.is_error === true }
}

function extractToolResults(body) {
  return trailingMessages(body).messages.flatMap(message => message.role === "user" && Array.isArray(message.content)
    ? message.content.filter(block => block?.type === "tool_result") : [])
}

function isSkillResult(item) {
  if (item.call?.name === "Skill") return true
  const first = item.result?.content?.[0]
  return first?.type === "text" &&
    /^(?:Launching skill|Loaded skill instructions \(read-only\)): /.test(first.text || "")
}

function appendResultPart(results, index, part) {
  if (index < 0 || index >= results.length) {
    throw new UnsupportedContent("text beside a live tool_result; no matching tool companion")
  }
  const target = index
  const targetCall = results[target]?.call
  return results.map((item, i) => (targetCall ? item.call !== targetCall : i !== target) ? item : {
    ...item,
    result: {
      ...item.result,
      content: [...item.result.content, part],
    },
  })
}

function appendResultText(results, index, text) {
  return appendResultPart(results, index, { type: "text", text })
}

const NOTICE_TAG_NAMES = "system-update|teammate-message|agent-message|cross-session-message|coordinator-relay|channel|ide_opened_file|ide_selection|mcp-resource|mcp-resource-update|mcp-polling-update|post-tool-use-hook|user-prompt-submit-hook"
const CONTEXT_NOTICE_RE = new RegExp(
  `<(${NOTICE_TAG_NAMES})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>|(?:\\[(?:SYSTEM NOTIFICATION|MESSAGE FROM NON-USER SOURCE) - NOT USER INPUT\\][^<]*)?<task-notification>[\\s\\S]*?<\\/task-notification>`,
  "g",
)
const SYSTEM_REMINDER_RE = /<system-reminder(?:\s[^>]*)?>([\s\S]*?)<\/system-reminder(?:\s[^>]*)?>/g
const PROTOCOL_NOTICE_START_RE = new RegExp(
  `^(?:<(?:${NOTICE_TAG_NAMES}|task-notification|system-reminder)\\b|\\[(?:SYSTEM NOTIFICATION|MESSAGE FROM NON-USER SOURCE) - NOT USER INPUT\\])`,
)
const UNCLOSED_NOTICE_RE = new RegExp(
  `<\\/?(?:${NOTICE_TAG_NAMES}|task-notification|system-reminder)\\b`,
)

// Forward complete protocol-generated context notices, Claude Code hook outputs,
// and tool-companion blocks without turning arbitrary inline user instructions
// into MCP function_response text. Mid-turn queued_command prompts and follow-up
// user instructions after a rejected/stopped tool call set userSteered so the
// bridge replays them as a new native turn.
function inspectToolTurn(results, body) {
  let out = results
  let userSteered = false
  const notices = []
  let seenResult = false
  let resultIndex = -1
  const stoppedByHookOrUser = out.some((item) => item.result?.isError &&
    /^(?:The user doesn't want to proceed with this tool use\.|User rejected tool use\b|Operation stopped by hook\b|Execution stopped by hook\b|Blocked by PreToolUse hook\b|Hook PreToolUse:\S+ denied\b|API Error: Request was aborted\.|\[Request interrupted by user\b)/.test(resultText(item.result).trim()))
  const userInterruption = /(?:The user sent (?:a new message while you were working|the following message)|The [^\r\n]+ plugin sent a message while you were working):/
  const nonUserSourceNotice = /^\[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT\]\s*\n/
  const skillCompanion = /^\s*(?:Base directory for this skill:|ARGUMENTS:|Skill arguments:) /
  const imageCompanion = /^\[Image(?: source)?: [^\r\n]+\]$/
  const toolLoadedCompanion = /^Tools? loaded\.(?:\n\[id:[^\]\n]+\])*$/
  const loopNotice = /^\[\d+ prior \/loop wakeups? found nothing actionable; loop is healthy\.\]$/
  const tokenNoise = /^(?:<total_tokens>[^<]*<\/total_tokens>|Token usage: \S+; \S+ remaining|USD budget: \$\S+; \$\S+ remaining|Output tokens \u2014 turn: [^\r\n]+)$/
  const hookBoilerplateNoise = /^[A-Za-z][A-Za-z0-9_.-]*(?::\S+)? hook success:\s*(?:Success)?\s*$/
  const hookOutput = /^[A-Za-z][A-Za-z0-9_.-]*(?::\S+)? hook (?:additional context|success|blocking error(?: from command)?|stopped continuation|feedback):/
  const hookStoppedContinuation = /^[A-Za-z][A-Za-z0-9_.-]*(?::\S+)? hook stopped continuation:/
  const claudeMetaFeedback = /^(?:(?:Stop|SubagentStop|TeammateIdle|TaskCreated|TaskCompleted|PermissionRequest|PermissionDenied|PreCompact|PostCompact|Elicitation|ElicitationResult|ConfigChange|CwdChanged|FileChanged|WorktreeCreate|WorktreeRemove|InstructionsLoaded) hook feedback:\n[\s\S]+|UserPromptSubmit operation blocked by hook:\n[\s\S]+|The PermissionDenied hook indicated you may retry this tool call\.|The turn did not end: a tool call in your last message asked to end it, but another call in that message failed\.[\s\S]*|Your response above was stopped by a safety classifier \u2014 this is not a tool or API error\.[\s\S]*|The previous response failed to produce a valid tool call\. Please retry the tool call now\.|Your tool call was malformed and could not be parsed\. Please retry\.|Output token limit hit[\s\S]*|Your response (?:was cut off|above was cut off)[\s\S]*|\[Your previous response (?:had no visible output|reached the output limit)[\s\S]*\]|\[structured-output-enforce\][\s\S]*|\[projects-reply-gate\][\s\S]*|Linked in your reply but not sent:[\s\S]*|Goal check-in: \u00ab[\s\S]*)$/
  const isNoise = (value) => !value || tokenNoise.test(value) || hookBoilerplateNoise.test(value)
  for (const message of trailingMessages(body).messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content]
    for (const block of blocks) {
      if (block?.type === "tool_result") {
        seenResult = true
        resultIndex = out.findIndex(item => item.block?.tool_use_id === block.tool_use_id)
        continue
      }
      if (block?.type === "image") {
        if (!seenResult) {
          // Same replay path as ordinary text before a live tool_result.
          // Keep the image on the request body so the new prompt can carry it;
          // never splice it into an MCP function response that has no result yet.
          userSteered = true
          continue
        }
        out = appendResultPart(out, resultIndex, parseUserImage(block))
        continue
      }
      const rawText = blockText(block)
      if (!seenResult && message.role === "user" && rawText.trim()) {
        // A user can steer a pending tool turn from either side of a tool_result.
        // Replay the instruction as a user prompt, never as an MCP tool response.
        userSteered = true
      }
      const text = stripMagpiePlaceholderNotice(rawText)
      if (text !== rawText && !notices.includes(MAGPIE_PLACEHOLDER_NOTICE)) {
        notices.push(MAGPIE_PLACEHOLDER_NOTICE)
      }
      const trimmed = text.trim()
      if (!trimmed) continue
      const preceding = out[resultIndex]
      const skillIndex = preceding && isSkillResult(preceding) ? resultIndex : -1
      const imageIndex = preceding?.result?.content?.some(part => part?.type === "image") ? resultIndex : -1
      const toolSearchIndex = preceding?.call?.name === "ToolSearch" ? resultIndex : -1
      if (message.role === "user" && skillCompanion.test(text)) {
        out = appendResultText(out, skillIndex, text)
        continue
      }
      if (message.role === "user") {
        if (extractQueuedPrompt(trimmed) !== null) {
          userSteered = true
          continue
        }
        if (nonUserSourceNotice.test(trimmed) && !/<task-notification\b/.test(trimmed)) {
          const check = trimmed.replace(CONTEXT_NOTICE_RE, "").replace(SYSTEM_REMINDER_RE, "")
          if (UNCLOSED_NOTICE_RE.test(check)) {
            throw new UnsupportedContent("text beside a live tool_result; send it after the tool response completes")
          }
          notices.push(trimmed)
          continue
        }
        if (imageCompanion.test(trimmed)) {
          out = appendResultText(out, imageIndex, trimmed)
          continue
        }
        if (toolLoadedCompanion.test(trimmed)) {
          out = appendResultText(out, toolSearchIndex, trimmed)
          continue
        }
        if (loopNotice.test(trimmed)) {
          notices.push(trimmed)
          continue
        }
        if (skillIndex >= 0 && /^#{1,6}\s+[^\r\n]*\b(?:skill|instructions)\b/i.test(trimmed) &&
          !isNoise(trimmed) && !PROTOCOL_NOTICE_START_RE.test(trimmed) &&
          !userInterruption.test(trimmed) && !hookOutput.test(trimmed) && !claudeMetaFeedback.test(trimmed)) {
          out = appendResultText(out, skillIndex, text)
          continue
        }
      }
      notices.push(...Array.from(text.matchAll(CONTEXT_NOTICE_RE), (match) => match[0]))
      const withoutNotices = text.replace(CONTEXT_NOTICE_RE, "")
      for (const match of withoutNotices.matchAll(SYSTEM_REMINDER_RE)) {
        const inner = match[1].trim()
        if (extractQueuedPrompt(inner) !== null || userInterruption.test(inner)) {
          userSteered = true
          continue
        }
        if (!isNoise(inner)) notices.push(inner)
      }
      const rest = withoutNotices.replace(SYSTEM_REMINDER_RE, "").trim()
      if (UNCLOSED_NOTICE_RE.test(rest)) {
        // Text that merely names a notice tag it does not close (a developer
        // message that quotes <system-reminder>, a user typing one, a hook's
        // context) is routed by who wrote it, never refused and never dropped.
        // A notice that opens and is cut short is still turned away.
        const wrapped = /^<system-reminder(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/system-reminder>$/.exec(trimmed)
        if (!wrapped && PROTOCOL_NOTICE_START_RE.test(rest)) {
          // a protocol notice that starts and is cut short: not a mention
          throw new UnsupportedContent("text beside a live tool_result; send it after the tool response completes")
        }
        if (wrapped || message.role === "system" || message.role === "developer") {
          // the gateway's wrapper for a developer message, or a system one
          const inner = wrapped ? wrapped[1] : rest
          if (extractQueuedPrompt(inner) !== null || userInterruption.test(inner)) userSteered = true
          else if (!isNoise(inner)) notices.push(outgoing(inner))
        } else if (message.role === "user") {
          userSteered = true
        } else if (!isNoise(rest)) {
          notices.push(outgoing(rest))
        }
        continue
      }
      if (message.role === "system" || message.role === "developer") {
        if (extractQueuedPrompt(rest) !== null || userInterruption.test(rest)) {
          userSteered = true
        } else if (!isNoise(rest)) {
          notices.push(outgoing(rest))
        }
      } else if (!isNoise(rest)) {
        if ((hookOutput.test(rest) || claudeMetaFeedback.test(rest)) && !userInterruption.test(rest)) {
          notices.push(rest)
        } else if (message.role === "user" || userSteered || stoppedByHookOrUser ||
          notices.some((item) => hookStoppedContinuation.test(item))) {
          userSteered = true
        } else {
          // text from neither the user nor the system (an assistant message
          // that landed after the result): the model is told it, as a notice
          notices.push(outgoing(rest))
        }
      }
    }
  }
  const finalResults = notices.length
    ? appendResultText(out, out.length - 1, `<system-reminder>\n${notices.join("\n\n")}\n</system-reminder>`)
    : out
  return { results: finalResults, userSteered }
}

function namedWorkDirectory(body, init) {
  const raw = new Headers(init.headers || {}).get("x-magpie-work-dir")
  if (raw) {
    try { return decodeURIComponent(raw) } catch { return raw }
  }
  const firstAssistant = body.messages.findIndex((message) => message.role === "assistant")
  const opening = firstAssistant < 0 ? body.messages : body.messages.slice(0, firstAssistant)
  const texts = []
  for (const message of [{ role: "system", content: body.system }, ...opening]) {
    if (typeof message.content === "string") texts.push(message.content)
    else if (Array.isArray(message.content)) {
      for (const block of message.content) if (block?.type === "text") texts.push(block.text || "")
    }
  }
  let directory = null
  const pattern = /(?:Primary working directory|^\s*(?:-\s*)?Working directory|Current working directory): *([^\r\n]+)$|<cwd>([^<\r\n]+)<\/cwd>/gm
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] || match[2]).trim().replace(/^[`'"]+|[`'"]+$/g, "")
      if (value) directory = value
    }
  }
  return directory
}

function ensureControlServer() {
  if (controlServerPromise) return controlServerPromise
  controlServerPromise = new Promise((resolve, reject) => {
    const server = net.createServer((socket) => handleControlConnection(socket))
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      controlServer = server
      server.unref()
      resolve(server.address().port)
    })
  })
  return controlServerPromise
}

function tokenMatches(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false
  const a = createHash("sha256").update(left).digest()
  const b = createHash("sha256").update(right).digest()
  return timingSafeEqual(a, b)
}

function handleControlConnection(socket) {
  socket.setEncoding("utf8")
  let buffer = ""
  let handled = false
  socket.on("data", (data) => {
    if (handled) return
    buffer += data
    if (buffer.length > CONTROL_LINE_LIMIT) {
      socket.destroy()
      return
    }
    const newline = buffer.indexOf("\n")
    if (newline < 0) return
    handled = true
    let message
    try { message = JSON.parse(buffer.slice(0, newline)) } catch {
      socket.end(JSON.stringify({ error: { code: -32700, message: "invalid control JSON" } }) + "\n")
      return
    }
    const proc = sessions.get(message?.token)
    if (!proc || !tokenMatches(message.token, proc.token)) {
      socket.end(JSON.stringify({ error: { code: -32603, message: "invalid or expired bridge session" } }) + "\n")
      return
    }
    try {
      if (message.kind === "list") {
        socket.end(JSON.stringify({ result: { tools: proc.listTools() } }) + "\n")
        return
      }
      if (message.kind === "call") {
        proc.acceptMcpCall(message, socket)
        return
      }
      socket.end(JSON.stringify({ error: { code: -32601, message: "unknown control request" } }) + "\n")
    } catch (error) {
      socket.end(JSON.stringify({ error: { code: -32603, message: String(error?.message ?? error) } }) + "\n")
    }
  })
  socket.on("error", () => {})
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// Bounded, content-free stderr rows: never prompts, arguments, results or tool IDs.
const EVENT_WINDOW_MS = 60_000
const EVENT_MAX_PER_WINDOW = 30
const events = { windowStart: 0, count: 0, suppressed: 0 }

function logBridgeEvent(action, fields) {
  if (process.env.AGY_BRIDGE_EVENTS === "0") return
  const now = Date.now()
  if (now - events.windowStart >= EVENT_WINDOW_MS) {
    events.windowStart = now
    events.count = 0
  }
  if (events.count >= EVENT_MAX_PER_WINDOW) {
    events.suppressed++
    return
  }
  events.count++
  const row = { event: "agy_bridge_tui", ts: now, action, ...fields }
  if (events.suppressed) {
    row.suppressed = events.suppressed
    events.suppressed = 0
  }
  try { process.stderr.write("[agy-bridge] " + JSON.stringify(row) + "\n") } catch {}
}

// Exposed calls of turns that ended before the client returned their result,
// so the replay that serves the result can say why. Bounded; entries are read once.
const endedCalls = new Map()
const ENDED_CALLS_MAX = 64

function zeroUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, steps: 0, toolCalls: 0 }
}

// One native turn can outlive several HTTP responses. Its MCP callback blocks
// until the client next attaches and returns the corresponding result.
class TuiTurn {
  constructor(tools, body, identity, workDir, selection) {
    this.tools = tools
    this.workDir = workDir
    this.token = randomBytes(24).toString("hex")
    this.id = randomBytes(4).toString("hex")
    this.identity = identity
    this.instructions = systemText(body)
    this.selection = selection
    this.abort = new AbortController()
    this.events = []
    this.waiter = null
    this.reading = false
    this.sockets = new Set()
    this.pending = null
    this.callIds = new Set()
    this.calls = 0
    this.startedAt = Date.now()
    this.phases = {}
    this.usage = zeroUsage()
    this.reported = zeroUsage()
    this.usageWaiters = new Set()
    this.toolThinking = []
  }

  // Ends the native turn once; the first reason is the one reported.
  end(reason) {
    if (this.abort.signal.aborted) return
    this.reason = reason
    this.abort.abort()
  }

  listTools() {
    return fitTools(this.tools.map(tool => ({ ...tool, _meta: { "antigravity/alwaysLoad": true } })))
  }

  acceptMcpCall({ name, arguments: input }, socket) {
    const tool = this.tools.find(tool => tool.name === name)
    if (this.abort.signal.aborted || !tool) throw new Error("agy bridge: no such client tool in this native turn")
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("agy bridge: invalid tool arguments")
    // AGY consumes its internal toolSummary instead of forwarding it to MCP.
    if (name === "run_command" && tool.inputSchema?.properties?.toolSummary && !Object.hasOwn(input, "toolSummary")) {
      input = { ...input, toolSummary: "Run command" }
    }
    const block = { type: "tool_use", id: `toolu_${randomBytes(12).toString("hex")}`, name, input }
    this.sockets.add(socket)
    socket.once("close", () => {
      if (this.sockets.delete(socket)) this.end("mcp_closed")
    })
    this.calls++
    clearTimeout(this.toolTimer)
    this.toolTimer = setTimeout(() => this.end("tool_timeout"),
      configuredTimeout("AGY_BRIDGE_TOOL_TIMEOUT_MS", TOOL_TIMEOUT_MS))
    this.toolTimer.unref?.()
    this.push({ call: { name, block, socket, ordinal: this.calls } })
  }

  // AGY is blocked on a client tool call while the bridge holds its MCP request.
  waiting() {
    return this.sockets.size > 0
  }

  // How long the client has held the pending call with no request reading
  // this turn, or -1.
  detachedFor(now) {
    return this.pending && !this.busy() ? now - this.exposedAt : -1
  }

  progress(usage) {
    this.usage = usage
    for (const waiter of this.usageWaiters) waiter()
  }

  // AGY writes a planner row before it sends that row's calls to MCP, but the
  // transcript is polled. Wait briefly so a tool_use response carries its step.
  async usageThrough(ordinal) {
    // Rows are followed only once the transcript shows the submitted turn.
    if (this.usage.toolCalls >= ordinal || this.phases.submitted_ms === undefined) return
    let done
    const reached = new Promise(resolve => { done = resolve })
    const waiter = () => { if (this.usage.toolCalls >= ordinal) done() }
    const timer = setTimeout(done, USAGE_SYNC_MS)
    this.usageWaiters.add(waiter)
    this.abort.signal.addEventListener("abort", done, { once: true })
    try { await reached } finally {
      clearTimeout(timer)
      this.usageWaiters.delete(waiter)
      this.abort.signal.removeEventListener("abort", done)
    }
  }

  // decision: report the tokens of the native steps since the previous
  // response; not the last step's tokens because a response can follow several
  // steps and every step is billed. A response with no new step reports zero.
  takeUsage(totals = this.usage) {
    const delta = {}
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens"]) {
      delta[key] = Math.max(0, tokenCount(totals[key]) - this.reported[key])
      this.reported[key] += delta[key]
    }
    return delta
  }

  push(event) {
    if (this.waiter) {
      const resolve = this.waiter
      this.waiter = null
      resolve(event)
    } else {
      this.events.push(event)
    }
  }

  start(agy, options, cause) {
    tuiTurns.add(this)
    logBridgeEvent("turn_start", { turn: this.id, model: options.model.slice(0, 128), ...(options.effort ? { effort: options.effort } : {}),
      tools: this.tools.length, images: options.parts ? options.parts.length - 1 : 0, ...(cause ? { replay: cause } : {}) })
    this.closed = (async () => {
      let event
      try {
        const mcp = this.tools.length ? { tools: this.tools, port: await ensureControlServer(), token: this.token } : undefined
        if (mcp) sessions.set(this.token, this)
        event = { result: await runTui(agy, { ...options, signal: this.abort.signal, mcp, observer: {
          waiting: () => this.waiting(),
          progress: usage => this.progress(usage),
          toolThinking: FORWARD_THINKING ? text => this.toolThinking.push(text) : undefined,
          phase: name => { this.phases[`${name}_ms`] = Date.now() - this.startedAt },
        } }) }
      } catch (error) {
        event = { error: this.endError(error) }
      } finally {
        sessions.delete(this.token)
        clearTimeout(this.toolTimer)
        for (const socket of this.sockets) socket.destroy()
        this.sockets.clear()
        tuiTurns.delete(this)
        this.finish(event)
      }
    })()
  }

  // A turn the bridge ended reports why, not the cancellation it caused.
  endError(error) {
    if (error?.statusCode !== 499) return error
    const ended = {
      tool_timeout: ["the client did not return the tool result in time", 504],
      mcp_closed: ["the native TUI closed its tool call", 502],
      evicted: ["the native TUI turn gave up its slot while waiting for a tool result", 503],
    }[this.reason]
    return ended ? Object.assign(new Error(`agy bridge: ${ended[0]}`), { statusCode: ended[1], phase: error.phase }) : error
  }

  // decision: give the end of a turn to the request still reading it; not
  // queue it for a request that may never come because a client holding a
  // tool call returns the result later, which then replays the history.
  finish(event) {
    const { error } = event
    const status = error ? error.statusCode ?? 502 : 200
    const pending = this.pending
    this.ended = event
    for (const id of this.callIds) tuiCalls.delete(id)
    this.pending = null
    this.unwatchSignal?.()
    const reason = this.reason ?? (error ? "failed" : "completed")
    logBridgeEvent("turn_end", { turn: this.id, reason, status, ...(error?.phase ? { phase: error.phase } : {}),
      ms: Date.now() - this.startedAt, calls: this.calls, steps: this.usage.steps, ...this.phases,
      ...(error?.detail ? { pty: error.detail } : {}), ...(this.reading ? {} : { unread: true }) })
    // An exposed call's result still comes back later, whether or not its response is still being built.
    if (pending) rememberEndedCall(pending.block.id, `${reason}:${status}`)
    if (!this.waiter) return
    this.events.length = 0
    this.push(event)
  }

  next(signal) {
    this.reading = true
    this.unwatchSignal?.()
    const cancel = () => this.end("client_cancelled")
    if (signal?.aborted) cancel()
    else if (signal) {
      signal.addEventListener("abort", cancel, { once: true })
      this.unwatchSignal = () => signal.removeEventListener("abort", cancel)
    }
    return this.events.length ? Promise.resolve(this.events.shift()) : new Promise(resolve => { this.waiter = resolve })
  }

  // A request is reading this turn, from next() until its response is built.
  busy() {
    return this.reading === true
  }

  sameIdentity(identity) {
    return this.identity.home === identity.home && this.identity.scope === identity.scope
  }

  expose(call, body, content) {
    const history = trailingMessages(body).history
    const tail = body.messages.slice(history.length)
    call.history = historyKey([...history, ...tail])
    call.assistant = historyKey(stripToolUseInputs([{ role: "assistant", content }]))
    this.pending = call
    this.exposedAt = Date.now()
    // Every call stays mapped to its turn until the turn ends, so a repeated
    // result is recognized as this turn's rather than as a lost one.
    this.callIds.add(call.block.id)
    tuiCalls.set(call.block.id, this)
  }

  matchesPending(history, identity) {
    const call = this.pending
    const shown = lastAssistantCalls(history)
    if (this.abort.signal.aborted || !call || shown.length !== 1 || shown[0].id !== call.block.id ||
      shown[0].name !== call.name || !this.sameIdentity(identity)) return false
    let split = history.length
    while (split > 0 && history[split - 1].role === "assistant") split--
    // Claude Code can normalize the input of the matched client tool, such as Edit.replace_all.
    return call.history === historyKey(history.slice(0, split)) &&
      call.assistant === historyKey(stripToolUseInputs(history.slice(split)))
  }

  // Returns true once the result reaches the waiting MCP call. False means the
  // request no longer continues this turn as shown and needs a new native turn.
  acceptResult(body, blocks, identity, tools, workDir, selection) {
    const call = this.pending
    if (!call || blocks.length !== 1 || call.block.id !== blocks[0].tool_use_id ||
      !this.matchesPending(trailingMessages(body).history, identity)) return false
    const { results, userSteered } = inspectToolTurn([{ block: blocks[0], call, result: toolResult(blocks[0]) }], body)
    // A changed catalog or a new instruction needs a new native turn, not an edit to an MCP result.
    if (userSteered || this.workDir !== workDir || this.selection.model !== selection.model ||
      this.selection.effort !== selection.effort || !sameInstructions(this.instructions, systemText(body)) ||
      stableJSON(this.tools) !== stableJSON(tools) || results.some(({ result }) => resultHasImage(result))) return false
    this.pending = null
    clearTimeout(this.toolTimer)
    this.sockets.delete(call.socket)
    call.socket.end(JSON.stringify({ result: results[0].result }) + "\n")
    return true
  }
}

function rememberEndedCall(id, why) {
  endedCalls.delete(id)
  endedCalls.set(id, why)
  while (endedCalls.size > ENDED_CALLS_MAX) endedCalls.delete(endedCalls.keys().next().value)
}

function takeEndedCall(id) {
  const why = endedCalls.get(id)
  endedCalls.delete(id)
  return why
}

// Under slot pressure, end the turn whose client has held its tool call the
// longest once that exceeds EVICT_WAIT_MS. That client's result then replays.
// Returns whether a turn gave up its slot.
async function evictDetached() {
  const now = Date.now()
  let oldest
  let longest = EVICT_WAIT_MS
  for (const turn of tuiTurns) {
    const detached = turn.detachedFor(now)
    if (detached >= longest) {
      oldest = turn
      longest = detached
    }
  }
  if (!oldest) return false
  logBridgeEvent("evict", { turn: oldest.id, detached_ms: longest })
  oldest.end("evicted")
  await oldest.closed
  return true
}

// decision: show client control characters as Unicode control pictures; not
// reject the request because a history that carries terminal output would then
// fail on every retry. Only literal text may enter the native editor.
function literalText(text) {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, char => {
    const code = char.charCodeAt(0)
    return code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? "\u2421" : "\ufffd"
  })
}

async function tuiResponse(agy, body, selection, init, identity) {
  if (process.platform !== "linux") return jsonError(503, "agy bridge: the native terminal requires Linux and util-linux script")
  try {
    const { signal } = init
    if (signal?.aborted) return jsonError(499, "agy bridge: the TUI turn was cancelled")
    const blocks = extractToolResults(body)
    const tools = normalizeTools(body)
    const workDir = namedWorkDirectory(body, init)
    const trailing = trailingMessages(body)
    let held, cause
    if (blocks.length) {
      if (replayHistoryProblem(body, blocks)) throw new UnsupportedContent("unmatched or incomplete tool results")
      held = blocks.map(block => tuiCalls.get(block.tool_use_id)).find(Boolean)
      if (held && !held.sameIdentity(identity)) {
        // Another session or account carries this history: serve it in its own
        // turn and leave the owner's turn waiting for the owner's result.
        held = undefined
        cause = "foreign_identity"
      } else if (held?.busy()) {
        logBridgeEvent("reject", { turn: held.id, reason: "busy" })
        return jsonError(409, "agy bridge: the native TUI turn is already answering another request")
      } else if (held?.acceptResult(body, blocks, identity, tools, workDir, selection)) {
        return await tuiReply(held, body, signal)
      }
      // decision: replay the client's history in a new native turn when no
      // live turn takes these results; not 409 because the client cannot make
      // a lost turn come back, so a refusal only repeats until it gives up.
      cause ??= held ? "superseded" : blocks.map(block => takeEndedCall(block.tool_use_id)).find(Boolean) ?? "unknown_call"
    } else if (identity.scope && isUserTask(trailing.messages.at(-1))) {
      // A standalone user message may abandon the pending call. Only reclaim
      // it if this request names the same scoped turn and matches its history.
      held = tuiCalls.get(lastAssistantCalls(trailing.history)[0]?.id)
      if (!held?.matchesPending(trailing.history, identity)) held = undefined
    }
    const reminder = outputFormatReminder(body)
    const parts = mergePromptParts(renderInitialPromptParts(body, workDir,
      reminder.length ? promptTextBytes(reminder) + 2 : 0), reminder)
    const images = []
    // decision: mark each image's original position; not interleave pastes
    // because AGY sends all clipboard attachments after its text. Revisit when
    // AGY can preserve mixed part order through the interactive editor.
    const prompt = parts.map(part => {
      if (part.type !== "image") return literalText(part.text)
      images.push(part)
      return `[Image ${images.length} is attached]`
    }).join("")
    const inputParts = images.length ? [{ type: "text", text: prompt }, ...images] : undefined
    parseTuiInput(prompt, inputParts)
    if (held) {
      held.end(blocks.length ? "superseded" : "abandoned")
      await held.closed
    }
    // Checked again after each eviction, since a concurrent request can take the freed slot.
    while (tuiTurns.size >= maxProcs()) {
      if (await evictDetached()) continue
      logBridgeEvent("reject", { reason: "slots", turns: tuiTurns.size })
      return jsonError(503, "agy bridge: all agy process slots are busy")
    }
    if (signal?.aborted) return jsonError(499, "agy bridge: the TUI turn was cancelled")
    const turn = new TuiTurn(tools, body, identity, workDir, selection)
    turn.start(agy, {
      prompt, parts: inputParts, ...selection,
      timeoutMs: configuredTimeout("AGY_BRIDGE_TURN_TIMEOUT_MS", TURN_TIMEOUT_MS), env: childEnv(),
    }, cause)
    return await tuiReply(turn, body, signal)
  } catch (error) {
    return jsonError(error.statusCode ?? 502, error.message, error.code,
      { noRetry: error.statusCode === 400 || error.noRetry })
  }
}

async function tuiReply(turn, body, signal) {
  try { return await tuiMessage(turn, body, signal) } finally { turn.reading = false }
}

async function tuiMessage(turn, body, signal) {
  const { call, result = {}, error } = await turn.next(signal)
  if (error) throw error
  if (call) await turn.usageThrough(call.ordinal)
  if (signal?.aborted) {
    turn.end("client_cancelled")
    throw Object.assign(new Error("agy bridge: the TUI turn was cancelled"), { statusCode: 499 })
  }
  // The turn ended while this call waited for its usage row; its MCP request is gone.
  if (call && turn.ended) throw turn.ended.error ?? Object.assign(new Error("agy bridge: the native TUI turn ended"), { statusCode: 502 })
  const id = `msg_agy_${randomBytes(12).toString("hex")}`
  const thoughts = turn.toolThinking.splice(0)
  if (result.thinking) thoughts.push(result.thinking)
  const thinking = FORWARD_THINKING && body.thinking?.type !== "disabled" ? thoughts.join("\n\n") : ""
  const content = [
    ...(thinking ? [{ type: "thinking", thinking, signature: thinkingSignature(id, thinking) }] : []),
    ...(result.text ? [{ type: "text", text: result.text }] : []),
    ...(call ? [call.block] : []),
  ]
  if (call) turn.expose(call, body, content)
  const steps = turn.takeUsage(call ? turn.usage : result)
  // AGY 1.5.18 records no cache-write count for a step, so none is reported.
  const usage = { input_tokens: steps.inputTokens, output_tokens: steps.outputTokens,
    cache_read_input_tokens: steps.cacheReadTokens, cache_creation_input_tokens: 0 }
  const message = { id, type: "message", role: "assistant", model: body.model, content,
    stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null, usage }
  const headers = { "X-Magpie-Agy-Mode": "tui" }
  if (body.stream === false) return Response.json(message, { headers })

  const events = [sseEvent("message_start", { type: "message_start", message: {
    ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 },
  } })]
  for (const [index, block] of content.entries()) {
    let start, deltas
    if (block.type === "tool_use") {
      start = { ...block, input: {} }
      deltas = [{ type: "input_json_delta", partial_json: JSON.stringify(block.input) }]
    } else if (block.type === "thinking") {
      start = { type: "thinking", thinking: "", signature: "" }
      deltas = [{ type: "thinking_delta", thinking: block.thinking }, { type: "signature_delta", signature: block.signature }]
    } else {
      start = { type: "text", text: "" }
      deltas = [{ type: "text_delta", text: block.text }]
    }
    events.push(sseEvent("content_block_start", { type: "content_block_start", index, content_block: start }))
    for (const delta of deltas) events.push(sseEvent("content_block_delta", { type: "content_block_delta", index, delta }))
    events.push(sseEvent("content_block_stop", { type: "content_block_stop", index }))
  }
  events.push(sseEvent("message_delta", { type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage }))
  events.push(sseEvent("message_stop", { type: "message_stop" }))
  return new Response(events.join(""), { headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}

function tokenCount(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(number))) : 0
}

// The transcript has no upstream thinking signature.
const THINKING_KEY = randomBytes(32)
const THINKING_SIGNATURE_PREFIX = "agyb1."

function thinkingSignature(sessionId, thinking) {
  return THINKING_SIGNATURE_PREFIX +
    createHmac("sha256", THINKING_KEY).update(String(sessionId) + "\n" + thinking).digest("base64url")
}

function estimateTextTokens(text) {
  if (!text) return 0
  let ascii = 0
  let nonAsciiBytes = 0
  const buf = Buffer.from(String(text), "utf8")
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] < 0x80) ascii++
    else nonAsciiBytes++
  }
  return Math.ceil(ascii / 4 + nonAsciiBytes / 3)
}

function estimateInputTokens(body) {
  let total = 0
  let images = 0
  const walk = (value) => {
    if (value == null) return
    if (typeof value === "string") {
      total += estimateTextTokens(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value === "object") {
      if (value.type === "image" && value.source?.type === "base64") {
        images++
        return
      }
      for (const [key, item] of Object.entries(value)) {
        if (key === "cache_control" || key === "signature") continue
        walk(item)
      }
    }
  }
  walk(body.system)
  walk(body.messages)
  if (Array.isArray(body.tools) && body.tools.length) {
    total += estimateTextTokens(JSON.stringify(body.tools))
  }
  return Math.max(1, total + images * 1600)
}

// A magpie that installs a plugin's CLI (auth.cli) installs agy before it
// gets here; an older one, or OpenCode, doesn't.
function noAgy() {
  return { type: "failed", error: `agy CLI not found. Update magpie and sign in again to have it installed, or install Antigravity CLI yourself: ${AGY_MANUAL}` }
}

// signedInAs is the sign-in's result, named by the Google account agy is
// signed in to when its keyring (or token file) says (magpie shows the
// account by it, not as "API key"). An account with a home of its own
// (account.mjs) keeps the home's name with it, and a key of its own, so
// two accounts whose email can't be read aren't taken for one.
async function signedInAs(homeId = "", key = homeId ? `agy:${homeId}` : "agy", { home } = {}) {
  const email = await storedEmail({ home })
  const metadata = { ...(email ? { email } : {}), ...(homeId ? { agyHome: homeId } : {}) }
  return { type: "success", key, ...(Object.keys(metadata).length ? { metadata } : {}) }
}

async function completeSignIn(agy, account, { signal, key } = {}) {
  signal?.throwIfAborted()
  forgetStoredSignIn({ dead: true })
  const probe = await probeSignedIn(agy, { signal })
  if (!probe.ok) throw new Error(`agy couldn't sign in: ${probe.why}`)
  signal?.throwIfAborted()
  return signedInAs(account.id, key)
}

// All login methods publish through the same account callback. A replay never
// removes a successful home, and a failed/cancelled verification removes only
// the new home. Imports below use the same writer and native verification.
function signInCallback(login, account, { signal, after } = {}) {
  let submitted = false
  return async (code, opts = {}) => {
    if (submitted) return { type: "failed", error: "this sign-in has already checked a code; start it again" }
    submitted = true
    return inAccount(account.home, async () => {
      const signals = [signal, opts.signal].filter(Boolean)
      const active = signals.length ? AbortSignal.any(signals) : undefined
      try {
        const done = await login.finish(code, { signal: active })
        if (done.error) throw new Error(done.error)
        const result = after ? await after(active) : done
        active?.throwIfAborted()
        return result
      } catch (error) {
        dropHome(account.home)
        forgetStoredSignIn()
        return { type: "failed", error: error.message }
      }
    })
  }
}

async function googleSignIn(agy, account, { signal, key } = {}) {
  const login = await inAccount(account.home, () => startLogin(agy, { signal, onFailure: () => dropHome(account.home) }))
  if (login.error) return { type: "failed", error: login.error }
  return {
    url: login.url,
    instructions: "Open the authorization link manually and sign in with Google, then paste the authorization code or complete callback URL here. The link expires after 15 minutes; starting another sign-in replaces it.",
    method: "code",
    callback: signInCallback(login, account, { signal, after: active => completeSignIn(agy, account, { signal: active, key }) }),
  }
}

async function oauthSignIn(inputs, { signal, tokens = false } = {}) {
  if (signal?.aborted) return { type: "failed", error: "the sign-in was cancelled" }
  const agy = findAgy()
  if (!agy) return noAgy()
  let account
  try {
    const config = oauthConfig(inputs)
    account = newHome()
    const complete = async (token, active) => inAccount(account.home, async () => {
      active.throwIfAborted()
      const adc = nativeClient(config) ? null : {
        type: "authorized_user", client_id: config.client_id, client_secret: config.client_secret,
        refresh_token: token.refresh, token_uri: config.token_uri,
      }
      writeTokenFile(account.home, tokenFileText(token), adc)
      return completeSignIn(agy, account, { signal: active })
    })
    const options = { signal, onFailure: () => dropHome(account.home), complete }
    let login
    if (tokens) {
      const attempt = new LoginAttempt(options)
      login = { url: "", finish: (_code, opts) => attempt.submit(async active => {
        const token = await tokenLogin(inputs, config, { signal: active })
        return complete(token, active)
      }, opts) }
    } else login = await configuredLogin(config, options)
    if (login.error) throw new Error(login.error)
    return {
      url: login.url,
      instructions: tokens ? "" : "Open the authorization link manually. Paste the complete callback URL to validate its state, or paste the authorization code from this attempt. No local listener is needed. The link expires after 15 minutes.",
      method: tokens ? "auto" : "code",
      callback: signInCallback(login, account, { signal }),
    }
  } catch (error) {
    if (account) dropHome(account.home)
    return { type: "failed", error: error.message }
  }
}

// homeOfEmail is the id of the account home already signed in to email
// ("" for agy's own sign-in), or null when none is.
async function homeOfEmail(email) {
  const want = email.toLowerCase()
  const credential = reusableTerminalCredential()
  if (credential?.home && (await storedEmail({ home: credential.home })).toLowerCase() === want) return ""
  let ids = []
  try { ids = fs.readdirSync(accountsDir()) } catch {}
  for (const id of ids) {
    const home = homeOf(id)
    if (home && (await storedEmail({ home })).toLowerCase() === want) return id
  }
  return null
}

// importSignIns brings in the accounts the texts hold (import.mjs): each
// one an account home of its own, whose token file is the sign-in, kept
// once agy lists the account's models with it. An account signed in here
// already is left as it is and named again, so it isn't added twice.
async function importSignIns(texts, { signal } = {}) {
  const cancelled = () => ({ type: "failed", error: "the import was cancelled" })
  if (signal?.aborted) return cancelled()
  const accounts = importedAccounts(texts)
  if (!accounts.length) return { type: "failed", error: "no Antigravity sign-in was found in the imported data" }
  const agy = findAgy()
  if (!agy) return noAgy()
  const out = []
  const created = []
  try {
    for (const a of accounts) {
      if (signal?.aborted) return cancelled()
      const failed = (error) => ({ type: "failed", error, ...(a.email ? { accountId: a.email } : {}) })
      if (a.email) {
        const had = await homeOfEmail(a.email)
        if (signal?.aborted) return cancelled()
        if (had !== null) {
          out.push(await inAccount(homeOf(had), () => signedInAs(had)))
          continue
        }
      }
      let account
      try {
        account = newHome()
        created.push(account.home)
        writeTokenFile(account.home, tokenFileText(a))
      } catch (error) {
        if (account) dropHome(account.home)
        out.push(failed(`couldn't make a folder for the account: ${error.message}`))
        continue
      }
      out.push(await inAccount(account.home, async () => {
        try {
          return await completeSignIn(agy, account, { signal })
        } catch (error) {
          dropHome(account.home)
          return failed(`agy couldn't sign in with it: ${error.message}`)
        }
      }))
    }
    return signal?.aborted ? cancelled() : out
  } finally {
    // Magpie saves a batch only after import returns. On cancellation none
    // of this batch's new homes has a saved account, including earlier successes.
    if (signal?.aborted) for (const home of created) dropHome(home)
  }
}

// homeOfAuth is the home of the account a saved sign-in is, null for
// agy's own.
async function homeOfAuth(getAuth) {
  let auth
  try { auth = typeof getAuth === "function" ? await getAuth() : getAuth } catch {}
  return homeOf(homeIdOfAuth(auth))
}

// One usage reader per account: each holds its own last report.
const usageReaders = new Map()
function readUsageOf(home) {
  const key = home ?? ""
  let read = usageReaders.get(key)
  if (!read) usageReaders.set(key, (read = createUsageReader(findAgy)))
  return inAccount(home, () => read())
}

export const AntigravityBridgePlugin = async () => {
  keepAgyCurrent(findAgy)
  return {
    auth: {
      provider: PROVIDER_ID,
      // Magpie's hook for the CLI a plugin runs through: a sign-in on a
      // machine without agy (magpie in Docker) installs it first, into the
      // plugin's own folder (install.mjs). OpenCode ignores it.
      cli: {
        name: "Antigravity CLI",
        manual: AGY_MANUAL,
        installed: async () => findAgy() !== null,
        install: async ({ signal } = {}) => {
          if (findAgy()) return
          await installAgy({ signal })
          if (!findAgy()) throw new Error("agy was installed, but the plugin can't run it")
        },
      },
      // Magpie's usage hook; OpenCode ignores this extension. agy owns auth.
      usage: async (getAuth) => readUsageOf(await homeOfAuth(getAuth)),
      // magpie's "Import accounts from a file…" (OpenCode ignores it): the
      // retired Antigravity plugin's sign-ins, which magpie's Move hands over
      importFrom: IMPORT_FROM.en,
      importFroms: IMPORT_FROM.froms,
      import: (texts, options) => importSignIns(Array.isArray(texts) ? texts : [texts], options),
      methods: [
        {
          // Reuse agy's current sign-in, or start native manual login in a
          // new home without changing the user's original credentials.
          type: "oauth",
          label: "Sign in with Google",
          labels: { zh: "使用 Google 登录", "zh-TW": "使用 Google 登入", ja: "Google でサインイン" },
          authorize: async (_inputs, { signal } = {}) => {
            if (signal?.aborted) return { type: "failed", error: "the sign-in was cancelled" }
            const agy = findAgy()
            if (!agy) return noAgy()
            try {
              // A keyring-only login can list models outside the isolated TUI,
              // but cannot be reused inside it. Sign in to a new home instead.
              const credential = reusableTerminalCredential()
              if (credential && (await probeSignedIn(agy, { signal, fileStorage: !credential.adc })).ok) {
                return { url: "", instructions: "", method: "auto", callback: () => signedInAs("", "agy", { home: credential.home }) }
              }
              signal?.throwIfAborted()
              return googleSignIn(agy, newHome(), { signal, key: "agy" })
            } catch (error) {
              return { type: "failed", error: error.message }
            }
          },
        },
        {
          // Another Google account beside the first: agy signs in to it in
          // a home of its own (account.mjs), so the one agy has stays.
          // Always a new sign-in, even while agy is signed in (the first
          // way, signed in already, ends at once with nothing changed:
          // Archivemylife on X, "Sign in again" did nothing).
          type: "oauth",
          label: "Add another Google account",
          labels: { zh: "添加另一个 Google 账号", "zh-TW": "新增另一個 Google 帳號", ja: "別の Google アカウントを追加" },
          authorize: async (_inputs, { signal } = {}) => {
            if (signal?.aborted) return { type: "failed", error: "the sign-in was cancelled" }
            const agy = findAgy()
            if (!agy) return noAgy()
            let account
            try {
              account = newHome()
            } catch (error) {
              return { type: "failed", error: `couldn't make a folder for the account: ${error.message}` }
            }
            return googleSignIn(agy, account, { signal })
          },
        },
        {
          type: "oauth",
          label: "OAuth configuration authorization login",
          labels: { zh: "OAuth 配置授权登录", "zh-TW": "OAuth 設定授權登入", ja: "OAuth 設定で認証" },
          prompts: CODE_PROMPTS,
          authorize: (inputs, options) => oauthSignIn(inputs, options),
        },
        {
          type: "oauth",
          label: "Sign in with OAuth tokens",
          labels: { zh: "填写 OAuth Token 登录", "zh-TW": "填寫 OAuth Token 登入", ja: "OAuth トークンでサインイン" },
          prompts: TOKEN_PROMPTS,
          authorize: (inputs, options) => oauthSignIn(inputs, { ...options, tokens: true }),
        },
      ],
      loader: async (getAuth) => {
        // the account's own home, null for agy's own sign-in: every agy
        // its requests run is started there
        const home = await homeOfAuth(getAuth)
        return {
          baseURL: "agy://local",
          apiKey: "agy",
          fetch: (fetchInput, init = {}) => inAccount(home, async () => {
            const requestUrl = typeof fetchInput === "string"
              ? fetchInput
              : fetchInput instanceof URL
                ? fetchInput.href
                : fetchInput?.url || ""
            if (/\/count[_-]tokens(?:$|[/?#])/i.test(requestUrl)) {
              try {
                const raw = init.body != null
                  ? (typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body))
                  : (typeof fetchInput?.text === "function" ? await fetchInput.text() : "")
                const parsed = JSON.parse(raw)
                if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) {
                  return jsonError(400, "invalid count_tokens request")
                }
                return new Response(JSON.stringify({ input_tokens: estimateInputTokens(parsed) }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                })
              } catch (error) {
                return jsonError(400, error.message)
              }
            }

            const agy = findAgy()
            if (!agy) return jsonError(503, "agy CLI not found on this machine")
            // nothing stored to sign agy in with: agy would only start its
            // own Google sign-in, so the account is told to sign in again
            // (from the last read; a request doesn't wait for a new one)
            const notSignedIn = cannotSignIn(storedSignInNow())
            if (notSignedIn) {
              return jsonError(401, `${notSignedIn}: sign in again in magpie, or run \`agy\` in a terminal`, undefined,
                { headers: { "X-Magpie-Sign-In": "expired" } })
            }
            let body
            try {
              const raw = init.body != null
                ? (typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body))
                : (typeof fetchInput?.text === "function" ? await fetchInput.text() : "")
              body = JSON.parse(raw)
              validateBody(body)
            } catch (error) {
              return jsonError(error.statusCode ?? 400, error.message)
            }

            const rawModel = body.model || ""
            const requestedModel = (rawModel.includes("/") ? rawModel.split("/").pop() : rawModel).replace(/\[1m\]$/i, "")
            // One canonical form for both opening-system layouts, before anything
            // derives a key, instructions or history from the body.
            body = { ...foldSplitCalls(canonicalBody(body)), model: requestedModel }
            if (isOrchestrator(requestedModel)) return jsonError(400, orchestratorRefusal(requestedModel), undefined, { noRetry: true })
            const request = fetchInput instanceof Request ? fetchInput : undefined
            const headers = init.headers ?? request?.headers
            const selection = selectTerminalModel(agy, requestedModel, body, headers)
            return tuiResponse(agy, body, selection, {
              headers, signal: init.signal ?? request?.signal,
            }, { home, scope: requestSessionScope(fetchInput, init) })
          }),
        }
      },
    },
    provider: {
      id: PROVIDER_ID,
      npm: NPM_ANTHROPIC,
      // Not an OpenCode hook: the adapter in opencode2.mjs reads the list
      // once more when this background work ends.
      warming: () => catalogWarming(),
      models: async (_given, ctx) => inAccount(await homeOfAuth(ctx?.auth), async () => {
        const agy = findAgy()
        // Never force a refresh here: Magpie times models() out after about two seconds.
        const catalog = await loadModelCatalog(agy)
        // Google turned the account away (#3501): agy lists nothing, and a
        // fallback list would read as models this account has. magpie
        // keeps the list it had and shows why.
        const refused = agy ? refusalOf() : ""
        if (refused) throw new Error(refused)
        const out = {}
        if (ms().cachedModelCatalog.isFallback) out[Symbol.for("magpie.fellBack")] = true
        for (const model of catalog.models) {
          const imageModel = /^(?:gemini-|claude-)/.test(model.id)
          out[model.id] = {
            id: model.id,
            name: model.name,
            npm: NPM_ANTHROPIC,
            limit: modelLimits(model.id),
            api: { id: model.id, url: "agy://local", npm: NPM_ANTHROPIC },
            capabilities: {
              ...(imageModel ? { attachment: true, input: { text: true, image: true }, output: { text: true } } : {}),
              ...(model.variants ? { reasoning: true } : {}),
            },
            ...(model.variants ? {
              reasoning: true,
              variants: Object.fromEntries(model.variants.map(effort => [effort, {}])),
            } : {}),
          }
        }
        return out
      }),
    },
  }
}

// Only permanent tool-history 400s opt out of retries. Magpie header forwarding
// has not been verified; busy responses and existing 409s retain their semantics.
// `extra` merges diagnostic fields (attempts, turn_id) into the error object.
function jsonError(status, message, code, { extra, headers, noRetry = false } = {}) {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: status === 400 ? "invalid_request_error" : status === 403 ? "permission_error" : "api_error",
        ...(code ? { code } : {}), message: String(message || "unknown error"), ...(extra ?? {}) },
    }),
    { status, headers: { "Content-Type": "application/json",
      ...(status === 400 && noRetry ? NO_RETRY_HEADERS : {}), ...(headers ?? {}) } },
  )
}

export { sanitizeInputSchema }
export default { id: PROVIDER_ID, server: AntigravityBridgePlugin }

