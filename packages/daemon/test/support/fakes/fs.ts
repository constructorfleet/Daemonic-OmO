import {
  mkdir as fsMkdir,
  mkdtemp,
  open as fsOpen,
  readdir as fsReaddir,
  rm,
  stat as fsStat,
  writeFile as fsWriteFile,
} from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { tmpdir } from "node:os"
import {
  FsError,
  type DirEntry,
  type FileHandle,
  type FileKind,
  type FileStat,
  type Fs,
  type WatchStamp,
} from "../../../src/core/ports"

export class FakeFs implements Fs {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  static async create(prefix = "omo-daemonic-fs-"): Promise<FakeFs> {
    return new FakeFs(await mkdtemp(join(tmpdir(), prefix)))
  }

  resolve(path: string): string {
    return isAbsolute(path) ? path : join(this.root, path)
  }

  async write(path: string, content: string | Uint8Array): Promise<string> {
    const target = this.resolve(path)
    await fsWriteFile(target, content)
    return target
  }

  async mkdir(path: string): Promise<string> {
    const target = this.resolve(path)
    await fsMkdir(target, { recursive: true })
    return target
  }

  async readFileRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    const target = this.resolve(path)
    const handle = await this.open(target)
    try {
      const buffer = new Uint8Array(Math.max(0, length))
      const bytesRead = await handle.read(buffer, 0, buffer.length, Math.max(0, offset))
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  async stat(path: string): Promise<FileStat> {
    const target = this.resolve(path)
    try {
      const info = await fsStat(target)
      return {
        path: target,
        size: info.size,
        mtimeMs: info.mtimeMs,
        kind: kindOf(info.isFile(), info.isDirectory()),
      }
    } catch (error) {
      throw mapError(target, error)
    }
  }

  async readdir(path: string): Promise<readonly DirEntry[]> {
    const target = this.resolve(path)
    try {
      const entries = await fsReaddir(target, { withFileTypes: true })
      return entries.map((entry) => ({
        name: entry.name,
        kind: kindOf(entry.isFile(), entry.isDirectory()),
      }))
    } catch (error) {
      throw mapError(target, error)
    }
  }

  async open(path: string): Promise<FileHandle> {
    const target = this.resolve(path)
    try {
      const handle = await fsOpen(target, "r")
      return {
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position).then((result) => result.bytesRead),
        close: async () => {
          await handle.close()
        },
      }
    } catch (error) {
      throw mapError(target, error)
    }
  }

  async watchHint(path: string): Promise<WatchStamp | null> {
    const target = this.resolve(path)
    try {
      const info = await fsStat(target)
      return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs }
    } catch (error) {
      const mapped = mapError(target, error)
      if (mapped.code === "not_found") return null
      throw mapped
    }
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true })
  }
}

function kindOf(isFile: boolean, isDirectory: boolean): FileKind {
  if (isFile) return "file"
  if (isDirectory) return "directory"
  return "other"
}

function mapError(path: string, error: unknown): FsError {
  if (error instanceof FsError) return error
  const code = errorCode(error)
  if (code === "ENOENT") return new FsError(path, "not_found", { cause: error })
  if (code === "EACCES" || code === "EPERM") {
    return new FsError(path, "permission_denied", { cause: error })
  }
  return new FsError(path, "io", { cause: error })
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code
    if (typeof code === "string") return code
  }
  return null
}
