/*
 * One repeatable release gate for the repository.
 *
 * This deliberately runs the same checks locally and in CI. It keeps the
 * expensive live-site smoke test opt-in (`RELEASE_URL=...`) because pointing a
 * local checkout at production should be a conscious operator decision.
 * Authenticated browser coverage is also opt-in through the E2E variables
 * documented in frontend/playwright.config.js.
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const frontend = `${root}/frontend`
const failures = []

function run(label, command, cwd = root) {
  console.log(`\n▶ ${label}`)
  const result = spawnSync(command, { cwd, shell: true, stdio: 'inherit', env: process.env })
  if (result.status !== 0) {
    failures.push(label)
    console.log(`✗ ${label}`)
  } else {
    console.log(`✓ ${label}`)
  }
}

run('Compile backend modules', 'python3 -m compileall -q backend')
run('Run backend tests', 'python3 -m pytest -q backend/test_*.py')
run('Lint backend', 'python3 -m ruff check backend')
run('Run frontend quality checks', 'npm run check', frontend)
run('Run frontend focused and browser tests', 'npm run test:all', frontend)

if (process.env.RELEASE_URL) {
  run('Smoke the live site', `node scripts/smoke_production.mjs "${process.env.RELEASE_URL}"`)
} else {
  console.log('\n↷ Live-site smoke test skipped (set RELEASE_URL to run it).')
}

if (process.env.RELEASE_ENV === 'production') {
  const required = ['DATABASE_URL', 'SESSION_SECRET', 'OPENAI_API_KEY']
  const missing = required.filter((name) => !process.env[name])
  if (missing.length) {
    failures.push('Production environment contract')
    console.log(`✗ Production environment contract (missing: ${missing.join(', ')})`)
  } else {
    console.log('✓ Production environment contract')
  }
} else {
  console.log('↷ Production environment contract skipped (set RELEASE_ENV=production to enforce it).')
}

console.log()
if (failures.length) {
  console.error(`RELEASE BLOCKED — ${failures.length} check(s) failed:`)
  for (const failure of failures) console.error(`  • ${failure}`)
  process.exit(1)
}
console.log('RELEASE READY — all enabled checks passed.')
