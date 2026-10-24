import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT = new URL('./check-submission.mjs', import.meta.url)
const REPO = 'fixture/plugin'
const BUNDLE = { name: 'fixture-plugin', dsh: { bundle: { patch: './cordis.patch.yml' } } }
const CLIENT = { name: 'fixture-client', dsh: { client: { platform: 'web' } } }
const content = (pkg) => ({ content: Buffer.from(JSON.stringify(pkg)).toString('base64') })

// Exercise the CLI and its JSON result, not a copy of hasBundle(). All HTTP
// requests are intercepted in this child; an unexpected route fails the test.
function check({ sub, direct, manifests = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-submission-manifest-'))
  const entries = join(dir, 'entries')
  mkdirSync(entries)
  const url = `https://github.com/${REPO}${sub ? `/tree/main/${sub}` : ''}`
  const file = `fixture__plugin${sub ? `--${sub.replaceAll('/', '-')}` : ''}.yml`
  writeFileSync(join(entries, file), [
    `url: ${url}`, `name: fixture/plugin${sub ? '#target' : ''}`, 'category: tools',
    'description:', '  en: Fixture plugin.', '',
  ].join('\n'))
  const routes = {
    [`repos/${REPO}`]: { status: 200, body: { created_at: '2020-01-01T00:00:00Z', archived: false, default_branch: 'main' } },
    [`repos/${REPO}/git/trees/HEAD?recursive=1`]: { status: 200, body: { truncated: false, tree: Object.keys(manifests).map(path => ({ path })) } },
    ...Object.fromEntries(Object.entries(manifests).map(([path, response]) => [`repos/${REPO}/contents/${path}`, response])),
    [`repos/${REPO}/contents/${sub ? `${sub}/` : ''}package.json`]: direct,
  }
  const trace = join(dir, 'requests.json')
  const preload = join(dir, 'fetch.mjs')
  writeFileSync(preload, `
    import { writeFileSync } from 'node:fs'
    const routes = ${JSON.stringify(routes)}
    const requests = [], unexpected = []
    globalThis.fetch = async (url) => {
      const path = String(url).replace('https://api.github.com/', '')
      requests.push(path)
      const response = routes[path]
      if (!response) { unexpected.push(path); throw new Error('Unexpected fixture route') }
      return new Response(JSON.stringify(response.body ?? { message: 'Fixture API failure' }), { status: response.status })
    }
    process.on('exit', () => writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ requests, unexpected })))
  `)
  const output = join(dir, 'result.json')
  const run = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(SCRIPT), '--all', '--dir', entries, '--json', output], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { ...process.env, GITHUB_TOKEN: 'fixture-not-a-real-credential' },
  })
  assert.equal(run.error, undefined, run.error?.message)
  const calls = JSON.parse(readFileSync(trace, 'utf8'))
  assert.deepEqual(calls.unexpected, [], run.stderr)
  const result = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(result.checked, 1)
  return { ...run, result, requests: calls.requests }
}

function assertIncomplete(run, status) {
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(run.result.failures, [])
  assert.equal(run.result.incomplete.length, 1)
  assert.match(run.result.incomplete[0].unverified.join('\n'), new RegExp(`HTTP ${status}`))
}

for (const status of [403, 429, 500]) {
  test(`an unreadable root manifest (HTTP ${status}) is unverified, not a missing bundle`, () => {
    const run = check({ direct: { status }, manifests: { 'package.json': { status } } })
    assertIncomplete(run, status)
  })
}

test('an unreadable subpackage must not suggest installing a different bundle', () => {
  const run = check({ sub: 'packages/target', direct: { status: 503 }, manifests: { 'packages/other/package.json': { status: 200, body: content(BUNDLE) } } })
  assertIncomplete(run, 503)
  assert.equal(run.requests.some(path => path.includes('packages/other')), false)
})

test('a client-only manifest does not establish absence when another manifest was unreadable', () => {
  const run = check({ direct: { status: 404 }, manifests: {
    'packages/client/package.json': { status: 200, body: content(CLIENT) },
    'packages/unknown/package.json': { status: 500 },
  } })
  assertIncomplete(run, 500)
})

test('a verified root bundle still passes', () => {
  const run = check({ direct: { status: 200, body: content(BUNDLE) } })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(run.result.failures, [])
  assert.deepEqual(run.result.incomplete, [])
})

test('a fully read client-only repository still fails', () => {
  const run = check({ direct: { status: 200, body: content(CLIENT) }, manifests: { 'package.json': { status: 200, body: content(CLIENT) } } })
  assert.equal(run.status, 1)
  assert.match(run.result.failures[0].problems.join('\n'), /declares only `dsh.client`/)
  assert.deepEqual(run.result.incomplete, [])
})

test('invalid JSON remains a submission failure', () => {
  const run = check({ direct: { status: 200, body: { content: Buffer.from('{bad').toString('base64') } } })
  assert.equal(run.status, 1)
  assert.match(run.result.failures[0].problems.join('\n'), /is not valid JSON/)
  assert.deepEqual(run.result.incomplete, [])
})

test('an observed bundle still gives the known root-to-subpackage correction', () => {
  const run = check({ direct: { status: 404 }, manifests: {
    'packages/unknown/package.json': { status: 500 },
    'packages/plugin/package.json': { status: 200, body: content(BUNDLE) },
  } })
  assert.equal(run.status, 1)
  assert.match(run.result.failures[0].problems.join('\n'), /tree\/main\/packages\/plugin/)
  assert.deepEqual(run.result.incomplete, [])
})
