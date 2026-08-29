import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { useToast } from '../lib/toastContext'

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
  /* ONE request and ONE cache entry, whichever variant the caller wants.
     This used to key on `{ includeArchived }`, so useClasses(false) and
     useClasses(true) were two entries and two round trips for what is the
     same eleven-row list — and four other call sites bypassed this hook
     entirely with a bare qk.classes useQuery, making a THIRD entry with no
     staleTime that refetched on every mount. Measured: /api/classes four
     times on a single page load.

     Fetching the full list (archived included) and narrowing per-observer
     with `select` is what collapses that: react-query runs select downstream
     of the shared cache entry, so each caller gets its own view without its
     own request. Filtering client-side is free at this size — and the
     `archived` flag is on the row already, which is how ClassPage has always
     split these two lists locally. */
  const select = useCallback(
    (rows) => {
      const list = Array.isArray(rows) ? rows : []
      return includeArchived ? list : list.filter((c) => !c.archived)
    },
    [includeArchived]
  )
  return useQuery({
    queryKey: qk.classes,
    queryFn: ({ signal }) => api.listClasses({ include_archived: true, signal }),
    select,
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
    queryFn: ({ signal }) => api.getWeeks(classId, { signal }),
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
    queryFn: ({ signal }) => api.listChats({ classId, signal }),
    enabled: Boolean(classId),
  })
}

export function useRenameChat() {
  const qc = useQueryClient()
  const toast = useToast()
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
    /* Toasts here, not at the call sites. An optimistic rename that fails
       ROLLS BACK — the title silently snaps to the old one — so without this
       the teacher sees their edit undo itself with no explanation. HistoryPage
       swallowed the error assuming this hook reported it ("toast will be
       handled by mutation if needed"); it didn't. Centralized so a future
       caller can't reintroduce the same silent failure. */
    onError: (err, _v, ctx) => {
      ctx?.prev?.forEach(([key, data]) => qc.setQueryData(key, data))
      toast.apiError('Could not rename that chat', err)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['chats'] }),
  })
}

/* Same optimistic shape as useRenameChat above, for the same reason — and it
   matters more here, because pinning is the highest-frequency control in the
   sidebar. It used to live inline in AppShell as an await-then-refetch: two
   serialized round trips (PATCH, then a full GET /api/chats) during which the
   pin icon didn't change colour and the row didn't move between the Pinned and
   Recent sections. Flipping the flag locally does both instantly, since those
   two lists are just filters over this same cached array. */
export function useTogglePin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, pinned }) => api.togglePin(id, pinned),
    onMutate: async ({ id, pinned }) => {
      await qc.cancelQueries({ queryKey: ['chats'] })
      const prev = qc.getQueriesData({ queryKey: ['chats'] })
      qc.setQueriesData({ queryKey: ['chats'] }, (rows) =>
        Array.isArray(rows) ? rows.map((c) => (c.id === id ? { ...c, is_pinned: pinned } : c)) : rows
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
    /* Optimistic too: the row used to sit there unchanged for a round trip
       plus an invalidate-driven refetch after the confirm dialog had already
       closed, which reads as the delete not having registered. Removing it
       from the cached list immediately is safe because onError puts the whole
       list back — the same rollback the two mutations above rely on. */
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['chats'] })
      const prev = qc.getQueriesData({ queryKey: ['chats'] })
      qc.setQueriesData({ queryKey: ['chats'] }, (rows) =>
        Array.isArray(rows) ? rows.filter((c) => c.id !== id) : rows
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => ctx?.prev?.forEach(([key, data]) => qc.setQueryData(key, data)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['chats'] }),
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
