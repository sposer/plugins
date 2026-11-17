# @magpie-community/opencode-grok-auth

Grok with a SuperGrok or X Premium+ subscription, through the sign-in of
xAI's [Grok Build CLI](https://x.ai/cli). Provider id: `grok`.

Device-code and OAuth logins work without an installed CLI. Using Grok
Build's current sign-in or importing CPA credentials needs Grok Build:

```sh
curl -fsSL https://x.ai/cli/install.sh | bash          # macOS, Linux
irm https://x.ai/cli/install.ps1 | iex                 # Windows
```

It is found in the installer's folder (`GROK_BIN_DIR`, `GROK_HOME/bin`,
`~/.grok/bin`), or on `PATH` when it lives under a `.grok` folder, so that
another program named `grok` isn't taken for it. Where the installer can't
run, such as a container without curl, put the binary in a folder of your
own and set `GROK_BIN_DIR` to it. magpie installs Grok Build itself, as
the installer does, before a sign-in that needs it.

## Images and speech

Images in a request (Anthropic image blocks, OpenAI `image_url`, Responses
`input_image`) go to Grok as sent, and its models take them. Speech to text
is the one Grok Build's voice dictation uses: magpie's
`/v1/audio/transcriptions` (model `grok/grok-4.7`, any of the account's
models) is sent on to xAI's `api.x.ai/v1/stt` with the account's sign-in.
`language` is passed on; `json`, `text` and `verbose_json` are answered, and
translations are refused.

## Sign in

All login links are opened manually. The plugin starts no browser or local
callback listener and never runs the CLI's login command.

- **Sign in with Grok Build (device code)** requests a device code directly
  from xAI. Open the displayed link yourself and approve the displayed
  code. Keep the login open while the plugin polls for approval.
- **Use Grok Build's current sign-in** reads the CLI's existing account
  (`GROK_HOME`, else `~/.grok`), with nothing to approve. No credential
  conversion or refresh-owner change is performed.
- **Import CPA xAI account JSON** accepts a path or pasted JSON for an
  enabled CPA xAI OAuth account (`~/.cli-proxy-api/xai-<email>.json`). In
  magpie, **Import accounts from a file…** also accepts multiple files and
  lists. Other platforms and non-OAuth accounts are skipped; invalid CPA
  credentials report an error. CPA imports require Grok Build's public
  client and its token issuer/audience. Duplicate identities reuse their
  existing home without rewriting it. Stop using the account in CPA first:
  both clients rotate the same refresh token. Import leaves source files
  and accounts unchanged and does not contact xAI.
- **OAuth authorization code (manual link and callback)** accepts OAuth
  client configuration, then shows an authorization link with PKCE. Open
  it yourself, authorize, and paste either the full callback URL (including
  `state`) or the authorization code. A full callback must match the
  configured redirect and this attempt's state. A bare code is exchanged
  with this attempt's PKCE verifier. A loopback page may fail to load:
  copy its callback URL from the address bar back into the login.
- **OAuth account fields (refresh token / access token)** accepts the
  OAuth configuration and an existing `refresh_token` or `access_token`.
  A refresh token takes precedence and is validated by an actual refresh
  grant, retaining its replacement. An access-only login needs a future
  RFC3339 `expires_at` or a positive `expires_in` in seconds; `token_type`
  defaults to `Bearer`. It remains access-only and needs a new login when
  expired or rejected. Tokens are validated against Grok's `/v1/user`
  before a new account is saved; identity comes from that endpoint, not
  unverified JWT claims. Stop refreshing an entered token in its previous
  client before continuing.

### OAuth configuration

Both OAuth methods offer the same fields:

| Field | Default / behavior |
| --- | --- |
| `client_id` | Grok Build's public client, `b1a00492-073a-47ea-816f-4c329264a828` |
| `client_secret` | Empty for a public client; saved with the account when supplied |
| Client authentication | Automatic: `none` without a secret, `client_secret_post` with one; explicit `client_secret_basic` and `client_secret_post` are supported |
| `redirect_uri` | `http://127.0.0.1:56121/callback`; use a redirect registered for your client, HTTPS or HTTP loopback |
| `scope` | `openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write` |

The issuer is `https://auth.x.ai`. `grok-cli:access` is required for this
provider's subscription backend. Custom clients and scopes must be enabled
for that backend by xAI; entering client fields does not grant subscription
access. Scopes without `openid` use OAuth without requiring an ID token.

Each interaction has a 10-minute local limit; device login also honors the
shorter device-code expiry. Cancellation, timeout or failure removes only
new, unsaved homes and releases timers and listeners. Repeated callbacks
return the same completed result. Refresh-token rotation is an external
side effect: if xAI returns a successor for an already-saved plugin OAuth
account, it is retained in that account's home even when the UI is cancelled
immediately afterwards. The old token is not restored.

## Where the sign-in is kept

OpenCode (or magpie) stores the account's home path, access token and expiry.
New device/code/account-fields logins always use this plugin's private
`$XDG_CONFIG_HOME/opencode-grok-auth/<random>` home (else under
`~/.config`), never the native CLI home. Re-signing the same plugin OAuth
identity updates its existing private home. A matching existing native or
CPA identity stays unchanged and does not absorb the new OAuth login.

New OAuth homes contain native-format `auth.json`, keyed by
`<issuer>::<client_id>`, and `config.toml` selecting that client and scopes.
`magpie_oauth` in the credential stores the configuration needed for the
plugin's OAuth refresh, including any client secret. Keep these homes under
the plugin's management: Grok Build's public-client refresh does not send
client secrets. Existing CLI and CPA credentials are neither migrated nor
assigned this new refresh owner.

New OAuth logins use `oauth4webapi` for device/code exchanges and refresh.
The [xAI discovery document](https://auth.x.ai/.well-known/openid-configuration)
and [Grok Build's native auth model](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-login/src/model.rs)
own the upstream contracts. The official Grok Build 1.0.88 Windows binary
was checked with synthetic credentials and loopback services: it consumed
a new OAuth home's native files and custom client for `grok models`.

### Renewal

- magpie calls `auth.refresh` 5 minutes before expiry. OpenCode instead
  renews before a request. Requests, model lists and usage reads share one
  refresh flight per home and retry once after a token rejection.
- New OAuth accounts refresh through the configured xAI client, with a
  30-second request deadline. The plugin persists any rotated token in the
  same native credential and returns the new access token and expiry.
  A failed grant leaves the saved credential intact and can be retried.
- Existing CLI and CPA accounts keep their original path: the plugin runs
  `grok models` in the account's home and reads the resulting `auth.json`.
  `GROK_AUTH_PATH` is excluded from that run so it targets that home. A
  refused request waits at most 15 seconds for this CLI refresh; the run
  continues, and later callers read its result.
- If a CLI refresh leaves the token unchanged, the error includes what
  Grok Build reported. Renew the CLI's own account in Grok Build; for a
  private legacy or imported account, add it in magpie again. A transient
  401 on a still-valid token that the CLI left unchanged remains a 503
  with `Retry-After: 60`, keeping the account rather than requesting login.
- An empty or invalid `auth.json` is retried for about half a second, then
  the last complete read is used if available. It is not treated as a
  logout. The plugin takes no `auth.json.lock`.

## Requests

Requests go to `https://cli-chat-proxy.grok.com/v1`, OpenAI's Responses
API (`@ai-sdk/openai`), signed as the CLI signs them:

- `Authorization: Bearer <token>`
- `x-xai-token-auth: xai-grok-cli`
- `x-grok-client-identifier: grok-shell`
- `x-grok-client-mode: headless`
- `x-grok-client-version` and `User-Agent: grok-shell/<version> (<os>; <arch>)`.
  The version is 1.0.88, or the installed CLI's if it is newer.
- `x-grok-model-override`: the request's model. A window suffix
  (`grok-4.7@500k`) is the plain model (`grok-4.7`) here and in the body.
- `x-grok-context-window`: the token count a suffixed model names
  (`500000` for `@500k`). The plain id sends no such header and stays on
  the default window.
- `x-grok-conv-id`: the request's `prompt_cache_key`.
- `x-grok-doom-loop-check: 1024` and `x-grok-exact-repetition-check: 64`
  on a Responses request, as Grok Build sends them: the proxy then stops a
  reply that repeats itself after ~1K tokens instead of letting it run on.
- A Responses stream that dies before its first byte (the connection
  reset, with nothing sent yet) is asked again, up to three times. The
  retry goes out before the answer is returned, so a 429 or a 401 comes
  back as itself. Once a byte has arrived, `response.created` and
  reasoning included, it is passed on at once. A later cut is not asked
  again and not rewritten: the stream ends, and magpie 0.1.3298 or newer
  closes it as `response.failed` with `created_at` and `sequence_number`.
  The frame this plugin used to write had `created_at` and still no
  `sequence_number`, so Grok Build reported
  `missing field sequence_number`. An upstream `response.failed`,
  `error` or `response.incomplete` is passed on unchanged. Cancelling
  the turn stops the read and is not asked again.

The backend turns away some of what a request may carry, so the plugin
leaves these out:

- tools of types it doesn't take (a freeform `apply_patch`, namespaces)
- `external_web_access` on web search
- a `tool_choice` naming a dropped type
- a `tool_choice` with no tools beside it (magpie sends `"none"` so when a
  client turned tools off)
- a reasoning item's `"content": null`

Plain Codex collaboration items (`agent_message`) reach Grok as user
messages, with their sender, recipient and content preserved. Sealed or
unrecognized content stays unchanged; the plugin does not decrypt tasks.

### Native X search (optional)

In magpie, open the Grok provider, turn on **Native X search** under
**Plugin options**, and save. It is off by default; changes apply to the
next request without restarting or signing in again.

When enabled, the plugin offers Grok its native `x_search` tool. Grok
decides whether to search; enabling it does not force a search on every
request. Existing function tools and X search filters are preserved, and
an existing `x_search` is not duplicated. Explicit choices such as `none`,
`required`, a named tool, or `allowed_tools` never gain another tool.

The option applies to Responses requests, including Chat Completions,
Anthropic Messages and Gemini requests that magpie converts to Responses,
in streaming and non-streaming mode. Use magpie with the fix for
[yetone/magpie#3110](https://github.com/yetone/magpie/issues/3110) so that
those clients' tool-disable choices reach the plugin.

For compatibility with older gateways, a request that reaches the plugin
with neither tools nor a `tool_choice` is left unchanged. This can happen
when magpie translates a client's automatic choice on an empty tool list.
To use X search through a translated API, send at least one function tool;
the plugin adds X search alongside it. An explicit tool-disable choice
always takes precedence.

This uses the existing `grok` provider's login, models and quota reporting;
no extra plugin is needed. It applies to that provider's models when the
upstream supports X search, not to Grok models served through Cursor or
another provider. Report problems in
[this repository](https://github.com/magpie-community/plugins/issues).

## Models

Grok 4.7 until signed in. Signed in, the models are the ones the account
lists at `/v1/models` (Responses models only), each with its reasoning
efforts as variants.

`context_window` is the default window and keeps the plain id, so a saved
`grok-4.7` stays a 256k model. Each other size in `context_windows` is
offered beside it, named `Grok 4.7 @ 500k` with id `grok-4.7@500k` and
that many tokens as its window. A request for it sends
`x-grok-context-window: 500000`. The proxy serves up to its largest
window either way and refuses past it; the header names the window the
caller asked to compact against. Pick `grok-4.7@500k` where a client
compacts at the advertised window, such as Claude Code.

## Usage

magpie's card shows the credits of the current period
(`/v1/billing?format=credits`): weekly for SuperGrok, with on-demand
spending beside it when it has a cap.

Grok's billing says nothing of a plan's rate limit, so a free account can
read 0% used while its requests come back 429. After a 429 the card shows
a spent "Rate limit" window until the reset it named (`Retry-After`, or a
`*ratelimit*reset*` header). When it named none, the window stays until a
request goes through, or for 5 minutes.

Grok Bot's separate allowance is shown by the [Cursor plugin](../cursor/README.md#usage).
Sign in there with the Cursor account linked in Grok Bot, including for
access through SuperGrok.
