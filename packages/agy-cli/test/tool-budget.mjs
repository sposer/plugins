import assert from "node:assert/strict"
import test from "node:test"
import { MIN_TEXT, TOOL_TOKEN_BUDGET, agyTokens, cut, fitTools } from "../tool-budget.mjs"

const total = (tools) => tools.reduce((n, t) => n + agyTokens(JSON.stringify(t)), 0)

// a schema with its prose taken out, so two shapes compare by what the model
// may send
function structure(node) {
  if (Array.isArray(node)) return node.map(structure)
  if (!node || typeof node !== "object") return node
  const out = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === "description") continue
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v).map(([n, s]) => [n, structure(s)])) : structure(v)
  }
  return out
}
const undecorated = (node) => {
  if (Array.isArray(node)) return node.map(undecorated)
  if (!node || typeof node !== "object") return node
  const out = {}
  for (const [k, v] of Object.entries(node)) {
    if (["$schema", "title", "examples"].includes(k)) continue
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v).map(([n, s]) => [n, undecorated(s)])) : undecorated(v)
  }
  return out
}

const long = (what, n) => `${what} does the thing it says. `.repeat(n) + "Examples: " + `${what}("a"), ${what}("b"). `.repeat(n)

// a client's catalog about plugins#1140's size: 80 tools, each with a
// long description, long property texts, an enum, a property named "title"
// and one contract property whose text is all there is to it
function catalog(n = 80, size = 2) {
  return Array.from({ length: n }, (_, i) => ({
    name: `tool_${i}`,
    description: long(`tool_${i}`, size),
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      title: `Tool ${i}`,
      properties: {
        title: { type: "string", description: long("title", size), examples: ["x"] },
        mode: { type: "string", enum: ["a", "b"], description: "Short." },
        style: { type: "object", description: "Variants: " + long("style", size) },
        list: { type: "array", items: { type: "string", description: long("item", size) } },
      },
      required: ["title"],
    },
    _meta: { "antigravity/alwaysLoad": true },
  }))
}

test("a catalog within the budget goes as it is", () => {
  const tools = catalog(10, 1)
  assert.ok(total(tools) <= TOOL_TOKEN_BUDGET)
  assert.equal(fitTools(tools), tools)
})

test("a catalog over the budget keeps every tool and its whole schema, and fits", () => {
  const tools = catalog()
  // about plugins#1140's 131 tools (~76 KB, ~25,000 agy tokens)
  assert.ok(total(tools) > 20000 && total(tools) < 30000, `the fixture is over agy's budget (${total(tools)})`)
  const fitted = fitTools(tools)
  assert.ok(total(fitted) <= TOOL_TOKEN_BUDGET, `fits (${total(fitted)})`)
  assert.deepEqual(fitted.map((t) => t.name), tools.map((t) => t.name))
  for (let i = 0; i < tools.length; i++) {
    // nothing that decides a valid argument changes: names, types, enum,
    // required, items; a property named "title" is the client's and stays
    assert.deepEqual(structure(fitted[i].inputSchema), structure(undecorated(tools[i].inputSchema)))
    assert.ok(fitted[i].inputSchema.properties.title, "the property named title stays")
    assert.equal(fitted[i].inputSchema.$schema, undefined)
    assert.equal(fitted[i].inputSchema.title, undefined)
    assert.deepEqual(fitted[i]._meta, tools[i]._meta)
    const p = fitted[i].inputSchema.properties
    // a short description is left whole; long ones are cut, a contract's least
    assert.equal(p.mode.description, "Short.")
    assert.ok(p.title.description.length < tools[i].inputSchema.properties.title.description.length)
    assert.ok(p.style.description.length > p.title.description.length, "a contract keeps more")
    assert.ok(fitted[i].description.length >= p.title.description.length, "a tool's own keeps more")
  }
  // the client's catalog itself is untouched
  assert.equal(tools[0].inputSchema.title, "Tool 0")
})

test("a catalog too large for any description keeps every tool", () => {
  const tools = catalog(400, 6)
  const fitted = fitTools(tools)
  assert.deepEqual(fitted.map((t) => t.name), tools.map((t) => t.name))
  for (const t of fitted) assert.equal(t.inputSchema.properties.title.description, undefined)
})

// plugins#1140's 131 tools after 0.1.46: the schemas alone took ~37 KB of
// the budget, the level stopped at 10, and 373 of 382 property texts went
// as 9-byte stubs ("The fil…") that spent ~10 KB on their keys
function heavy(n, props = 3) {
  return Array.from({ length: n }, (_, i) => ({
    name: `tool_${i}`,
    description: long(`tool_${i}`, 3),
    inputSchema: {
      type: "object",
      properties: {
        ...Object.fromEntries(Array.from({ length: props }, (_, j) => [`field_${j}`, { type: "string", description: long(`field_${j}`, 2) }])),
        view: { type: "object", description: long("view", 4) },
        flag: { type: "boolean", description: "Short." },
      },
    },
  }))
}
const bytes = (s) => new TextEncoder().encode(s).length

for (const n of [131, 180]) {
  test(`with ${n} heavy tools, no property text is a stub and the room goes to the tools' own (plugins#1140)`, () => {
    const tools = heavy(n)
    const fitted = fitTools(tools)
    assert.ok(total(fitted) <= TOOL_TOKEN_BUDGET, `fits (${total(fitted)})`)
    assert.deepEqual(fitted.map((t) => t.name), tools.map((t) => t.name))
    for (let i = 0; i < tools.length; i++) {
      assert.deepEqual(structure(fitted[i].inputSchema), structure(tools[i].inputSchema))
      const p = fitted[i].inputSchema.properties
      for (const [k, v] of Object.entries(p)) {
        const was = tools[i].inputSchema.properties[k].description
        if (v.description !== undefined && v.description !== was) assert.ok(bytes(v.description) >= MIN_TEXT, `${k}: ${v.description}`)
      }
      assert.equal(p.flag.description, "Short.", "a text that fits whole stays")
      const own = fitted[i].description
      if (own !== undefined) assert.ok(bytes(own) >= MIN_TEXT, `the tool's own: ${own}`)
      if (n === 131) assert.ok(own, "with room, every tool says what it is for")
      assert.ok(bytes(p.view.description ?? "") >= MIN_TEXT, `the contract keeps its text: ${p.view.description}`)
    }
  })
}

test("cut stops on a whole character, within the bytes, and drops the examples first", () => {
  const zh = "这是一个很长的中文说明，每个字是三个字节。".repeat(10)
  for (const max of [10, 11, 12, 40, 100]) {
    const out = cut(zh, max)
    assert.ok(new TextEncoder().encode(out).length <= max, `${max}: ${out}`)
    assert.ok(!out.includes("�"))
    assert.ok(out.endsWith("…"))
  }
  assert.equal(cut("Reads a file. Examples: read('a'), read('b')", 20), "Reads a file.")
  assert.equal(cut("short", 100), "short")
  assert.equal(cut("anything longer", 3), null)
})

test("cut preserves trailing schema-constraint hints ahead of prose and Examples", () => {
  const withExamples = 'Controls how the tool formats output. Examples: "compact", "verbose" (Allowed values: "compact", "verbose", "json", null)'
  // Dropping Examples from prose must not eat the trailing Allowed values hint.
  assert.equal(
    cut(withExamples, 100),
    'Controls how the tool formats output. (Allowed values: "compact", "verbose", "json", null)',
  )
  // When only enough room for the hint remains, drop prose cleanly without stubs.
  assert.equal(
    cut(withExamples, 65),
    'Allowed values: "compact", "verbose", "json", null',
  )
  // Nested parens in Variants and parens inside quoted enum values stay intact.
  const nestedVariants = 'Selects the desktop operation to execute across windows (Variants: { method: "click" } (Click at coords) | { method: "shot" } (Take shot))'
  assert.equal(
    cut(nestedVariants, 95),
    'Variants: { method: "click" } (Click at coords) | { method: "shot" } (Take shot)',
  )
  const quotedParens = 'Format selector for structured replies (Allowed values: "a)", "b(", null)'
  assert.equal(cut(quotedParens, 40), 'Allowed values: "a)", "b(", null')

  // Chained trailing hints keep balanced parens when prose is dropped.
  const chained = 'Config value used across requests (Accepts types: string | integer) (Allowed values: "auto", 1, null)'
  assert.equal(
    cut(chained, 75),
    '(Accepts types: string | integer) (Allowed values: "auto", 1, null)',
  )

  // Monotonicity and byte bound across every cap from 0 to full length.
  let prev = 0
  for (let max = 0; max <= bytes(withExamples) + 5; max++) {
    const out = cut(withExamples, max)
    const len = out ? bytes(out) : 0
    assert.ok(len <= max, `max=${max}: ${out}`)
    assert.ok(len >= prev, `non-monotonic at max=${max}: ${prev} -> ${len} (${out})`)
    prev = len
  }
})

test("lean mode protects lowered enum/const/type constraint hints in heavy catalogs", () => {
  const hintVariants = [
    {
      key: "theme",
      schema: {
        type: ["string", "null"],
        description: `${long("theme", 2)} (Allowed values: "light", "dark", null)`,
      },
      pattern: /Allowed values: "light", "dark", null/,
    },
    {
      key: "bare_enum",
      schema: {
        type: ["string", "null"],
        description: 'Allowed values: "fast", "safe", null',
      },
      exact: 'Allowed values: "fast", "safe", null',
    },
    {
      key: "version",
      schema: {
        type: "integer",
        description: `${long("version", 2)} (Must equal: 2)`,
      },
      pattern: /Must equal: 2/,
    },
    {
      key: "mode",
      schema: {
        type: "string",
        description: `${long("mode", 2)} (Known values include: "auto", "manual")`,
      },
      pattern: /Known values include: "auto", "manual"/,
    },
    {
      key: "target",
      schema: {
        type: "string",
        description: `${long("target", 2)} (Accepts types: string | integer)`,
      },
      pattern: /Accepts types: string \| integer/,
    },
    {
      key: "empty",
      schema: {
        description: `${long("empty", 2)} (Must be null.)`,
      },
      pattern: /Must be null\./,
    },
  ]
  const tools = Array.from({ length: 131 }, (_, i) => {
    const variant = hintVariants[i % hintVariants.length]
    return {
      name: `tool_${i}`,
      description: long(`tool_${i}`, 3),
      inputSchema: {
        type: "object",
        properties: {
          field_0: { type: "string", description: long(`field_0_${i}`, 2) },
          field_1: { type: "string", description: long(`field_1_${i}`, 2) },
          field_2: { type: "string", description: long(`field_2_${i}`, 2) },
          flag: { type: "boolean", description: "Short." },
          [variant.key]: variant.schema,
        },
      },
    }
  })
  assert.ok(total(tools) > 20000, `fixture exceeds budget (${total(tools)})`)
  const fitted = fitTools(tools)
  assert.ok(total(fitted) <= TOOL_TOKEN_BUDGET, `fits (${total(fitted)})`)
  assert.deepEqual(fitted.map((t) => t.name), tools.map((t) => t.name))
  for (let i = 0; i < fitted.length; i++) {
    const p = fitted[i].inputSchema.properties
    const variant = hintVariants[i % hintVariants.length]
    assert.equal(p.field_0.description, undefined, "ordinary long description dropped in lean mode")
    assert.equal(p.flag.description, "Short.", "short ordinary description stays whole")
    if (variant.exact) assert.equal(p[variant.key].description, variant.exact)
    else assert.match(p[variant.key].description ?? "", variant.pattern)
  }
})

test("lean mode pins longer enum hints under tight budgets before spending on prose", () => {
  const longHint = 'Allowed values: "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", null'
  const tools = Array.from({ length: 160 }, (_, i) => ({
    name: `tight_${i}`,
    description: long(`tight_${i}`, 3),
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "string", description: long(`a_${i}`, 2) },
        b: { type: "string", description: long(`b_${i}`, 2) },
        c: { type: "string", description: long(`c_${i}`, 2) },
        view: { type: "object", description: long(`view_${i}`, 4) },
        ...(i < 20
          ? {
              preset: {
                type: ["string", "null"],
                description: `${long("preset", 3)} (${longHint})`,
              },
            }
          : {}),
      },
    },
  }))
  const fitted = fitTools(tools)
  assert.ok(total(fitted) <= TOOL_TOKEN_BUDGET, `fits (${total(fitted)})`)
  for (let i = 0; i < 20; i++) {
    assert.equal(fitted[i].inputSchema.properties.a.description, undefined)
    assert.ok(
      (fitted[i].inputSchema.properties.preset.description ?? "").includes(longHint),
      `tool ${i} lost full enum hint: ${fitted[i].inputSchema.properties.preset.description}`,
    )
  }
})
