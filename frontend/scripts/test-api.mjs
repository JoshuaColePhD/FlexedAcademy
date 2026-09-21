import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/lib/api.js', import.meta.url), 'utf8').replace("import.meta.env.VITE_API_URL", "''")
const { request, toError, apiErrorFromBody } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const originalFetch = globalThis.fetch
try {
  const proxyError = await toError(new Response('Unavailable', { status: 503, headers: { 'Retry-After': '8' } }))
  assert.equal(proxyError.extra.retryable, true)
  assert.equal(proxyError.extra.retry_after_seconds, 8)
  assert.equal(apiErrorFromBody(null, 403).extra.retryable, false)
  assert.equal(apiErrorFromBody({ error: { code: 'provider_quota_exceeded', message: 'Account limit', retryable: false } }, 429).extra.retryable, false)
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    return attempts < 3 ? new Response('temporarily unavailable', { status: 503 }) : new Response('{"ok":true}')
  }
  assert.deepEqual(await request('/temporary'), { ok: true })
  assert.equal(attempts, 3, 'safe gateway failures retry a bounded number of times')

  attempts = 0
  globalThis.fetch = async () => { attempts += 1; throw new TypeError('network error') }
  await assert.rejects(request('/write', { method: 'POST', body: {} }), { code: 'network_error' })
  assert.equal(attempts, 1, 'writes never retry implicitly')

  attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    return new Response('{"error":{"code":"not_found","message":"No record"}}', { status: 404 })
  }
  await assert.rejects(request('/missing'), { code: 'not_found', status: 404 })
  assert.equal(attempts, 1, 'permanent errors do not retry')

  globalThis.fetch = async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"pending":'))
      signal.addEventListener('abort', () => controller.error(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true })
    },
  }))
  await assert.rejects(request('/stalled-body', { timeoutMs: 25 }), { code: 'timeout' }, 'deadline must cover body consumption')

  attempts = 0
  const controller = new AbortController()
  globalThis.fetch = async () => { attempts += 1; return new Response('', { status: 503 }) }
  const pending = request('/cancel-backoff', { signal: controller.signal })
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(attempts, 1, 'navigation cancellation also stops backoff')
} finally {
  globalThis.fetch = originalFetch
}
console.log('API retry, deadline, and cancellation tests passed')
