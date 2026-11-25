import { useEffect, useRef, useState } from "react"
import type { FormEvent, KeyboardEvent } from "react"
import { ApiError, createApiClient } from "./api"
import type { Project, ProjectSettingsInput } from "./api"

type ProjectSettingsApi = Pick<ReturnType<typeof createApiClient>, "updateProject">

type ProjectSettingsFormProps = {
  readonly project: Project
  readonly api: ProjectSettingsApi
  readonly onSaved: (project: Project) => void
  readonly onCancel: () => void
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message
  return "Settings could not be saved"
}

export function ProjectSettingsForm({ project, api, onSaved, onCancel }: ProjectSettingsFormProps) {
  const [fullAccessOptIn, setFullAccessOptIn] = useState(project.settings.fullAccessOptIn)
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const fullAccessDialog = useRef<HTMLDivElement>(null)
  const fullAccessCheckbox = useRef<HTMLInputElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const dialogWasOpen = useRef(false)

  useEffect(() => {
    if (confirmFullAccess) {
      dialogWasOpen.current = true
      fullAccessDialog.current?.focus()
    } else if (dialogWasOpen.current) {
      dialogWasOpen.current = false
      fullAccessCheckbox.current?.focus()
    }
  }, [confirmFullAccess])

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault()
      setConfirmFullAccess(false)
      return
    }
    if (event.key !== "Tab") return
    const buttons = fullAccessDialog.current?.querySelectorAll("button")
    if (buttons === undefined || buttons.length === 0) return
    const first = buttons.item(0)
    const last = buttons.item(buttons.length - 1)
    if (first === null || last === null) return
    if (event.shiftKey && (document.activeElement === first || document.activeElement === fullAccessDialog.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    setSaved(false)
    const formData = new FormData(event.currentTarget)
    const maxRunningValue = formData.get("maxRunning")
    const maxRunning = typeof maxRunningValue === "string" ? Number(maxRunningValue) : Number.NaN
    if (!Number.isSafeInteger(maxRunning) || maxRunning < 1) {
      setError("Maximum parallel runs must be a positive whole number")
      return
    }
    const defaultModelValue = formData.get("defaultModel")
    const defaultModel = typeof defaultModelValue === "string" ? defaultModelValue : ""
    const reasoningValue = formData.get("defaultReasoning")
    const defaultReasoning = THINKING_LEVELS.find((level) => level === reasoningValue)
    const worktreeForAdhoc = formData.has("worktreeForAdhoc")
    const settings: ProjectSettingsInput = {
      ...(fullAccessOptIn === project.settings.fullAccessOptIn ? {} : { fullAccessOptIn }),
      ...(maxRunning === project.settings.maxRunning ? {} : { maxRunning }),
      ...(defaultModel === (project.settings.defaultModel ?? "") || defaultModel.length === 0
        ? {}
        : { defaultModel }),
      ...(defaultReasoning === project.settings.defaultReasoning || defaultReasoning === undefined
        ? {}
        : { defaultReasoning }),
      ...(worktreeForAdhoc === project.settings.worktreeForAdhoc ? {} : { worktreeForAdhoc }),
    }
    if (Object.keys(settings).length === 0) {
      onCancel()
      return
    }
    try {
      const updated = await api.updateProject(project.id, { revision: project.revision, settings })
      onSaved(updated)
      setSaved(true)
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <section className="grid gap-6 border-t border-hairline pt-6" aria-labelledby="project-settings-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-2">
          <h2 id="project-settings-title" className="text-[length:var(--font-size-title)] font-semibold text-heading">
            Project settings
          </h2>
          <p className="break-all text-sm text-muted">{project.cwd}</p>
        </div>
        <button
          className="min-h-11 rounded-[var(--radius-control)] border border-control-edge px-4 text-heading hover:bg-selection"
          type="button"
          onClick={onCancel}
        >
          Back to projects
        </button>
      </div>

      <form
        className="grid max-w-2xl gap-6"
        onSubmit={(event) => {
          event.preventDefault()
          void save(event)
        }}
      >
        <label className="grid gap-2 text-sm text-heading">
          Maximum parallel runs
          <input
            className="min-h-11 rounded-[var(--radius-control)] border border-muted bg-panel px-3 text-base text-text"
            type="number"
            min="1"
            step="1"
            required
            name="maxRunning"
            defaultValue={project.settings.maxRunning}
          />
        </label>

        <label className="grid gap-2 text-sm text-heading">
          Default model
          <input
            className="min-h-11 rounded-[var(--radius-control)] border border-muted bg-panel px-3 text-base text-text"
            type="text"
            name="defaultModel"
            defaultValue={project.settings.defaultModel ?? ""}
          />
        </label>

        <label className="grid gap-2 text-sm text-heading">
          Default reasoning
          <select
            className="min-h-11 rounded-[var(--radius-control)] border border-muted bg-panel px-3 text-base text-text"
            name="defaultReasoning"
            defaultValue={project.settings.defaultReasoning ?? ""}
          >
            <option value="">Use user default</option>
            {THINKING_LEVELS.map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
          </select>
        </label>

        <label className="flex min-h-11 items-center gap-3 text-base text-heading">
          <input
            type="checkbox"
            name="worktreeForAdhoc"
            defaultChecked={project.settings.worktreeForAdhoc}
          />
          Use a worktree for ad-hoc runs
        </label>

        <label className="flex min-h-11 items-center gap-3 text-base text-heading">
          <input
            ref={fullAccessCheckbox}
            type="checkbox"
            name="fullAccessOptIn"
            checked={fullAccessOptIn}
            onChange={(event) => {
              if (event.currentTarget.checked) setConfirmFullAccess(true)
              else setFullAccessOptIn(false)
            }}
          />
          Allow full-access loop checks
        </label>

        {confirmFullAccess && (
          <div
            className="fixed inset-0 z-50 grid place-items-center bg-panel/80 p-4"
            role="presentation"
            onKeyDown={handleDialogKeyDown}
          >
            <div
              ref={fullAccessDialog}
              className="grid w-11/12 max-w-lg gap-4 rounded-[var(--radius-surface)] border border-control-edge bg-surface p-5 text-text"
              role="dialog"
              aria-modal="true"
              aria-labelledby="full-access-title"
              tabIndex={-1}
            >
              <h3 id="full-access-title" className="text-lg font-semibold text-heading">Allow loop checks</h3>
              <p className="text-base leading-relaxed text-text">
                Loop check commands run in this project outside the agent permission prompt.
              </p>
              <div className="flex flex-wrap gap-3">
                <button
                  ref={confirmButton}
                  className="min-h-11 rounded-[var(--radius-control)] bg-accent px-4 font-semibold text-panel"
                  type="button"
                  onClick={() => {
                    setFullAccessOptIn(true)
                    setConfirmFullAccess(false)
                  }}
                >
                  Confirm full access
                </button>
                <button
                  className="min-h-11 rounded-[var(--radius-control)] border border-control-edge px-4 text-heading"
                  type="button"
                  onClick={() => setConfirmFullAccess(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {error !== null && <p className="text-sm text-error" role="alert">{error}</p>}
        {saved && <p className="text-sm text-success" role="status">Settings saved</p>}
        <div className="flex flex-wrap gap-3">
          <button
            className="min-h-11 rounded-[var(--radius-control)] bg-accent px-5 font-semibold text-panel disabled:cursor-not-allowed disabled:opacity-60"
            type="submit"
          >
            Save settings
          </button>
        </div>
      </form>
    </section>
  )
}
