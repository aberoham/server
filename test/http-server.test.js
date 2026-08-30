import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-http-server-'))
let api
let server
let base

before(async () => {
  api = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ path: req.url }))
  })
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))

  const { startServer } = await import(new URL('../index.js', import.meta.url))
  server = await startServer({
    configDir: tmp,
    tls: null,
    host: 'localhost',
    bindHost: '127.0.0.1',
    port: 0,
    nicConfig: { configured: true, api: { mode: 'remote' } },
    apiRemoteUrl: `http://127.0.0.1:${api.address().port}`,
  })
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  if (api) await new Promise((resolve) => api.close(resolve))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('serves plain HTTP on the requested bind address', async () => {
  assert.equal(server.address().address, '127.0.0.1')
  assert.equal((await fetch(`${base}/nt/service`)).status, 200)
})

test('proxies to a remote HTTP API', async () => {
  const response = await fetch(`${base}/api/documentation`)

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { path: '/documentation' })
})
