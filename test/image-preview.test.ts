import { describe, expect, test } from "bun:test"

import { previewImage } from "../src/image-preview"

const redOverBlue =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAE0lEQVR4nGP4z8DwHxkzoPH/AwAHKQ/xs/M1WgAAAABJRU5ErkJggg=="

describe("previewImage", () => {
  test("#given a png #when previewed #then it becomes half-block cells with top and bottom pixel colors", () => {
    const preview = previewImage(redOverBlue, "image/png", 40, 12)
    expect(preview).toBeDefined()
    expect(preview?.sourceWidth).toBe(4)
    expect(preview?.sourceHeight).toBe(2)
    expect(preview?.cellWidth).toBe(4)
    expect(preview?.cellHeight).toBe(1)
    expect(preview?.rows[0]?.map((cell) => cell.text)).toEqual(["▀", "▀", "▀", "▀"])
    expect(preview?.rows[0]?.[0]).toEqual({ text: "▀", fg: "#ff0000", bg: "#0000ff" })
  })

  test("#given a narrow pane #when previewed #then the cells fit the width and keep the aspect ratio", () => {
    const preview = previewImage(redOverBlue, "image/png", 2, 12)
    expect(preview?.cellWidth).toBe(2)
    expect(preview?.cellHeight).toBe(1)
    expect(preview?.rows[0]).toHaveLength(2)
  })

  test("#given undecodable data #when previewed #then it returns nothing instead of throwing", () => {
    expect(previewImage("not-an-image", "image/png", 40, 12)).toBeUndefined()
  })
})
