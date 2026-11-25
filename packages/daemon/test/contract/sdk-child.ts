// Runs thread SDK calls in a child process under the bridge runtime, the way
// todo 12's bridge will: the test process never loads omo JS itself.
// Usage: <runtime> sdk-child.ts '<json SdkChildRequest>'; stdout is one JSON SdkChildReply.

export interface SdkCall {
  readonly method: string
  readonly args?: unknown
}

export interface SdkChildRequest {
  readonly pluginRoot: string
  readonly agentDir: string
  readonly cwd: string
  readonly calls: readonly SdkCall[]
}

export type SdkChildReply =
  | {
      readonly kind: "ok"
      readonly runtime: string
      readonly methods: readonly string[]
      readonly results: readonly unknown[]
    }
  | { readonly kind: "load_error"; readonly runtime: string; readonly message: string }

interface ThreadSdk {
  readonly [method: string]: unknown
  dispose(): Promise<void>
}

interface ThreadSdkModule {
  createThreadSdk(options: {
    readonly agentDir: string
    readonly cwd: string
    readonly uid: number
    readonly user: string
  }): ThreadSdk
}

const runtime = typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`

async function main(raw: string): Promise<SdkChildReply> {
  const request: SdkChildRequest = JSON.parse(raw)
  let mod: ThreadSdkModule
  try {
    mod = await import(`${request.pluginRoot}/runtime/thread-sdk/sdk.js`)
  } catch (error) {
    return { kind: "load_error", runtime, message: error instanceof Error ? error.message : String(error) }
  }
  const sdk = mod.createThreadSdk({
    agentDir: request.agentDir,
    cwd: request.cwd,
    uid: process.getuid?.() ?? 0,
    user: "omo-daemonic-contract",
  })
  try {
    const results: unknown[] = []
    for (const call of request.calls) {
      const fn = sdk[call.method]
      results.push(
        typeof fn === "function"
          ? await fn.call(sdk, call.args)
          : { kind: "error", error: { code: "no_such_method", message: call.method } },
      )
    }
    const methods = Object.keys(sdk).filter((key) => typeof sdk[key] === "function").sort()
    return { kind: "ok", runtime, methods, results }
  } finally {
    await sdk.dispose()
  }
}

const reply = await main(process.argv[2] ?? "{}")
process.stdout.write(`${JSON.stringify(reply)}\n`)
