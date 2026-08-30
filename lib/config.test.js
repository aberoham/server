import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, beforeEach, after } from 'node:test'

import {
  apiConfigPath,
  bootstrapPath,
  buildRemoteApiConfig,
  buildRemoteUrl,
  buildStoreConfig,
  normalizeApiMode,
  readBootstrap,
  splitLegacyConfig,
  storeTypeToEnv,
  toJson,
  writeApiConfig,
  writeBootstrap,
} from './config.js'

describe('server bootstrap config', () => {
  const tmpDirs = []
  let dir

  const mkConfigDir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-server-cfg-'))
    tmpDirs.push(d)
    return d
  }

  beforeEach(() => {
    dir = mkConfigDir()
  })

  after(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  })

  describe('normalizeApiMode', () => {
    it(`maps the legacy "local" to in_process`, () => {
      assert.equal(normalizeApiMode('local'), 'in_process')
      assert.equal(normalizeApiMode(undefined), 'in_process')
    })

    it(`passes the current modes through`, () => {
      for (const mode of ['in_process', 'tcp', 'remote']) {
        assert.equal(normalizeApiMode(mode), mode)
      }
    })
  })

  describe('storeTypeToEnv', () => {
    it(`maps the legacy "directory" to toml`, () => {
      assert.equal(storeTypeToEnv('directory'), 'toml')
    })

    it(`defaults to mysql when unset`, () => {
      assert.equal(storeTypeToEnv(undefined), 'mysql')
    })
  })

  describe('buildStoreConfig', () => {
    it(`keeps only connection keys for mysql`, () => {
      const store = buildStoreConfig({
        type: 'mysql',
        host: 'db',
        port: 3306,
        user: 'nt',
        password: 'pw',
        database: 'nictool',
        path: '/should/not/survive',
      })

      assert.equal(store.path, undefined)
      assert.equal(store.host, 'db')
      assert.equal(store.database, 'nictool')
    })

    it(`keeps only the path for a file store`, () => {
      const store = buildStoreConfig({ type: 'json', path: '/data', password: 'pw' })

      assert.deepEqual(store, { type: 'json', path: '/data' })
    })
  })

  describe('readBootstrap', () => {
    it(`returns null when nothing is configured`, async () => {
      assert.equal(await readBootstrap(dir), null)
    })

    it(`round-trips a written bootstrap`, async () => {
      await writeBootstrap(dir, { configured: true, api: { mode: 'tcp', port: 3000 } })

      const cfg = await readBootstrap(dir)

      assert.equal(cfg.configured, true)
      assert.equal(cfg.api.mode, 'tcp')
    })
  })

  describe('legacy nictool.toml migration', () => {
    const legacyToml = `configured = true

[store]
type = "directory"
path = "/var/lib/nictool/data"

[api]
mode = "local"
host = "nt.example.com"
port = 3000

[[nameserver]]
name = "ns1.example.com."
engine = "native"
`

    const writeLegacy = async () => {
      await fsp.mkdir(path.join(dir, 'etc'), { recursive: true })
      await fsp.writeFile(path.join(dir, 'etc', 'nictool.toml'), legacyToml)
    }

    it(`splits the store out into api.json and normalizes the mode`, async () => {
      await writeLegacy()

      const cfg = await readBootstrap(dir)

      assert.equal(cfg.api.mode, 'in_process')
      assert.equal(cfg.configured, true)
      assert.equal(cfg.store, undefined, 'store no longer lives in the server config')

      const apiJson = JSON.parse(await fsp.readFile(apiConfigPath(dir), 'utf8'))
      assert.deepEqual(apiJson.store, { type: 'toml', path: '/var/lib/nictool/data' })
    })

    it(`carries nameservers across, pending their move into the store`, async () => {
      await writeLegacy()

      const cfg = await readBootstrap(dir)

      assert.equal(cfg.nameserver.length, 1)
      assert.equal(
        cfg.nameserver[0].type,
        'native',
        'the legacy engine spelling is rewritten',
      )
    })

    it(`writes nictool.json so the migration runs only once`, async () => {
      await writeLegacy()
      await readBootstrap(dir)
      assert.equal(fs.existsSync(bootstrapPath(dir)), true)

      // A later edit to the json must win over the stale toml still on disk.
      await writeBootstrap(dir, { configured: true, api: { mode: 'remote' } })
      assert.equal((await readBootstrap(dir)).api.mode, 'remote')
    })

    it(`splitLegacyConfig leaves the store for the API`, () => {
      const { bootstrap, store } = splitLegacyConfig({
        configured: true,
        store: { type: 'mysql', host: 'db' },
        api: { mode: 'local' },
      })

      assert.equal(bootstrap.store, undefined)
      assert.equal(store.host, 'db')
    })
  })

  describe('writeApiConfig', () => {
    it(`preserves sections the API generated for itself`, async () => {
      // Rotating these on every config save would log every session out.
      await fsp.mkdir(path.join(dir, 'etc'), { recursive: true })
      await fsp.writeFile(
        apiConfigPath(dir),
        JSON.stringify({
          http: { jwt: { key: 'abc123' }, cookie: { password: 'secret' } },
        }),
      )

      await writeApiConfig(dir, { type: 'json', path: '/data' })

      const apiJson = JSON.parse(await fsp.readFile(apiConfigPath(dir), 'utf8'))
      assert.equal(apiJson.http.jwt.key, 'abc123')
      assert.equal(apiJson.http.cookie.password, 'secret')
      assert.deepEqual(apiJson.store, { type: 'json', path: '/data' })
    })

    it(`replaces a previously configured store rather than merging into it`, async () => {
      await writeApiConfig(dir, { type: 'mysql', host: 'db', database: 'nictool' })
      await writeApiConfig(dir, { type: 'json', path: '/data' })

      const apiJson = JSON.parse(await fsp.readFile(apiConfigPath(dir), 'utf8'))
      assert.equal(apiJson.store.host, undefined, 'stale mysql keys are gone')
      assert.equal(apiJson.store.type, 'json')
    })

    it(`writes the file owner-only`, async (t) => {
      // The file holds the store password. Windows has no POSIX mode bits —
      // node reports 0o666 whatever is requested, and access is governed by
      // ACLs — so there is nothing to assert there.
      if (process.platform === 'win32') {
        return t.skip('POSIX modes are not enforced on Windows')
      }

      await writeApiConfig(dir, { type: 'mysql', password: 'pw' })

      const mode = fs.statSync(apiConfigPath(dir)).mode & 0o777
      assert.equal(mode, 0o600)
    })
  })

  describe('buildRemoteUrl', () => {
    it(`is null unless the API is remote`, () => {
      assert.equal(buildRemoteUrl({ api: { mode: 'in_process' } }), null)
      assert.equal(buildRemoteUrl({ api: { mode: 'local' } }), null)
    })

    it(`uses http for loopback and https otherwise`, () => {
      assert.equal(
        buildRemoteUrl({ api: { mode: 'remote', host: 'localhost', port: 3000 } }),
        'http://localhost:3000',
      )
      assert.equal(
        buildRemoteUrl({ api: { mode: 'remote', host: 'api.example.com', port: 3000 } }),
        'https://api.example.com:3000',
      )
    })

    it(`honours an explicit scheme for an internal remote API`, () => {
      assert.equal(
        buildRemoteUrl({
          api: { mode: 'remote', scheme: 'http', host: 'api', port: 3000 },
        }),
        'http://api:3000',
      )
      assert.equal(
        buildRemoteUrl({
          api: { mode: 'remote', scheme: 'https', host: 'api', port: 3000 },
        }),
        'https://api:3000',
      )
    })

    it(`rejects an unknown remote API scheme`, () => {
      assert.equal(
        buildRemoteUrl({
          api: { mode: 'remote', scheme: 'file', host: 'api', port: 3000 },
        }),
        null,
      )
    })

    it(`is null when the remote is underspecified`, () => {
      assert.equal(
        buildRemoteUrl({ api: { mode: 'remote', host: 'api.example.com' } }),
        null,
      )
    })
  })

  describe('toJson', () => {
    it('sorts, indents by one space, and ends with a newline', () => {
      assert.equal(toJson({ b: 1, a: 2 }), '{\n "a": 2,\n "b": 1\n}\n')
    })
  })

  describe('buildRemoteApiConfig', () => {
    it(`is a drop-in api.json holding only the store`, () => {
      const cfg = buildRemoteApiConfig({ type: 'mysql', host: 'db', database: 'nictool' })

      assert.deepEqual(Object.keys(cfg), ['store'])
      assert.equal(cfg.store.database, 'nictool')
    })
  })
})
