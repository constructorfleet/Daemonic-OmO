import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createApiClient } from "../../lib/api"
import type { ProjectTaskDocument } from "../../lib/project-activity-model"
import { projectTaskDocumentQueryKey } from "../../lib/project-task-stream"
import { PROJECTS_QUERY_KEY, createStreamStore } from "../../lib/stream"
import type { ProjectTaskItem } from "../../lib/project-activity-model"
import { identifyProjects, transcriptDocumentId } from "./session-model"
import type { SessionFilter } from "./session-tree"
import { applyTranscriptFrame, parseTranscriptState, prependTranscriptPage } from "../transcript/model"
import type { TranscriptState } from "../transcript/model"

const api = createApiClient()

export function useSessionExplorer() {
  const queryClient = useQueryClient()
  const pausedRef = useRef(false)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [viewedId, setViewedId] = useState<string | null>(null)
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null)
  const [expandedTurnId, setExpandedTurnId] = useState<string | null>(null)
  const [hiddenFilters, setHiddenFilters] = useState<readonly SessionFilter[]>([])
  const [hideCompleted, setHideCompleted] = useState(false)
  const [todoVisible, setTodoVisible] = useState(true)
  const [paused, setPaused] = useState(false)
  const [followLatest, setFollowLatest] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [readBudget, setReadBudget] = useState(4_194_304)
  const [actionError, setActionError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<TranscriptState | null>(null)
  const transcriptRef = useRef<TranscriptState | null>(null)
  pausedRef.current = paused
  transcriptRef.current = transcript

  const stream = useMemo(() => createStreamStore({
    queryClient,
    api,
    documentPaused: () => pausedRef.current,
  }), [queryClient])
  const projects = useQuery({
    queryKey: [...PROJECTS_QUERY_KEY, "sessions"],
    queryFn: async () => {
      const identity = await api.me()
      const result = await api.listProjects(true, identity.role === "admin" ? identity.user.id : undefined)
      return {
        ...result,
        projects: await identifyProjects(result.items),
        ...(identity.user.settings?.readBytes === undefined ? {} : { defaultReadBytes: identity.user.settings.readBytes }),
      }
    },
    staleTime: Infinity,
  })
  const selectedProject = projects.data?.projects.find((project) => project.id === projectId)
  const taskDocId = selectedProject === undefined ? null : `project:${selectedProject.id}:tasks`
  const taskDocument = useQuery({
    queryKey: taskDocId === null ? ["docs", "sessions-empty"] : projectTaskDocumentQueryKey(taskDocId),
    queryFn: async () => {
      if (selectedProject === undefined) throw new TypeError("No project is selected")
      return api.getProjectTaskDocument(selectedProject.id)
    },
    enabled: selectedProject !== undefined,
    staleTime: 0,
  })
  const items = taskDocument.data?.snapshot.items ?? []
  const selectedItem = items.find((item) => item.id === selectedId) ?? null
  const viewedItem = items.find((item) => item.id === viewedId) ?? selectedItem
  const transcriptId = selectedProject === undefined || viewedItem === null
    ? null
    : transcriptDocumentId(selectedProject.id, viewedItem, taskDocument.data?.snapshot.agentDirHash)
  const transcriptQuery = useQuery({
    queryKey: ["transcript", transcriptId],
    queryFn: async () => {
      if (transcriptId === null) throw new TypeError("No session or task is selected")
      return parseTranscriptState(await api.getDocument(transcriptId))
    },
    enabled: transcriptId !== null,
    staleTime: Infinity,
  })

  useEffect(() => {
    if (projects.data === undefined) return
    stream.start(projects.data.headSeq)
  }, [projects.data, stream])
  useEffect(() => () => stream.close(), [stream])
  useEffect(() => {
    if (projectId === null && projects.data?.projects[0] !== undefined) setProjectId(projects.data.projects[0].id)
  }, [projectId, projects.data])
  useEffect(() => {
    if (projects.data?.defaultReadBytes !== undefined) setReadBudget(projects.data.defaultReadBytes)
  }, [projects.data?.defaultReadBytes])
  useEffect(() => {
    if (taskDocId === null || taskDocument.data === undefined) return
    void stream.subscribeDoc({ docId: taskDocId, epoch: taskDocument.data.epoch, rev: taskDocument.data.rev })
    return () => { void stream.unsubscribeDoc(taskDocId) }
  }, [stream, taskDocId, taskDocument.data])
  useEffect(() => {
    if (selectedId === null && items.length > 0) {
      const first = items.find((item) => item.kind === "main") ?? items[0]
      if (first !== undefined) {
        setSelectedId(first.id)
        setViewedId(first.id)
      }
    }
  }, [items, selectedId])
  useEffect(() => {
    setTranscript(transcriptQuery.data ?? null)
    setSelectedTurnId(transcriptQuery.data?.snapshot.turns.at(-1)?.id ?? null)
    setExpandedTurnId(null)
  }, [transcriptId, transcriptQuery.data])
  useEffect(() => {
    if (transcriptId === null || transcriptQuery.data === undefined) return
    const unlisten = stream.listenDoc(transcriptId, (frame) => {
      if (pausedRef.current) return
      const current = transcriptRef.current
      if (current === null) return
      const updated = applyTranscriptFrame(current, frame)
      if (updated === null) {
        void api.getDocument(transcriptId)
          .then(parseTranscriptState)
          .then(setTranscript)
          .catch((error: unknown) => setActionError(error instanceof Error ? error.message : "Transcript refresh failed"))
      } else setTranscript(updated)
    })
    void stream.subscribeDoc({ docId: transcriptId, epoch: transcriptQuery.data.epoch, rev: transcriptQuery.data.rev })
    return () => {
      unlisten()
      void stream.unsubscribeDoc(transcriptId)
    }
  }, [stream, transcriptId, transcriptQuery.data])
  useEffect(() => {
    if (selectedId !== null && !items.some((item) => item.id === selectedId)) {
      setSelectedId(items.find((item) => item.kind === "main")?.id ?? null)
      setViewedId(null)
    }
  }, [items, selectedId])

  function selectItem(item: ProjectTaskItem): void {
    setSelectedId(item.id)
    setViewedId(item.id)
    setSelectedTurnId(null)
    setExpandedTurnId(null)
  }

  function toggleFilter(filter: SessionFilter): void {
    setHiddenFilters((current) => current.includes(filter)
      ? current.filter((item) => item !== filter)
      : [...current, filter])
  }

  async function refresh(): Promise<void> {
    if (selectedProject === undefined || taskDocId === null) return
    setActionError(null)
    try {
      const refreshed = await api.getProjectTaskDocument(selectedProject.id)
      queryClient.setQueryData<ProjectTaskDocument>(projectTaskDocumentQueryKey(taskDocId), refreshed)
      if (transcriptId !== null) setTranscript(parseTranscriptState(await api.getDocument(transcriptId)))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Refresh failed")
    }
  }

  async function loadOlder(): Promise<void> {
    const first = transcript?.snapshot.turns[0]
    if (first === undefined || transcript === null) return
    setLoadingOlder(true)
    try {
      const page = await api.getDocument(transcript.docId, { beforeTurn: first.id })
      setTranscript((current) => current === null ? current : prependTranscriptPage(current, page) ?? current)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Older turns could not be loaded")
    } finally {
      setLoadingOlder(false)
    }
  }

  async function updateReadBudget(readBytes: number): Promise<void> {
    setActionError(null)
    try {
      const settings = await api.updateUserSettings({ readBytes })
      setReadBudget(settings.readBytes)
      if (transcriptId !== null) setTranscript(parseTranscriptState(await api.getDocument(transcriptId)))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Read budget could not be saved")
    }
  }

  function togglePause(): void {
    if (paused) void refresh()
    setPaused(!paused)
  }

  function changeProject(nextId: string): void {
    setProjectId(nextId)
    setSelectedId(null)
    setViewedId(null)
  }

  const activeTranscript = transcript?.docId === transcriptId ? transcript : null

  return {
    api,
    projects,
    projectId,
    selectedProject,
    changeProject,
    taskDocument,
    taskDocId,
    items,
    selectedId,
    setSelectedId,
    selectedItem,
    viewedId,
    viewedItem,
    setViewedId,
    selectItem,
    hiddenFilters,
    toggleFilter,
    hideCompleted,
    setHideCompleted,
    todoVisible,
    setTodoVisible,
    paused,
    togglePause,
    followLatest,
    setFollowLatest,
    readBudget,
    updateReadBudget,
    actionError,
    setActionError,
    transcript: activeTranscript,
    setTranscript,
    transcriptId,
    transcriptQuery,
    selectedTurnId,
    setSelectedTurnId,
    expandedTurnId,
    setExpandedTurnId,
    loadingOlder,
    loadOlder,
    refresh,
  }
}
