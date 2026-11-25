import { NativeImage } from "@opentui/core"

export interface PreviewCell {
  readonly text: string
  readonly fg?: string
  readonly bg?: string
  readonly bold?: boolean
  readonly dim?: boolean
}

export interface ImagePreview {
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly cellWidth: number
  readonly cellHeight: number
  readonly rows: readonly (readonly PreviewCell[])[]
}

const CACHE_LIMIT = 16
const PANEL_BACKGROUND: readonly [number, number, number] = [0x0b, 0x10, 0x20]
const cache = new Map<string, ImagePreview>()

const hashData: (text: string) => string = (() => {
  const bun = (globalThis as { Bun?: { hash?: (text: string) => bigint } }).Bun
  if (bun?.hash !== undefined) return (text) => bun.hash!(text).toString(36)
  return (text) => {
    let hash = 0x811c9dc5
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(36)
  }
})()

export function previewImage(
  data: string,
  mimeType: string,
  maxWidth: number,
  maxHeight: number,
): ImagePreview | undefined {
  const limitWidth = Math.max(1, Math.floor(maxWidth))
  const limitHeight = Math.max(1, Math.floor(maxHeight))
  const key = `${limitWidth}x${limitHeight}:${mimeType}:${hashData(data)}`
  const cached = cache.get(key)
  if (cached !== undefined) {
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }
  const preview = renderPreview(data, limitWidth, limitHeight)
  if (preview === undefined) return undefined
  cache.set(key, preview)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return preview
}

function renderPreview(data: string, limitWidth: number, limitHeight: number): ImagePreview | undefined {
  let source: NativeImage | undefined
  let scaled: NativeImage | undefined
  try {
    source = NativeImage.decode(Buffer.from(data, "base64"))
    const sourceWidth = source.width
    const sourceHeight = source.height
    if (sourceWidth <= 0 || sourceHeight <= 0) return undefined
    const scale = Math.min(limitWidth / sourceWidth, (limitHeight * 2) / sourceHeight, 1)
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const pixelHeight = Math.max(2, Math.round((sourceHeight * scale) / 2) * 2)
    const image = width === sourceWidth && pixelHeight === sourceHeight
      ? source
      : (scaled = source.resize({ width, height: pixelHeight, kernel: "area" }))
    return {
      sourceWidth,
      sourceHeight,
      cellWidth: width,
      cellHeight: pixelHeight / 2,
      rows: rawToCells(image.raw(), width, pixelHeight),
    }
  } catch {
    return undefined
  } finally {
    scaled?.dispose()
    source?.dispose()
  }
}

function rawToCells(
  raw: { readonly data: Uint8Array; readonly stride: number },
  width: number,
  pixelHeight: number,
): readonly (readonly PreviewCell[])[] {
  const rows: PreviewCell[][] = []
  for (let y = 0; y < pixelHeight / 2; y += 1) {
    const cells: PreviewCell[] = []
    for (let x = 0; x < width; x += 1) {
      const top = composite(raw.data, y * 2 * raw.stride + x * 4)
      const bottom = composite(raw.data, (y * 2 + 1) * raw.stride + x * 4)
      cells.push({ text: "▀", fg: toHex(top), bg: toHex(bottom) })
    }
    rows.push(cells)
  }
  return rows
}

function composite(data: Uint8Array, offset: number): readonly [number, number, number] {
  const alpha = (data[offset + 3] ?? 255) / 255
  return [
    Math.round((data[offset] ?? 0) * alpha + PANEL_BACKGROUND[0] * (1 - alpha)),
    Math.round((data[offset + 1] ?? 0) * alpha + PANEL_BACKGROUND[1] * (1 - alpha)),
    Math.round((data[offset + 2] ?? 0) * alpha + PANEL_BACKGROUND[2] * (1 - alpha)),
  ]
}

function toHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`
}
