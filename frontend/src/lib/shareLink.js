import { api } from './api'

/* "Copy link" for a plan, in one place because four buttons do it.
 *
 * Publishing has to happen BEFORE the link is handed over, and that is the
 * whole reason this function exists rather than four inline
 * navigator.clipboard.writeText calls. Those four copied
 * `${origin}/shared/${planId}` and nothing else — no request, no record that
 * the teacher had chosen to share anything — while the endpoint behind that URL
 * served any plan in the database to anyone holding its id, signed in or not.
 * Confirmed against the live database before this was written: HTTP 200 and a
 * full plan body with no cookie at all.
 *
 * So the model is now a capability URL that has to be granted: the POST marks
 * the plan public (backend migration 39, default false), and only then is a
 * usable link put on the clipboard. Turning it back off — api.setPlanPublic(id,
 * false) — kills every copy of the link that is already out there, which is the
 * other thing the old version could never do.
 *
 * The clipboard write is deliberately AFTER the await. Copying first would hand
 * a teacher a link they believe works while the request that makes it work is
 * still in flight, or has failed.
 */
export async function copyPlanShareLink(planId, toast) {
  if (!planId) return false
  const url = `${window.location.origin}/shared/${planId}`
  try {
    await api.setPlanPublic(planId, true)
  } catch (err) {
    toast?.apiError?.('Could not create a share link', err)
    return false
  }
  try {
    await navigator.clipboard.writeText(url)
    toast?.success?.(
      'Share link copied',
      'Anyone with this link can read the plan and copy it. Turn it off any time from Share.'
    )
  } catch {
    /* Clipboard access can be refused (an insecure origin, a permissions
       policy, Safari outside a user gesture). The plan IS shared at this point,
       so failing silently would be the worst outcome — show the URL instead so
       it can be copied by hand. */
    toast?.success?.('Share link ready', url)
  }
  return true
}

/** Revokes the link. Every copy of it stops working immediately. */
export async function stopSharingPlan(planId, toast) {
  try {
    await api.setPlanPublic(planId, false)
    toast?.success?.('Sharing turned off', 'That link no longer opens this plan.')
    return true
  } catch (err) {
    toast?.apiError?.('Could not turn sharing off', err)
    return false
  }
}
