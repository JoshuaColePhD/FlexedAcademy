/* Google's own Picker widget — the sanctioned way to let a teacher choose a
 * Drive destination folder without this app ever seeing their broader Drive.
 *
 * backend/google_drive.py requests the narrowest OAuth scope Google offers
 * for sharing — drive.file, "the file this app creates, and nothing else
 * already in a teacher's Drive" (see that module's own comment). That's
 * deliberate: it's the least Google requires this app to ask a school
 * Workspace admin to trust. The cost is that this app genuinely CANNOT list
 * a teacher's existing folders on its own — no files.list access to
 * anything it didn't create. Picker is Google's own answer to that gap: it
 * runs as a widget talking directly to Google, and selecting anything
 * through it — a file OR a folder, owned by the teacher or merely shared
 * with them — grants THIS app access to that specific item, without
 * widening the OAuth grant at all. That's what makes "pick the folder my
 * school already shared with me" possible under drive.file in the first
 * place.
 *
 * Loaded lazily (a <script> tag, not an import) because it's Google's own
 * hosted JS, the same reason GoogleOAuthProvider's sign-in button works the
 * way it does — this is a second, unrelated Google script, loaded once and
 * cached on `window`.
 */

let loadPromise = null

function loadGoogleApi() {
  if (loadPromise) return loadPromise
  loadPromise = new Promise((resolve, reject) => {
    if (window.google?.picker) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.src = 'https://apis.google.com/js/api.js'
    script.async = true
    script.defer = true
    script.onload = () => {
      window.gapi.load('picker', { callback: resolve, onerror: reject })
    }
    script.onerror = () => reject(new Error('Could not load Google’s picker script.'))
    document.head.appendChild(script)
  })
  return loadPromise
}

/**
 * Opens Google's folder picker and resolves to `{ id, name }` for whatever
 * the teacher chose, or `null` if they closed it without choosing.
 *
 * Two views, not one: a bare `DocsView(FOLDERS)` only shows folders the
 * teacher OWNS — exactly the case that doesn't cover "the folder my school
 * shared with me," which is the whole point of this feature (see this
 * module's own top comment). `setOwnedByMe(false)` is Picker's documented
 * way to surface the "Shared with me" side instead.
 */
export function pickDriveFolder({ accessToken, apiKey }) {
  return loadGoogleApi().then(
    () =>
      new Promise((resolve) => {
        const myFolders = new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
          .setSelectFolderEnabled(true)
          .setIncludeFolders(true)

        const sharedFolders = new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
          .setSelectFolderEnabled(true)
          .setIncludeFolders(true)
          .setOwnedByMe(false)
          .setLabel('Shared with me')

        const picker = new window.google.picker.PickerBuilder()
          .setOAuthToken(accessToken)
          .setDeveloperKey(apiKey)
          .addView(myFolders)
          .addView(sharedFolders)
          .setTitle('Choose a Drive folder')
          .setCallback((data) => {
            if (data.action === window.google.picker.Action.PICKED) {
              const doc = data.docs?.[0]
              resolve(doc ? { id: doc.id, name: doc.name } : null)
            } else if (data.action === window.google.picker.Action.CANCEL) {
              resolve(null)
            }
          })
          .build()
        picker.setVisible(true)
      })
  )
}
