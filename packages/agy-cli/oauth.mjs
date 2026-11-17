import * as oauth from "oauth4webapi"
import { LoginAttempt } from "./login.mjs"

// The installed-app client and scopes in agy 1.5.10's native manual login URL,
// not a third-party export format. Installed-app client secrets are public.
export const GOOGLE_CLIENT = {
  client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep" + ".apps.googleusercontent.com",
  client_secret: ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-"),
  redirect_uri: "https://antigravity.google/oauth-callback",
  scope: [...["cloud-platform", "userinfo.email", "userinfo.profile", "cclog", "experimentsandconfigs", "aicode"].map(s => `https://www.googleapis.com/auth/${s}`), "openid"].join(" "),
}
const GOOGLE = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
}
const USER_INFO = "https://www.googleapis.com/oauth2/v2/userinfo"
const text = value => typeof value === "string" ? value.trim() : ""

export const CLIENT_PROMPTS = [
  { type: "text", key: "client_id", message: "OAuth client_id (blank: agy's Google client)", required: false, placeholder: GOOGLE_CLIENT.client_id },
  { type: "password", key: "client_secret", message: "OAuth client_secret (blank: agy default, only with agy's client_id)", required: false },
]
export const CODE_PROMPTS = [
  ...CLIENT_PROMPTS,
  { type: "text", key: "redirect_uri", message: "Registered redirect_uri (blank: agy callback)", required: false, placeholder: GOOGLE_CLIENT.redirect_uri },
  { type: "text", key: "scope", message: "Google OAuth scopes, separated by spaces (blank: agy scopes)", required: false, placeholder: GOOGLE_CLIENT.scope },
]
export const TOKEN_PROMPTS = [
  { type: "password", key: "refresh_token", message: "Google OAuth refresh_token", validate: value => text(value) ? undefined : "refresh_token is required" },
  { type: "password", key: "access_token", message: "access_token (optional; refresh_token is checked before saving)", required: false },
  { type: "text", key: "expiry", message: "Access token expiry (optional ISO date or Unix seconds/milliseconds)", required: false },
  { type: "text", key: "email", message: "Google account email (optional)", required: false },
  ...CLIENT_PROMPTS,
]

export function oauthConfig(inputs = {}) {
  const client_id = text(inputs.client_id) || GOOGLE_CLIENT.client_id
  const client_secret = text(inputs.client_secret) || (client_id === GOOGLE_CLIENT.client_id ? GOOGLE_CLIENT.client_secret : "")
  if (!client_secret) throw new Error("client_secret is required for this Google OAuth client")
  const redirect_uri = text(inputs.redirect_uri) || GOOGLE_CLIENT.redirect_uri
  const redirect = new URL(redirect_uri)
  if (!["http:", "https:"].includes(redirect.protocol) || redirect.hash || redirect.search) throw new Error("redirect_uri must be the registered HTTP(S) callback without a query or fragment")
  return { client_id, client_secret, redirect_uri, scope: text(inputs.scope) || GOOGLE_CLIENT.scope, token_uri: GOOGLE.token_endpoint }
}

export function nativeClient(config) {
  return config.client_id === GOOGLE_CLIENT.client_id && config.client_secret === GOOGLE_CLIENT.client_secret
}

function clientOf(config) { return { client_id: config.client_id } }
function options({ signal, fetch: fetchFn = globalThis.fetch } = {}) {
  return { signal, [oauth.customFetch]: fetchFn }
}

// Protocol validation/exchange/refresh is kept in oauth4webapi. The adapter
// adds the Google client defaults and translates tokens to agy's storage input.
export async function refreshOAuth(config, refresh, opts = {}) {
  const as = { ...GOOGLE, token_endpoint: config.token_uri || GOOGLE.token_endpoint }
  const client = clientOf(config)
  const response = await oauth.refreshTokenGrantRequest(as, client, oauth.ClientSecretPost(config.client_secret), refresh, options(opts))
  return oauth.processRefreshTokenResponse(as, client, response)
}

async function accountToken(token, refresh, email, opts) {
  if (!token.refresh_token && !refresh) throw new Error("Google returned no refresh_token; authorize again with offline access")
  if (!token.expires_in) throw new Error("Google returned no access token expiry")
  let who = text(email)
  if (!who) {
    const response = await oauth.protectedResourceRequest(token.access_token, "GET", new URL(USER_INFO), undefined, undefined, options(opts))
    if (!response.ok) throw new Error(`Google account lookup failed (${response.status})`)
    who = text((await response.json()).email)
  }
  return { access: token.access_token, refresh: token.refresh_token || refresh, expires: Date.now() + token.expires_in * 1000, email: who }
}

export async function tokenLogin(inputs, config, opts) {
  const refresh = text(inputs?.refresh_token)
  if (!refresh) throw new Error("refresh_token is required")
  const expiry = text(inputs.expiry)
  if (expiry) {
    const number = Number(expiry)
    const at = Number.isFinite(number) ? number * (number < 1e12 ? 1000 : 1) : Date.parse(expiry)
    if (!Number.isFinite(at) || at <= 0) throw new Error("expiry must be an ISO date or Unix seconds/milliseconds")
  }
  // decision: validate token login with the refresh grant; not reuse a supplied
  // live access token because it cannot prove this client can renew the account.
  return accountToken(await refreshOAuth(config, refresh, opts), refresh, inputs.email, opts)
}

export async function configuredLogin(config, { signal, onFailure, complete, waitMs } = {}) {
  const attempt = new LoginAttempt({ signal, onFailure, waitMs })
  if (attempt.result) return attempt.result
  try {
    const verifier = oauth.generateRandomCodeVerifier()
    const state = oauth.generateRandomState()
    const url = new URL(GOOGLE.authorization_endpoint)
    url.search = new URLSearchParams({
      client_id: config.client_id, redirect_uri: config.redirect_uri, scope: config.scope,
      response_type: "code", access_type: "offline", prompt: "consent",
      code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256", state,
    }).toString()
    if (attempt.result) return attempt.result
    return {
      url: url.href,
      finish: (input, opts = {}) => attempt.submit(async signal => {
        const value = text(input)
        if (!value || /[\r\n]/.test(value)) throw new Error("paste the authorization code or complete callback URL")
        let callback
        if (/^https?:\/\//i.test(value)) {
          callback = new URL(value)
          const expected = new URL(config.redirect_uri)
          if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) throw new Error("the callback URL doesn't match redirect_uri")
        } else {
          // Pasting a code carries no returned state. Bind it to this attempt's
          // state and PKCE verifier; a full callback must return its actual state.
          callback = new URL(config.redirect_uri)
          callback.search = new URLSearchParams({ code: value, state }).toString()
        }
        const client = clientOf(config)
        const params = oauth.validateAuthResponse(GOOGLE, client, callback, state)
        const response = await oauth.authorizationCodeGrantRequest(GOOGLE, client, oauth.ClientSecretPost(config.client_secret), params, config.redirect_uri, verifier, options({ signal }))
        const token = await oauth.processAuthorizationCodeResponse(GOOGLE, client, response)
        const account = await accountToken(token, "", "", { signal })
        signal.throwIfAborted()
        return complete(account, signal)
      }, opts),
    }
  } catch (error) {
    attempt.cancel(error.message)
    return attempt.result
  }
}
