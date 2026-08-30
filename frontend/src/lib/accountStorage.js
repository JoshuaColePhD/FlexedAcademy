/* Browser storage helper for account-owned state.

   localStorage is shared by every account that uses the same browser profile.
   Values that describe a teacher's workspace therefore need the account id in
   their key; otherwise signing out and signing into a second account can make
   the first account's draft or class selection appear under the second one.
*/
export function accountStorageKey(namespace, accountId, key = '') {
  if (!accountId) return null
  const encodedAccount = encodeURIComponent(String(accountId))
  return `${namespace}:${encodedAccount}${key ? `:${key}` : ''}`
}

export function readAccountStorage(namespace, accountId, key = '') {
  const storageKey = accountStorageKey(namespace, accountId, key)
  if (!storageKey) return null
  try {
    return localStorage.getItem(storageKey)
  } catch {
    return null
  }
}

export function writeAccountStorage(namespace, accountId, key, value) {
  const storageKey = accountStorageKey(namespace, accountId, key)
  if (!storageKey) return false
  try {
    localStorage.setItem(storageKey, value)
    return true
  } catch {
    return false
  }
}

export function removeAccountStorage(namespace, accountId, key = '') {
  const storageKey = accountStorageKey(namespace, accountId, key)
  if (!storageKey) return false
  try {
    localStorage.removeItem(storageKey)
    return true
  } catch {
    return false
  }
}

export function sessionStorageKey(namespace, accountId, key = '') {
  if (!accountId) return null
  const encodedAccount = encodeURIComponent(String(accountId))
  return `${namespace}:${encodedAccount}${key ? `:${key}` : ''}`
}
