import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
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
export function useClasses() {
  return useQuery({
    queryKey: qk.classes,
    queryFn: () => api.listClasses(),
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
  const { data: classes = [], isLoading } = useClasses()
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
    // The school year does not change while a teacher is looking at it. This is
    // what stops four surfaces reading the same board from firing four requests.
    staleTime: 5 * 60_000,
  })
}

/** One week out of the board, by number. The week page needs its neighbours for
 *  the ← / → arrows as well, so it reads the same cached year rather than
 *  fetching a week on its own — a second endpoint would be a second truth. */
export function useWeek(classId, weekNo) {
  const q = useCalendar(classId)
  const weeks = q.data?.weeks || []
  const n = Number(weekNo)
  const index = weeks.findIndex((w) => w.week === n)
  return {
    ...q,
    weeks,
    week: index >= 0 ? weeks[index] : null,
    prev: index > 0 ? weeks[index - 1] : null,
    next: index >= 0 && index < weeks.length - 1 ? weeks[index + 1] : null,
    klass: q.data?.class || null,
  }
}

/** Everything that changes a plan has to land here, or the calendar behind it
 *  goes stale and starts lying about which weeks are planned. */
export function useInvalidateCalendar(classId) {
  const qc = useQueryClient()
  return useCallback(
    () => qc.invalidateQueries({ queryKey: qk.calendar(classId) }),
    [qc, classId]
  )
}

/* ── chats ───────────────────────────────────────────────────────────────── */

export function useChats() {
  return useQuery({ queryKey: qk.chats, queryFn: () => api.listChats() })
}

export function useRenameChat() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }) => api.renameChat(id, title),
    // Optimistic, because renaming is a text field the teacher is looking at:
    // a round trip before the label changes reads as the app ignoring them.
    onMutate: async ({ id, title }) => {
      await qc.cancelQueries({ queryKey: qk.chats })
      const prev = qc.getQueryData(qk.chats)
      qc.setQueryData(qk.chats, (rows = []) =>
        rows.map((c) => (c.id === id ? { ...c, title } : c))
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(qk.chats, ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.chats }),
  })
}

export function useDeleteChat() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id) => api.deleteChat(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.chats }),
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
