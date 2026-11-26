import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { isRecord, requiredString } from "../../lib/api-model-primitives"
import type { createApiClient } from "../../lib/api-client"
import type { TranscriptImage, TranscriptTurn } from "./model"

type TranscriptApi = Pick<ReturnType<typeof createApiClient>, "getTurnBody" | "getDocumentImage">

type TurnDetailProps = {
  readonly api: TranscriptApi
  readonly docId: string
  readonly turn: TranscriptTurn
}

function parseBody(value: unknown): { readonly lines: readonly string[]; readonly images: readonly TranscriptImage[] } {
  if (!isRecord(value) || !Array.isArray(value["lines"]) || !Array.isArray(value["images"])) {
    throw new TypeError("Turn detail response is invalid")
  }
  if (!value["lines"].every((line) => typeof line === "string")) {
    throw new TypeError("Turn detail lines are invalid")
  }
  return {
    lines: value["lines"],
    images: value["images"].map((image) => {
      if (!isRecord(image)) throw new TypeError("Turn detail image is invalid")
      return { sha256: requiredString(image, "sha256"), mimeType: requiredString(image, "mimeType") }
    }),
  }
}

function ImagePreview({ api, docId, image }: { readonly api: TranscriptApi; readonly docId: string; readonly image: TranscriptImage }) {
  const preview = useQuery({
    queryKey: ["document-image", docId, image.sha256],
    queryFn: () => api.getDocumentImage(docId, image.sha256),
    staleTime: Infinity,
  })
  const [url, setUrl] = useState<string | null>(null)
  const [size, setSize] = useState<{ readonly width: number; readonly height: number } | null>(null)

  useEffect(() => {
    if (preview.data === undefined) return
    const objectUrl = URL.createObjectURL(preview.data)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [preview.data])

  return (
    <figure className="transcript-image">
      {url !== null && (
        <img
          src={url}
          alt={`Image read by tool, ${image.mimeType}`}
          onLoad={(event) => setSize({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          })}
        />
      )}
      <figcaption>IMAGE {size === null ? "size loading" : `${size.width}×${size.height}`} {image.mimeType}</figcaption>
    </figure>
  )
}

export function TurnDetail({ api, docId, turn }: TurnDetailProps) {
  const body = useQuery({
    queryKey: ["turn-body", docId, turn.id],
    queryFn: async () => parseBody(await api.getTurnBody(docId, turn.id)),
  })
  if (body.isPending) return <p role="status">Loading turn detail…</p>
  if (body.error !== null) return <p role="alert">Turn detail unavailable: {body.error.message}</p>
  return (
    <div className="transcript-turn__detail">
      <h3>Turn detail</h3>
      <pre>{body.data.lines.join("\n")}</pre>
      {body.data.images.slice(0, 3).map((image) => (
        <ImagePreview key={image.sha256} api={api} docId={docId} image={image} />
      ))}
    </div>
  )
}
