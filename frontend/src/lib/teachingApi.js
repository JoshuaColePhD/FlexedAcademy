import { request } from './api'

const root = (planId) => `/api/teaching/plans/${encodeURIComponent(planId)}`
export const teachingApi = {
  workflow: (id, signal) => request(root(id), { signal }),
  saveDay: (id, index, body) => request(`${root(id)}/days/${index}`, { method: 'PUT', body }),
  versions: (id, signal) => request(`${root(id)}/versions`, { signal }),
  restore: (id, revision, expectedRevision) => request(`${root(id)}/versions/${revision}/restore`, { method: 'POST', body: { expected_revision: expectedRevision } }),
  handoff: (id) => request(`${root(id)}/handoff`),
}
