import { readFile } from "node:fs/promises"
import * as oauth from "oauth4webapi"
import { ConfigError } from "../config"
import type { OidcConfig } from "../config"
import type { Clock } from "../core/ports"
import { AuthError } from "./http"
import type { PendingLogin } from "./login-state"
import type { IdentityClaims } from "./types"

// A provider that never answers would otherwise hold the login request open;
// no config key bounds it, so the fixed bound is generous.
const PROVIDER_TIMEOUT_MS = 30_000

const PROTOCOL_ERRORS = [
  oauth.AuthorizationResponseError,
  oauth.ResponseBodyError,
  oauth.WWWAuthenticateChallengeError,
  oauth.OperationProcessingError,
] as const

export async function readClientSecret(path: string): Promise<string> {
  try {
    const secret = (await readFile(path, "utf8")).trim()
    if (secret.length > 0) return secret
  } catch (error) {
    throw new ConfigError("secrets_unavailable", `cannot read oidc.clientSecretFile ${path}`, { path, cause: error })
  }
  throw new ConfigError("secrets_unavailable", `oidc.clientSecretFile ${path} is empty`, { path })
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

function rejected(error: unknown, message: string): never {
  if (!PROTOCOL_ERRORS.some((type) => error instanceof type)) throw error
  const reason = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "protocol_error"
  throw new AuthError("unauthenticated", message, { reason })
}

function stringList(value: unknown): readonly string[] {
  if (typeof value === "string") return [value]
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

export interface OidcClientOptions {
  readonly clientSecret: string
  readonly redirectUri: string
  readonly clock: Clock
}

export function createOidcClient(config: OidcConfig, options: OidcClientOptions) {
  const issuer = new URL(config.issuer)
  // Plain-http providers are accepted only on loopback (local development and
  // the mock provider in tests); anything remote must be https.
  const transport = {
    [oauth.allowInsecureRequests]: issuer.protocol === "http:" && isLoopbackHostname(issuer.hostname),
    signal: () => AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  }
  let metadata: Promise<oauth.AuthorizationServer> | null = null

  function server(): Promise<oauth.AuthorizationServer> {
    metadata ??= oauth.discoveryRequest(issuer, transport)
      .then((response) => oauth.processDiscoveryResponse(issuer, response))
      .catch((error: unknown) => {
        metadata = null
        throw new AuthError("internal", "oidc provider discovery failed", {
          reason: error instanceof Error ? error.name : "unknown",
        })
      })
    return metadata
  }

  // ID token time checks run against the injected Clock: oauth4webapi adds
  // clockSkew seconds to the real clock, so the skew is the Clock's offset.
  function client(): oauth.Client {
    return {
      client_id: config.clientId,
      [oauth.clockSkew]: Math.round((options.clock.now() - Date.now()) / 1000),
    }
  }

  function clientAuth(as: oauth.AuthorizationServer): oauth.ClientAuth {
    const methods = as.token_endpoint_auth_methods_supported
    const postOnly = methods !== undefined && !methods.includes("client_secret_basic") && methods.includes("client_secret_post")
    return postOnly ? oauth.ClientSecretPost(options.clientSecret) : oauth.ClientSecretBasic(options.clientSecret)
  }

  function identity(claims: oauth.IDToken): IdentityClaims {
    return {
      issuer: claims.iss,
      subject: claims.sub,
      email: typeof claims.email === "string" ? claims.email : null,
      emailVerified: claims.email_verified === true,
      name: typeof claims.name === "string" ? claims.name : null,
      groups: config.groupsClaim === undefined ? [] : stringList(claims[config.groupsClaim]),
    }
  }

  return {
    async authorizationUrl(pending: PendingLogin): Promise<URL> {
      const as = await server()
      if (as.authorization_endpoint === undefined) {
        throw new AuthError("internal", "oidc provider advertises no authorization_endpoint")
      }
      const url = new URL(as.authorization_endpoint)
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: options.redirectUri,
        response_type: "code",
        scope: config.scopes.join(" "),
        state: pending.state,
        nonce: pending.nonce,
        code_challenge: await oauth.calculatePKCECodeChallenge(pending.verifier),
        code_challenge_method: "S256",
      }).toString()
      return url
    },

    async complete(callbackUrl: URL, pending: PendingLogin): Promise<IdentityClaims> {
      const as = await server()
      const oauthClient = client()
      let parameters: URLSearchParams
      try {
        parameters = oauth.validateAuthResponse(as, oauthClient, callbackUrl, pending.state)
      } catch (error) {
        rejected(error, "authorization response rejected")
      }
      try {
        const response = await oauth.authorizationCodeGrantRequest(
          as, oauthClient, clientAuth(as), parameters, options.redirectUri, pending.verifier, transport,
        )
        const result = await oauth.processAuthorizationCodeResponse(as, oauthClient, response, {
          expectedNonce: pending.nonce,
          requireIdToken: true,
        })
        const claims = oauth.getValidatedIdTokenClaims(result)
        if (claims === undefined) throw new AuthError("unauthenticated", "provider returned no id token")
        return identity(claims)
      } catch (error) {
        if (error instanceof AuthError) throw error
        rejected(error, "id token rejected")
      }
    },
  }
}

export type OidcClient = ReturnType<typeof createOidcClient>
