import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'

/* The data layer that replaced the Shell god object.
 *
 * Shell() held chats, classes, settings, the active class and the current chat
 * id, then prop-drilled a 15-key object into every page. Everything in it was
 * one of two things: a question about what the server says (now a query below)
 * or a question about what the teacher is looking at (now the URL). Nothing was
 * left over, which is why there is no store here.
 */

/* ── classes ─────────────────────────────────────────────────────────────── */

/** Best-effort by design: /api/classes 404s on an install that hasn't run
 *  migration 9, and the app still has to work — the calendar just shows the
 *  year with no class attached. An error here is not worth a toast. */
export function useClasses(includeArchived = false) {
  return useQuery({
    queryKey: [...qk.classes, { includeArchived }],
    queryFn: () => api.listClasses({ include_archived: includeArchived }),
    select: (rows) => (Array.isArray(rows) ? rows : []),
    retry: false,
    // No placeholderData: [] here. A placeholder resolves the query
    // IMMEDIATELY as an empty success, so RootRedirect saw "zero classes"
    // before the request came back and bounced an existing teacher to
    // /welcome on every cold load.
    staleTime: 60_000,
  })
}

/** The class the URL is pointing at.
 *
 *  `activeClassId` used to live in localStorage and be written by two different
 *  controls (the sidebar switcher and a radio button on My Class), which is a
 *  hidden global with two writers — the definition of a duplicate pathway. It
 *  is a route param now, so there is exactly one way to change it and the back
 *  button works. */
export function useActiveClass() {
  const { classId } = useParams()
  const { data: classes = [], isLoading } = useClasses(true) // Fetch all classes so direct links to archived classes still work
  return {
    classId,
    classes,
    isLoading,
    activeClass: classes.find((c) => c.id === classId) || null,
  }
}

/* ── the year ────────────────────────────────────────────────────────────── */

export function useCalendar(classId) {
  return useQuery({
    queryKey: qk.calendar(classId),
    queryFn: () => api.getWeeks(classId),
    enabled: Boolean(classId),
    // The school year does not change while a teacher is looking at it. This is
    // what stops four surfaces reading the same board from firing four requests.
    staleTime: 5 * 60_000,
  })
}

/* ── chats ───────────────────────────────────────────────────────────────── */

export function useChats() {
  const { classId } = useParams()
  return useQuery({
    queryKey: qk.chats(classId),
    queryFn: () => api.listChats({ classId }),
    enabled: Boolean(classId),
  })
}

export function useRenameChat() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }) => api.renameChat(id, title),
    // Optimistic, because renaming is a text field the teacher is looking at:
    // a round trip before the label changes reads as the app ignoring them.
    onMutate: async ({ id, title }) => {
      await qc.cancelQueries({ queryKey: ['chats'] })
      const prev = qc.getQueriesData({ queryKey: ['chats'] })
      // Every cached class list, since only one of them holds this chat.
      qc.setQueriesData({ queryKey: ['chats'] }, (rows) =>
        Array.isArray(rows) ? rows.map((c) => (c.id === id ? { ...c, title } : c)) : rows
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => ctx?.prev?.forEach(([key, data]) => qc.setQueryData(key, data)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['chats'] }),
  })
}

export function useDeleteChat() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id) => api.deleteChat(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chats'] }),
  })
}

/* ── plans ───────────────────────────────────────────────────────────────── */

/** The Library's own view: one card per calendar week (latest plan, older
 *  revisions folded in) instead of a flat, ungrouped generation history. */
export function usePlanWeeks() {
  const { classId } = useParams()
  return useQuery({
    queryKey: qk.planWeeks(classId),
    queryFn: () => api.listPlanWeeks(classId),
    enabled: Boolean(classId),
  })
}

export function useDeletePlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id) => api.deletePlan(id),
    // Deleting a plan can turn a week's `latest` into its next-newest
    // revision, or just drop a revision — either way the grouped view is
    // stale.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plan-weeks'] }),
  })
}

/* ── settings ────────────────────────────────────────────────────────────── */

/** Largely vestigial since classes landed — kept because the plan builder still
 *  stamps teacher/course/period from it. */
export function useSettings(subject) {
  return useQuery({
    queryKey: qk.settings(subject),
    queryFn: () => api.getSettings(subject ? { subject } : {}),
    staleTime: 5 * 60_000,
  })
}
