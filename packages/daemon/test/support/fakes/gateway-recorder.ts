import type {
  BindCompletionArgs,
  CloseArgs,
  CreateThreadArgs,
  EnsureHostArgs,
  InterruptArgs,
  ListArgs,
  ReadArgs,
  SendArgs,
  SetModelArgs,
} from "../../../src/core/ports"
import type { ThreadId } from "../../../src/core/types"

export const GATEWAY_FAILPOINTS = [
  "afterDecideCommit",
  "afterCreateBeforeCommit",
  "afterCreateCommitBeforeSend",
] as const
export type GatewayFailpoint = (typeof GATEWAY_FAILPOINTS)[number]

export class GatewayFailpointError extends Error {
  readonly failpoint: GatewayFailpoint

  constructor(failpoint: GatewayFailpoint) {
    super(`gateway failpoint: ${failpoint}`)
    this.name = "GatewayFailpointError"
    this.failpoint = failpoint
  }
}

export type GatewayCall =
  | { readonly method: "create"; readonly args: CreateThreadArgs }
  | { readonly method: "send"; readonly args: SendArgs }
  | { readonly method: "read"; readonly args: ReadArgs }
  | { readonly method: "list"; readonly args: ListArgs }
  | { readonly method: "interrupt"; readonly args: InterruptArgs }
  | { readonly method: "close"; readonly args: CloseArgs }
  | { readonly method: "setModel"; readonly args: SetModelArgs }
  | { readonly method: "bindCompletion"; readonly args: BindCompletionArgs }
  | { readonly method: "ensureHost"; readonly args: EnsureHostArgs }
  | { readonly method: "sessionState"; readonly args: { readonly thread: ThreadId } }
  | { readonly method: "releaseHold"; readonly args: { readonly thread: ThreadId; readonly text: string } }
  | { readonly method: "probe"; readonly args: null }

export class GatewayRecorder {
  private readonly entries: GatewayCall[] = []

  record(call: GatewayCall): void {
    this.entries.push(call)
  }

  get calls(): readonly GatewayCall[] {
    return [...this.entries]
  }

  get createCalls(): readonly CreateThreadArgs[] {
    return this.entries.flatMap((call) => (call.method === "create" ? [call.args] : []))
  }

  get sendCalls(): readonly SendArgs[] {
    return this.entries.flatMap((call) => (call.method === "send" ? [call.args] : []))
  }

  get closeCalls(): readonly CloseArgs[] {
    return this.entries.flatMap((call) => (call.method === "close" ? [call.args] : []))
  }

  get bindCompletionCalls(): readonly BindCompletionArgs[] {
    return this.entries.flatMap((call) => (call.method === "bindCompletion" ? [call.args] : []))
  }

  get ensureHostCalls(): readonly EnsureHostArgs[] {
    return this.entries.flatMap((call) => (call.method === "ensureHost" ? [call.args] : []))
  }

  get releaseHoldCalls(): readonly { readonly thread: ThreadId; readonly text: string }[] {
    return this.entries.flatMap((call) => (call.method === "releaseHold" ? [call.args] : []))
  }
}
