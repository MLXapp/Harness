#!/usr/bin/env node
// Run the panel's vitest suite and fail only on failures that are not listed
// in tests/known-upstream-failures.json (pre-existing upstream failures).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const panel = resolve(new URL('..', import.meta.url).pathname)
const out = join(mkdtempSync(join(tmpdir(), 'vitest-ci-')), 'report.json')
const run = spawnSync('npx', ['--no-install', 'vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile=${out}`], {
  cwd: panel, stdio: 'inherit',
})
let report
try { report = JSON.parse(readFileSync(out, 'utf8')) } catch {
  console.error('vitest did not write a report'); process.exit(run.status || 1)
}
const known = new Set(JSON.parse(readFileSync(join(panel, 'tests/known-upstream-failures.json'), 'utf8')).failures)
const failed = []
for (const file of report.testResults) {
  const rel = relative(panel, file.name)
  const results = file.assertionResults ?? []
  if (file.status === 'failed' && results.every(a => a.status !== 'failed')) failed.push(`${rel} > (file failed to run) ${file.message ?? ''}`.trim())
  for (const a of results) if (a.status === 'failed') failed.push(`${rel} > ${a.ancestorTitles.join(' ')} ${a.title}`)
}
const unexpected = failed.filter(f => !known.has(f))
const tolerated = failed.filter(f => known.has(f))
if (tolerated.length) console.log(`\nTolerated ${tolerated.length} known upstream failure(s) (tests/known-upstream-failures.json).`)
if (unexpected.length) {
  console.error(`\n${unexpected.length} unexpected failure(s):\n` + unexpected.map(f => '  ' + f).join('\n'))
  process.exit(1)
}
console.log(`Passed: ${report.numPassedTests}, failed: ${report.numFailedTests} (all known).`)
