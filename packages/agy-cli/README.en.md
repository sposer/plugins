# agy-cli

Use the local Antigravity CLI (`agy`) as a model provider in Magpie. Clients
such as OpenCode and Claude Code send Anthropic Messages requests through Magpie.
The plugin generates replies through agy's native interactive terminal (TUI).
Model eligibility is decided by agy and Google.

**[中文 → README.md](README.md)** · Provenance, licensing and migration notes:
[NOTICE.md](NOTICE.md)

## Requirements

- The plugin host must run Linux and provide util-linux `script` at
  `/usr/bin/script`. Clients do not have to run on Linux.
- The Antigravity CLI (`agy`). The native TUI was verified with agy 1.5.18 in
  an isolated environment.
- Magpie 0.1.4246 or later.

## Install and use

Find “Antigravity (local agy CLI)” on Magpie's Plugins page and install it, or run:

```sh
magpie plugin add @magpie-community/opencode-agy-cli-auth
```

If agy is missing, **Sign in** first downloads the release used by Google's
installer, verifies its SHA-512 and installs it at
`$XDG_DATA_HOME/magpie-agy-cli/agy` (or `~/.local/share/magpie-agy-cli/agy` by
default). Your own installation takes priority. The plugin keeps its own copy
up to date when in use and does not replace one you installed yourself.

1. Find `agy-cli` on Magpie's Providers page, click **Sign in**, and choose a method:
   - **Sign in with Google**: Reuse agy's token file or explicitly configured ADC
     credentials. A sign-in stored only in the system keyring requires a new
     native sign-in.
   - **Add another Google account**: Always start a new native sign-in, leaving
     existing accounts unchanged.
   - **OAuth configuration authorization login**: Enter the OAuth client,
     registered redirect URI and scopes, or leave them blank to use agy's defaults.
   - **Sign in with OAuth tokens**: Enter a Google OAuth refresh token and its
     client configuration. The plugin checks the refresh grant before saving.

   Starting a new native Google sign-in requires a Linux plugin host and Bun
   with `Bun.Terminal` support. The plugin selects **Google OAuth** from agy's
   interactive terminal menu. Open the authorization link shown in Magpie, sign
   in, then paste either the authorization code or the full callback URL into
   Magpie. Reusing CLI credentials, configured OAuth and file imports do not
   need this sign-in terminal.
2. Select `agy-cli/<model>` in your client. When agy lists different IDs for
   thinking levels of the same model, Magpie shows them as variants. The plugin
   maps Magpie's chosen level to the nearest agy variant without inferring it
   from a translated token budget. Naming a variant ID pins that level.

Accounts added through a new sign-in or file import get their own agy homes
under `~/.local/state/magpie-agy-bridge/accounts/` (or the equivalent under
`$XDG_STATE_HOME`), leaving your original credentials alone. The plugin uses
`agy models` to check that the account can list models. Model and quota queries
use the selected account. For generation, the temporary terminal uses that
account's token file or configured ADC credentials. Signing in does not make
an account eligible for a particular model.

Accounts from the retired Antigravity plugin (`antigravity`) can still move
across with **Move**. **Import accounts from a file…** accepts that plugin's
sign-in records or agy's `antigravity-oauth-token` file. The plugin adds each
account only after agy checks it and skips emails already added. Cancelling an
import only removes unsaved account directories from that batch.

## Models and usage quota

The model catalog comes from `agy models` for each account. The plugin caches
successful results in `~/.local/state/magpie-agy-bridge/models.json` (or the
corresponding path under `$XDG_STATE_HOME`). When agy supports `--settings`, the
plugin passes `{"modelProvider":""}`, so the catalog reflects the Google account
rather than an AI Studio key from your settings. You can add an AI Studio key
as Google Gemini on Magpie's Providers page.

```sh
magpie quota agy-cli --json
magpie quota refresh agy-cli --json
```

Quota comes from agy's `/usage` report for the selected account and shows
subscription windows by model group. A window with no measurable data shows
“Limits not available”, not 0% or 100%. Quota reads do not rewrite credentials.
The displayed quota is informational and does not preemptively block generation.

If credentials are close to expiry or agy refuses `/usage` because of a region
restriction, the plugin queries Google directly and renews the access token only
in memory. If the direct query after a region refusal also fails, Magpie shows
agy's refusal rather than quota figures. Background queries do not start
interactive sign-in when no usable sign-in is available. Other quota failures
back off for 10 minutes at first, doubling up to six hours.

## Native TUI

- **Turns and isolation**: Each new user turn starts a temporary agy terminal
  and replays history within the prompt's byte budget. The terminal uses a
  separate home and working directory, without loading your usual settings or
  MCP configuration. The plugin cleans up the process and temporary directory
  when the turn ends. Control characters in the history reach the editor as
  Unicode control pictures such as `␛`, as plain text.
- **Tools**: A private MCP connection forwards agy's native tool calls to the
  client for execution. agy sends calls one at a time. Each matching
  `tool_result` continues the same native turn. If a tool returns an image,
  the plugin starts a new native turn with the actual result and attachment.
  A result whose native turn has ended, given up its slot or belongs to
  another session also replays with the history in a new native turn.
- **Usage**: Each response reports the input, output and cache-read tokens of
  the native steps completed since the previous response; a response with no
  new step reports zero. agy records no cache-write count, so
  `cache_creation_input_tokens` is always 0.
- **Images**: The plugin accepts inline base64 PNG, JPEG and WebP, not GIF or
  image URLs. agy receives images as clipboard attachments and places them
  after the text. The plugin marks each original image position by number.
- **Streaming**: Streaming clients receive SSE. If agy records thinking for a
  tool step, the plugin sends it with that step's first tool call rather than
  waiting for the turn to end. Text and thinking come from completed transcript
  entries, not token-by-token updates. The terminal may expand tabs to spaces.
- **Structured output and assistant prefill**: Structured output uses prompt
  instructions, not a provider-enforced schema. A request ending in a text-only
  assistant message adds that text to the prompt for continuation rather than
  setting a native assistant prefix. Prefill submitted with an unanswered tool
  call or a `tool_result` in the same turn may be rejected.

agy reads text and images only. Text documents (plain text or base64 text, JSON,
or XML) are sent as text. A URL document is sent as a URL only. PDFs attached
as input return HTTP 400; paste their text or attach their pages as images
instead. A PDF in a tool result is turned into a note asking the model to
extract the text another way.

## Concurrency and timeouts

- The plugin runs up to 16 generation turns at once; set `AGY_BRIDGE_MAX_PROCS`
  to change this. A turn waiting for a client tool result occupies a slot. When
  every slot is taken, the turn whose client has held its tool call longest,
  beyond 30 seconds, gives up its slot; that client's later result replays in a
  new native turn.
- The turn timeout bounds how long a native turn may go without a new
  transcript entry. Time spent waiting for a client tool result does not count;
  each tool result has its own wait limit. agy has at most 30 seconds each to
  start and to accept the prompt. A timeout returns HTTP 504.
- Magpie has a separate **Concurrency** field on its Providers page. It
  defaults to 16 and accepts 0 to 1000, where 0 means no limit on Magpie's side.
  The plugin returns HTTP 503 when all its slots are busy. Raising the
  Providers page setting does not raise the plugin's limit.

## Environment variables

| Name | Default | What it does |
|---|---|---|
| `AGY_PATH` | PATH lookup | Path to the agy executable |
| `AGY_BRIDGE_MAX_PROCS` | 16 | Maximum number of concurrent generation turns |
| `AGY_BRIDGE_TURN_TIMEOUT_MS` | 300000 | Longest time in milliseconds a native turn may go without a new transcript entry, excluding waits for tool results |
| `AGY_BRIDGE_TOOL_TIMEOUT_MS` | 1800000 | Longest time in milliseconds a native turn waits for one client tool result |
| `AGY_BRIDGE_MAX_PROMPT_BYTES` | 114688 (112 KiB) | Byte budget for the replayed history prompt |
| `AGY_BRIDGE_THINKING` | on | Set to `0` to omit `thinking` blocks; to disable for one request, send `thinking: { "type": "disabled" }` |
| `AGY_BRIDGE_EFFORT` | unset | Force a thinking level: `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| `AGY_BRIDGE_USAGE_TIMEOUT_MS` | 15000 | Total time budget for a usage query in milliseconds, capped at 18000 |
| `AGY_BRIDGE_STORED_SIGNIN` | unset | `skip` stops the plugin from reading agy's stored sign-in |
| `AGY_BRIDGE_PREFILL` | on | Set to `0` to reject assistant prefill with HTTP 400 |
| `AGY_BRIDGE_PREFILL_CARRIER_NOTE` | English note | Override the note sent to the model before the prefill text |
| `AGY_BRIDGE_MCP_TRACE` | unset | Write MCP traffic to the supplied path for debugging |
| `AGY_BRIDGE_EVENTS` | on | Set to `0` to stop writing `[agy-bridge]` turn events to stderr; events carry no prompts, arguments or results, at most 30 lines a minute |
| `AGY_CLI_DISABLE_AUTO_UPDATE` | `true` for the plugin's agy processes | Prevent concurrent generation processes from updating the same binary; a value you set is preserved |

## Troubleshooting

- **agy cannot be found**: Ensure `agy` is on the plugin host's PATH or set
  `AGY_PATH` to the executable.
- **The TUI will not start**: Check that the plugin runs on Linux and that
  `/usr/bin/script` on the host or in the container comes from util-linux.
- **“You do not have a valid license of this product”**: agy reports that the
  account is not eligible. Check `agy models` with the same account.
- **A tool result returns HTTP 409**: The native turn received its tool result
  while another request was still reading it, usually a client retry before the
  previous request ended. Send the result again after that request ends.
- **HTTP 504**: The message tells apart agy not becoming ready, not accepting
  the prompt and a turn with no progress. The `turn_end` line of
  `[agy-bridge]` on stderr gives the `reason`, `phase` and per-phase times.
- **Usage shows “Limits not available” or a version error**: The first means
  the window has no measurable data. For a version error, upgrade agy to 1.1.11
  or later.

## Development

From the repository root:

```sh
bun test packages/agy-cli
bun scripts/check.mjs agy-cli
```

## License

MIT. Copyright notices live in [LICENSE](LICENSE); upstream provenance and the
list of changes are in [NOTICE.md](NOTICE.md).
