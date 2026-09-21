import { api } from './api'

// Closed events only. No plan IDs, prompts, filenames, or student information.
export function recordActivation(name) {
  void api.recordOnboardingEvents([{ name, props: {} }]).catch(() => {})
}
