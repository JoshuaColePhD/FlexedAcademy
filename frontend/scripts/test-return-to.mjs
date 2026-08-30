import assert from 'node:assert/strict'
import { safeReturnTo, withReturnTo } from '../src/lib/returnTo.js'

assert.equal(safeReturnTo('/shared/plan1'), '/shared/plan1')
assert.equal(safeReturnTo('/c/c1?week=4'), '/c/c1?week=4')
assert.equal(safeReturnTo('https://example.com'), null)
assert.equal(safeReturnTo('//example.com'), null)
assert.equal(withReturnTo('/login', '/shared/plan1'), '/login?next=%2Fshared%2Fplan1')
assert.equal(withReturnTo('/login', 'https://example.com'), '/login')

console.log('return-to tests passed')
