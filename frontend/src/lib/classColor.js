/* A colour per prep, so the rail and the artifact stop being one undifferentiated
 * gray list the moment a teacher has more than one class. Deliberately NOT one
 * of the app's meaning-bearing colours (`--accent` is "actionable", `--ok`/
 * `--flag`/`--mark` are status) — these five are decoration with a job:
 * distinguishing preps at a glance, never the only way to tell them apart (the
 * class name is always the text right next to the dot).
 *
 * Assigned by a hash of the class id, not creation order, so a class's colour
 * survives a re-sort and two different teachers don't end up color-coding by
 * coincidence of signup order.
 */

const SWATCHES = [
  { name: 'coral', rgb: '255 122 89' },
  { name: 'rose', rgb: '240 98 146' },
  { name: 'lime', rgb: '184 214 63' },
  { name: 'cyan', rgb: '56 209 224' },
  { name: 'amber', rgb: '255 167 38' },
]

function hash(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0
  }
  return h
}

export function classColor(id) {
  if (!id) return SWATCHES[0]
  return SWATCHES[hash(String(id)) % SWATCHES.length]
}

export function classColorVar(id) {
  return `rgb(${classColor(id).rgb})`
}
