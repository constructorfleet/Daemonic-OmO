/**
 * Newline-delimited JSON between the bridge client (daemon process) and the bridge child (the only process
 * that loads omo JS). The child imports this module for types only, so it stays runnable under `node`
 * with type stripping as well as `bun`.
 *
 * client -> child: one `BridgeRequest` per line.
 * child -> client: one `BridgeReply` per request, plus unsolicited `BridgeEvent`s (`hello` first, always).
 */

export const SDK_METHODS = ["create", "send", "read", "list", "locate", "interrupt", "close", "set_model", "rename"] as const
export type SdkMethod = (typeof SDK_METHODS)[number]
export type BridgeMethod = SdkMethod | "bindCompletion"

export interface BridgeChildConfig {
  readonly pluginRoot: string
  readonly agentDir: string
  readonly user: string
}

export interface BridgeRequest {
  readonly id: number
  readonly method: BridgeMethod
  readonly args: unknown
}

export type BridgeReply =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: { readonly code: string; readonly message: string } }

export type BridgeHello =
  | { readonly event: "hello"; readonly sdk: "ok"; readonly runtime: string; readonly pid: number; readonly methods: readonly string[] }
  | { readonly event: "hello"; readonly sdk: "fail"; readonly runtime: string; readonly pid: number; readonly detail: string }

export interface BridgeCompletion {
  readonly event: "completion"
  readonly bindingId: string
  readonly thread: string
  readonly outcome: string
}

export type BridgeEvent = BridgeHello | BridgeCompletion

export interface BindCompletionRequest {
  readonly thread: string
  readonly events: readonly string[]
}
