import { browserTracingIntegration, init } from '@sentry/react'
export { captureMessage, addBreadcrumb } from '@sentry/react'

/** Load configured performance reporting without blocking the route shell. */
export function initMonitoring() {
  init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    // BrowserTracing records real LCP, CLS and INP alongside sampled page and
    // navigation timings. Keep route names stable across individual classes.
    integrations: [browserTracingIntegration({
      enableInp: true,
      beforeStartSpan: (options) => ({
        ...options,
        name: options.name.split(/[?#]/)[0]
          .replace(/\/c\/[^/]+/, '/c/:classId')
          .replace(/\/chat\/[^/]+/, '/chat/:chatId')
          .replace(/\/shared\/[^/]+/, '/shared/:shareId'),
      }),
    })],
    tracesSampleRate: 0.1,
    tracePropagationTargets: [/^\/api(?:\/|$)/],
    sendDefaultPii: false,
  })
}
