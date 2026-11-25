import { describe, expect, test } from "bun:test"
import { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

import { paneContent } from "../src/viewer"
import { RAIL_COLOR, RAIL_INACTIVE, type PaneFrame } from "../src/viewer-model"

const renderPane = async (pane: PaneFrame, width = 24, height = 4) => {
  const setup = await createTestRenderer({ width, height })
  setup.renderer.root.add(new TextRenderable(setup.renderer, { content: paneContent(pane), width, height }))
  await setup.renderOnce()
  return setup
}

const rgb = (value: number): number => Math.round(value * 255)

const RAIL_COLOR_HEX = [
  Number.parseInt(RAIL_COLOR.slice(1, 3), 16),
  Number.parseInt(RAIL_COLOR.slice(3, 5), 16),
  Number.parseInt(RAIL_COLOR.slice(5, 7), 16),
]

describe("paneContent", () => {
  test("#given an image row #when rendered #then its block cells paint the pixel colors", async () => {
    const pane: PaneFrame = {
      lines: ["plain", "▀▀"],
      hits: [undefined, undefined],
      cells: [
        undefined,
        [
          { text: "▀", fg: "#ff0000", bg: "#0000ff" },
          { text: "▀", fg: "#ff0000", bg: "#0000ff" },
        ],
      ],
    }
    const setup = await renderPane(pane)
    try {
      const blocks = (setup.captureSpans().lines[1]?.spans ?? []).find((span) => span.text.includes("▀"))
      expect(blocks?.text).toBe("▀▀")
      expect([blocks?.fg.r, blocks?.fg.g, blocks?.fg.b].map((value) => rgb(value ?? 0))).toEqual([255, 0, 0])
      expect([blocks?.bg.r, blocks?.bg.g, blocks?.bg.b].map((value) => rgb(value ?? 0))).toEqual([0, 0, 255])
    } finally {
      await setup.dispose()
    }
  })

  test("#given a rail row #when rendered #then the accent rail and its row color are painted", async () => {
    const pane: PaneFrame = {
      lines: ["assistant: hi"],
      hits: [undefined],
      styles: [{ fg: "#a5d6ff", bg: "#141d33", rail: true }],
    }
    const setup = await renderPane(pane, 20, 2)
    try {
      const spans = setup.captureSpans().lines[0]?.spans ?? []
      const rail = spans[0]
      expect(rail?.text).toBe("  ")
      expect([rail?.bg.r, rail?.bg.g, rail?.bg.b].map((value) => rgb(value ?? 0))).toEqual(RAIL_COLOR_HEX)
      const text = spans.find((span) => span.text.includes("assistant"))
      expect([text?.fg.r, text?.fg.g, text?.fg.b].map((value) => rgb(value ?? 0))).toEqual([0xa5, 0xd6, 0xff])
    } finally {
      await setup.dispose()
    }
  })

  test("#given a railColor override #when rendered #then the rail uses that color", async () => {
    const pane: PaneFrame = {
      lines: ["x"],
      hits: [undefined],
      styles: [{ rail: true, railColor: RAIL_INACTIVE }],
    }
    const setup = await renderPane(pane, 10, 2)
    try {
      const rail = setup.captureSpans().lines[0]?.spans[0]
      expect(rail?.text).toBe("  ")
      expect([rail?.bg.r, rail?.bg.g, rail?.bg.b].map((value) => rgb(value ?? 0))).toEqual([
        Number.parseInt(RAIL_INACTIVE.slice(1, 3), 16),
        Number.parseInt(RAIL_INACTIVE.slice(3, 5), 16),
        Number.parseInt(RAIL_INACTIVE.slice(5, 7), 16),
      ])
    } finally {
      await setup.dispose()
    }
  })
})
