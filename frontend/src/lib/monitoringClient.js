let loading

function loadMonitoring() {
  if (!import.meta.env.VITE_SENTRY_DSN) return Promise.resolve(null)
  loading ||= import('./monitoring').then((module) => {
    module.initMonitoring()
    return module
  }).catch(() => null) // Reporting must never block the workspace.
  return loading
}

export function startMonitoring() {
  void loadMonitoring()
}

export function captureMessage(...args) {
  void loadMonitoring().then((module) => module?.captureMessage(...args)).catch(() => {})
}

export function addBreadcrumb(...args) {
  void loadMonitoring().then((module) => module?.addBreadcrumb(...args)).catch(() => {})
}
