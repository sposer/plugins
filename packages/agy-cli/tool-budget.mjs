// agy holds every MCP tool it loads into one customization budget of 20,000
// tokens, counted as ceil(UTF-8 bytes / 3). Over it, agy drops whole tools,
// the largest first, so the best-documented ones (bash, a canvas's write
// tool) vanish from the model's function list, and with `tools: []` there is
// no other way to reach them (plugins#1140). fitTools trims the tools' prose
// instead, so every tool and every bit of its schema stays: names, property
// names, types, enums, required, items, anyOf and the bounds all go as the
// client wrote them. Only descriptions are shortened, and only as far as the
// budget needs.

// What the listed tools may take of agy's 20,000: the rest is room for the
// server prefix agy adds to each name and its own serialization.
export const TOOL_TOKEN_BUDGET = 18000

const enc = new TextEncoder()
const bytes = (s) => enc.encode(s).length
export const agyTokens = (s) => Math.ceil(bytes(s) / 3)

const tokensOf = (tools) => tools.reduce((n, tool) => n + agyTokens(JSON.stringify(tool)), 0)

// Keywords that say nothing about which arguments are valid. They are taken
// out only where they are keywords: a property named "title" is the
// client's, and stays.
const DECOR = new Set(["$schema", "title", "examples"])

// A property whose description is its contract: an object with no
// properties of its own, or one whose description carries schema constraints
// that tool-schema.mjs or sanitizeInputSchema lowered into text (unions,
// nullable/non-string enums, const values, open enums, multi-type unions).
// Its text is the only place the model learns what goes in it, so it keeps
// more of it and preserves trailing constraint hints ahead of prose.
// decision: protect lowered constraint hints as contracts and preserve
// trailing hints during truncation; not keep native enum on nullable string
// fields because CloudCode rejects null in enum, JSON Schema 2020-12 rejects
// null when enum omits null, and dropping null narrows the client contract;
// revisit when agy's CloudCode translator honors primitive anyOf unions natively.
const CONTRACT_WEIGHT = 11
const TOOL_WEIGHT = 2.5
const MAX_HINT_FLOOR = 512

const CONTRACT_HINT_RE = /\b(?:Variants|Accepts anyOf|Allowed values|Must equal|Known values include|Accepts types):|\bMust be null\./
const CONTRACT_HINT_START_RE = /^(?:(?:Variants|Accepts anyOf|Allowed values|Must equal|Known values include|Accepts types):|Must be null\.)/
const SCALAR_HINT_START_RE = /^\(?(?:(?:Allowed values|Must equal|Known values include|Accepts types):|Must be null\.)/
const CONTRACT_HINT_PAREN_RE = /\s+\((?=(?:Variants|Accepts anyOf|Allowed values|Must equal|Known values include|Accepts types):|Must be null\.)/
const CONTRACT_HINT_INLINE_RE = /\s+(?=(?:Variants|Accepts anyOf|Allowed values|Must equal|Known values include|Accepts types):|Must be null\.)/

function isContract(node) {
  if (!node || typeof node !== "object") return false
  const d = typeof node.description === "string" ? node.description : ""
  if (CONTRACT_HINT_RE.test(d)) return true
  const types = Array.isArray(node.type) ? node.type : [node.type]
  return types.includes("object") && !(node.properties && Object.keys(node.properties).length)
}

function unwrapOuterParens(s) {
  if (!s.startsWith("(") || !s.endsWith(")")) return s
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "(") depth++
    else if (ch === ")") {
      depth--
      if (depth === 0) return i === s.length - 1 ? s.slice(1, -1) : s
    }
  }
  return s
}

function splitContractHint(text) {
  const trimmed = text.trim()
  const unwrapped = unwrapOuterParens(trimmed)
  if (CONTRACT_HINT_START_RE.test(unwrapped)) {
    return { prose: "", hint: trimmed, bareHint: unwrapped }
  }
  const paren = CONTRACT_HINT_PAREN_RE.exec(text)
  const inline = CONTRACT_HINT_INLINE_RE.exec(text)
  const match = paren && (!inline || paren.index <= inline.index) ? paren : inline
  if (!match) return null
  const prose = text.slice(0, match.index).trimEnd()
  const hint = text.slice(match.index).trimStart()
  return { prose, hint, bareHint: unwrapOuterParens(hint) }
}

function hintFloor(node) {
  if (!node || typeof node !== "object" || typeof node.description !== "string") return 0
  const split = splitContractHint(node.description)
  if (!split || !SCALAR_HINT_START_RE.test(split.bareHint)) return 0
  return Math.min(bytes(split.bareHint), MAX_HINT_FLOOR)
}

function cutPlain(text, max, stripExamples = true) {
  if (bytes(text) <= max) return text
  const bare = stripExamples ? text.replace(/\s*\bExamples?:[\s\S]*$/i, "").trimEnd() : text
  if (bare && bytes(bare) <= max) return bare
  const room = max - bytes("…")
  if (room < 4) return null
  let out = ""
  let used = 0
  for (const ch of bare || text) {
    const b = bytes(ch)
    if (used + b > room) break
    out += ch
    used += b
  }
  const stop = Math.max(...[". ", "; ", "。", "；"].map((p) => out.lastIndexOf(p)))
  if (stop > out.length / 2) out = out.slice(0, stop + 1)
  return out.trimEnd() + "…"
}

function cutWithHint(text, max, enforceMinText) {
  if (bytes(text) <= max) return text
  const split = splitContractHint(text)
  if (!split) return enforceMinText && max < MIN_TEXT ? null : cutPlain(text, max, true)
  if (!split.prose) {
    if (bytes(split.bareHint) <= max) return split.bareHint
    return enforceMinText && max < MIN_TEXT ? null : cutPlain(split.bareHint, max, false)
  }
  if (bytes(split.bareHint) <= max) {
    const proseRoom = max - bytes(split.hint) - 1
    if (proseRoom > 0) {
      const bareProse = split.prose.replace(/\s*\bExamples?:[\s\S]*$/i, "").trimEnd()
      if (bareProse && bytes(bareProse) <= proseRoom) return `${bareProse} ${split.hint}`
      if (proseRoom >= MIN_TEXT) {
        const kept = cutPlain(split.prose, proseRoom, true)
        if (kept) return `${kept} ${split.hint}`
      }
    }
    return split.bareHint
  }
  return enforceMinText && max < MIN_TEXT ? null : cutPlain(split.bareHint, max, false)
}

// cut shortens text to at most max UTF-8 bytes. When text carries a trailing
// schema-constraint hint, it reserves room for the hint and trims leading prose
// (dropping a trailing Examples block from prose first); otherwise it drops a
// trailing Examples block first, ends on a sentence boundary where one is near,
// else on a whole code point, and marks the cut with "…". null when nothing
// worth keeping fits.
export function cut(text, max) {
  return cutWithHint(text, max, false)
}

// A cut text shorter than this says nothing ("The fil…") and only spends
// the budget on its key: such a description goes whole or not at all
// (plugins#1140).
export const MIN_TEXT = 24

// trim is text within max bytes: whole when it fits, else cut (preserving a
// complete trailing contract hint when it fits), else null when what a cut
// would leave is under MIN_TEXT.
function trim(text, max) {
  return cutWithHint(text, max, true)
}

// walk copies one schema node with every description capped: cap(node)
// gives the byte cap for a node's description, and Infinity leaves it.
// strip takes the decorative keywords out too.
function walk(node, cap, strip) {
  if (Array.isArray(node)) return node.map((item) => walk(item, cap, strip))
  if (!node || typeof node !== "object") return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (strip && DECOR.has(key)) continue
    if (key === "description" && typeof value === "string") {
      const max = cap(node)
      const text = max === Infinity ? value : trim(value, max)
      if (text) out.description = text
      continue
    }
    if ((key === "properties" || key === "$defs" || key === "definitions" || key === "patternProperties") && value && typeof value === "object" && !Array.isArray(value)) {
      // a map of names to schemas: the names are the client's, never keywords
      out[key] = Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, walk(schema, cap, strip)]))
      continue
    }
    if (key === "enum" || key === "const" || key === "default" || key === "required") {
      out[key] = value
      continue
    }
    out[key] = walk(value, cap, strip)
  }
  return out
}

function shaped(tools, { strip, L, lean, plainCap, pinHints = false }) {
  // lean: an ordinary property keeps only a description short enough to
  // go whole, and the room goes to the tools' own and the contracts'
  const plain = plainCap !== undefined ? plainCap : (lean ? MIN_TEXT - 1 : L)
  const prop = L === undefined
    ? () => Infinity
    : (node) => {
        const base = isContract(node) ? CONTRACT_WEIGHT * L : plain
        return pinHints ? Math.max(base, hintFloor(node)) : base
      }
  return tools.map((tool) => {
    const out = { ...tool }
    if (tool.inputSchema && typeof tool.inputSchema === "object") out.inputSchema = walk(tool.inputSchema, prop, strip)
    if (typeof tool.description === "string") {
      const max = L === undefined ? Infinity : TOOL_WEIGHT * L
      const text = max === Infinity ? tool.description : trim(tool.description, max)
      if (text) out.description = text
      else delete out.description
    }
    return out
  })
}

// highest finds the largest whole n in [lo, hi] for which fits(n) holds,
// given that it holds at lo; fits is monotone in n.
function highest(lo, hi, fits) {
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  return lo
}

// fitTools gives the tools as agy should list them: unchanged when they fit
// the budget, else with the decorative keywords gone, then with every
// description capped at the highest level that fits (a tool's own
// description gets 2.5 times a property's, a contract property's 11 times).
// When that level leaves an ordinary property less than MIN_TEXT, those
// properties keep only what goes whole, lowered scalar/enum constraint hints
// keep enough room to stay intact (up to MAX_HINT_FLOOR), and the highest
// level that fits goes to the tools' own descriptions and the contracts'.
// A set too large even with no descriptions at all goes as small as it can,
// and agy drops what is left over.
export function fitTools(tools, budget = TOOL_TOKEN_BUDGET) {
  if (tokensOf(tools) <= budget) return tools
  const stripped = shaped(tools, { strip: true })
  if (tokensOf(stripped) <= budget) return stripped
  const bare = shaped(tools, { strip: true, L: 0 })
  if (tokensOf(bare) > budget) return bare
  const at = (L) => shaped(tools, { strip: true, L, pinHints: L >= MIN_TEXT })
  const L = highest(0, 4000, (n) => tokensOf(at(n)) <= budget)
  if (L >= MIN_TEXT) return at(L)
  const leanPinned = (n) => shaped(tools, { strip: true, L: n, lean: true, pinHints: true })
  if (tokensOf(leanPinned(0)) <= budget) return leanPinned(highest(0, 4000, (n) => tokensOf(leanPinned(n)) <= budget))
  const leanHintsOnly = (n) => shaped(tools, { strip: true, L: n, plainCap: 0, pinHints: true })
  if (tokensOf(leanHintsOnly(0)) <= budget) return leanHintsOnly(highest(0, 4000, (n) => tokensOf(leanHintsOnly(n)) <= budget))
  const lean = (n) => shaped(tools, { strip: true, L: n, lean: true })
  if (tokensOf(lean(0)) > budget) return at(L)
  return lean(highest(0, 4000, (n) => tokensOf(lean(n)) <= budget))
}
