import { useEffect, useState } from 'react'

/* navigator.onLine plus the two events that keep it current. Not a network
 * probe — it only reflects whether the OS thinks it has a link at all (wifi
 * associated, cellular attached), so a captive portal or a dead upstream
 * still reads "online". That's the right scope here: it's for telling a
 * teacher "your device has no connection right now" versus a genuine server
 * error, not for diagnosing why a request failed once a link exists.
 */
export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))

  useEffect(() => {
    const goOnline = () => setIsOnline(true)
    const goOffline = () => setIsOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  return isOnline
}
