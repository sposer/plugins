// xAI's first-party OAuth adapter. Protocol validation and grants belong to
// oauth4webapi; account homes and transactions belong to index.mjs.
import * as oauth from "oauth4webapi"
import { setTimeout as delay } from "node:timers/promises"

export const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
export const ISSUER = "https://auth.x.ai"
export const SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write"
export const REDIRECT_URI = "http://127.0.0.1:56121/callback"
// https://auth.x.ai/.well-known/openid-configuration (2026-11-17).
// This provider has one issuer, not a user-selected discovery/endpoint pair.
const server = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth2/authorize`,
  device_authorization_endpoint: `${ISSUER}/oauth2/device/code`,
  token_endpoint: `${ISSUER}/oauth2/token`,
  id_token_signing_alg_values_supported: ["ES256"],
}
const text = (v) => typeof v === "string" ? v.trim() : ""

export function configuration(inputs = {}) {
  const client_id = text(inputs.client_id) || CLIENT_ID
  const client_secret = text(inputs.client_secret)
  const auth_method = text(inputs.auth_method) || (client_secret ? "client_secret_post" : "none")
  if (!["none", "client_secret_post", "client_secret_basic"].includes(auth_method)) throw new Error("Choose none, client_secret_post or client_secret_basic for client authentication")
  if (auth_method !== "none" && !client_secret) throw new Error("This client authentication method requires client_secret")
  if (auth_method === "none" && client_secret) throw new Error("Choose a client-secret authentication method when supplying client_secret")
  const redirect_uri = text(inputs.redirect_uri) || REDIRECT_URI
  const redirect = new URL(redirect_uri)
  if (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname))) throw new Error("redirect_uri must be HTTPS or an HTTP loopback callback registered for this client")
  const scope = text(inputs.scope) || SCOPE
  if (!scope.split(/\s+/).includes("grok-cli:access")) throw new Error("Grok's CLI proxy requires the grok-cli:access scope")
  return { client_id, client_secret, auth_method, redirect_uri, scope }
}

const clientOf = (config) => ({ client_id: config.client_id, id_token_signed_response_alg: "ES256" })
const authentication = (config) => config.auth_method === "client_secret_basic" ? oauth.ClientSecretBasic(config.client_secret) : config.auth_method === "client_secret_post" ? oauth.ClientSecretPost(config.client_secret) : oauth.None()
const options = (signal) => ({ signal, [oauth.customFetch]: (...args) => fetch(...args), headers: { "x-grok-client-version": "1.0.88", "x-grok-client-surface": "ui" } })

export async function authorization(config) {
  const verifier = oauth.generateRandomCodeVerifier()
  const state = oauth.generateRandomState()
  const nonce = config.scope.split(/\s+/).includes("openid") ? oauth.generateRandomNonce() : undefined
  const url = new URL(server.authorization_endpoint)
  url.search = new URLSearchParams({
    response_type: "code", client_id: config.client_id, redirect_uri: config.redirect_uri,
    scope: config.scope, state, ...(nonce ? { nonce } : {}), code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256", referrer: "grok-build",
  }).toString()
  return { url: url.href, state, nonce, verifier }
}

export async function exchange(config, session, input, signal) {
  const value = text(input)
  if (!value) throw new Error("Paste the authorization code or full callback URL")
  let params
  if (/^https?:\/\//i.test(value)) {
    const callback = new URL(value)
    const redirect = new URL(config.redirect_uri)
    if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname) throw new Error("The callback URL does not match redirect_uri")
    params = callback.searchParams
  } else if (value.startsWith("code=") || value.startsWith("error=")) params = new URLSearchParams(value)
  else {
    // decision: bind a manually pasted bare code to this PKCE attempt; not
    // require a loopback listener because the user explicitly pastes the code.
    // Full callbacks still have their returned state checked by oauth4webapi.
    params = new URLSearchParams({ code: value, state: session.state })
  }
  const client = clientOf(config)
  const response = oauth.validateAuthResponse(server, client, params, session.state)
  const tokens = await oauth.authorizationCodeGrantRequest(server, client, authentication(config), response, config.redirect_uri, session.verifier, options(signal))
  return oauth.processAuthorizationCodeResponse(server, client, tokens, { expectedNonce: session.nonce })
}

export async function device(config, signal) {
  const response = await oauth.deviceAuthorizationRequest(server, clientOf(config), authentication(config), { scope: config.scope, referrer: "grok-build" }, options(signal))
  return oauth.processDeviceAuthorizationResponse(server, clientOf(config), response)
}

export async function poll(config, code, signal) {
  let interval = Math.max(1, code.interval ?? 5) * 1000
  for (;;) {
    await delay(interval, undefined, { signal })
    try {
      const response = await oauth.deviceCodeGrantRequest(server, clientOf(config), authentication(config), code.device_code, options(signal))
      return await oauth.processDeviceCodeResponse(server, clientOf(config), response)
    } catch (error) {
      if (!(error instanceof oauth.ResponseBodyError)) throw error
      if (error.error === "slow_down") interval += 5000
      else if (error.error !== "authorization_pending") throw error
    }
  }
}

export async function refresh(config, refreshToken, signal) {
  const response = await oauth.refreshTokenGrantRequest(server, clientOf(config), authentication(config), refreshToken, options(signal))
  return oauth.processRefreshTokenResponse(server, clientOf(config), response)
}

// Identity and proxy eligibility are established by /v1/user, not unverified
// JWT display claims or a foreign client's claim that its tokens are equivalent.
export async function nativeAuth(config, tokens, validateAccess, signal, previous) {
  signal?.throwIfAborted()
  const access = text(tokens.access_token)
  if (!access) throw new Error("xAI returned no access_token")
  if (tokens.token_type && tokens.token_type.toLowerCase() !== "bearer") throw new Error("Grok requires a Bearer access token")
  const expiry = tokens.expires_in !== undefined ? Date.now() + Number(tokens.expires_in) * 1000 : Date.parse(tokens.expires_at ?? "")
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("Supply a future expires_at or positive expires_in for the access token")
  const user = previous ? { userId: previous.user_id, email: previous.email } : await validateAccess(access, signal)
  signal?.throwIfAborted()
  if (!text(user.userId)) throw new Error("Grok's user endpoint returned no account identity")
  return {
    ...previous,
    key: access, auth_mode: "oidc", create_time: new Date().toISOString(),
    user_id: user.userId, email: text(user.email) || null,
    refresh_token: text(tokens.refresh_token) || previous?.refresh_token || undefined,
    expires_at: new Date(expiry).toISOString(), oidc_issuer: ISSUER, oidc_client_id: config.client_id,
    magpie_oauth: config,
  }
}

export async function accountFields(config, inputs, validateAccess, signal, onRefresh) {
  const refreshToken = text(inputs?.refresh_token)
  const access = text(inputs?.access_token)
  if (!refreshToken && !access) throw new Error("Enter refresh_token or access_token")
  // Validation of an RT is an actual refresh grant, preserving any rotation.
  const tokens = refreshToken ? await refresh(config, refreshToken, signal) : { access_token: access, token_type: text(inputs.token_type) || "Bearer", expires_at: text(inputs.expires_at), expires_in: text(inputs.expires_in) || undefined }
  tokens.refresh_token ||= refreshToken
  // Once xAI has rotated an RT already held by this plugin, its owner must
  // retain the successor even if the surrounding UI has just been cancelled.
  const retained = refreshToken && onRefresh ? await onRefresh(tokens) : undefined
  return retained || nativeAuth(config, tokens, validateAccess, signal)
}
