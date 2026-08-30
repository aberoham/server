import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const script = path.join(root, 'docker', 'write-config.js')
const tmpDirs = []
let dir

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-docker-config-'))
  tmpDirs.push(dir)
})

after(() => {
  for (const tmp of tmpDirs) fs.rmSync(tmp, { recursive: true, force: true })
})

describe('docker bootstrap config', () => {
  it('writes a configured remote HTTP API', () => {
    const result = runWriter({
      NICTOOL_API_HOST: 'api-internal',
      NICTOOL_API_PORT: '3010',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readConfig(), {
      configured: true,
      api: {
        mode: 'remote',
        scheme: 'http',
        host: 'api-internal',
        port: 3010,
      },
    })
  })

  it('does not replace an existing operator config', () => {
    const file = path.join(dir, 'etc', 'nictool.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{"configured":false}\n')

    const result = runWriter({ NICTOOL_API_HOST: 'other-api' })

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readConfig(), { configured: false })
  })

  it('rejects invalid ports and schemes', () => {
    let result = runWriter({ NICTOOL_API_PORT: 'not-a-port' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /NICTOOL_API_PORT/)

    result = runWriter({ NICTOOL_API_SCHEME: 'file' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /NICTOOL_API_SCHEME/)
  })
})

function runWriter(extraEnv) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NICTOOL_CONFIG_DIR: dir,
      ...extraEnv,
    },
  })
}

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(dir, 'etc', 'nictool.json'), 'utf8'))
}
