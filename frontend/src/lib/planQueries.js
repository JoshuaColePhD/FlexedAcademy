import { qk } from './queryKeys'

/** Every view derived from saved plans must advance with the same mutation. */
export function invalidatePlanViews(queryClient, classId) {
  const keys = classId
    ? [qk.planWeeks(classId), qk.calendar(classId), qk.standardsCoverage(classId), qk.curriculumProgress(classId)]
    : [['plan-weeks'], ['calendar'], ['standards', 'coverage'], ['curriculum-progress']]
  return Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
}
