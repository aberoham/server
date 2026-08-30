import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import Joi from 'joi'
import mysql from 'mysql2/promise'

import {
  API_MODES,
  bootstrapPath,
  buildRemoteApiConfig,
  normalizeApiMode,
  readApiConfig,
  storeTypeToEnv,
  toJson,
  writeApiConfig,
  writeBootstrap,
} from './lib/config.js'

// .pathname is drive-relative on Windows ("/D:/a/server")
const __dirname = fileURLToPath(new URL('.', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
}

/**
 * Start the NicTool server over HTTP or HTTPS.
 *
 * @param {object} opts
 * @param {string} opts.configDir    Absolute path to the NicTool data root.
 * @param {{ cert: string, key: string }|null} opts.tls  PEM-encoded TLS material.
 * @param {string} opts.host         Hostname shown in the server URL.
 * @param {string} [opts.bindHost]   Address to bind; defaults to opts.host.
 * @param {number} opts.port         Port to listen on (443 or 8443).
 * @param {object} [opts.nicConfig]  Parsed nictool.toml contents, or null.
 * @param {object} [opts.apiServer]  Initialized (but not listening) Hapi server for in-process API.
 * @param {object} [opts.suggestedPorts] Random port suggestions { api, client }.
 * @param {Function} [opts.onSaved]  Called with (config, ctx) after a successful save, once the
 *                                   response has flushed. May set ctx.apiServer.
 * @param {Function} [opts.startApi] Called with (config); resolves { apiServer, apiRemoteUrl, error }.
 * @param {Function} [opts.stopApi]  Called with (ctx) to shut down a locally started API.
 * @returns {Promise<http.Server|https.Server>}
 */
export async function startServer({
  configDir,
  tls,
  host,
  bindHost = host,
  port,
  nicConfig = null,
  apiServer = null,
  apiRemoteUrl = null,
  apiPid = null,
  suggestedPorts = null,
  onSaved = null,
  startApi = null,
  stopApi = null,
  supervisor = null,
}) {
  // ctx is mutated as services start/stop
  const ctx = {
    configDir,
    bootstrapFile: bootstrapPath(configDir),
    nicConfig,
    apiServer,
    apiRemoteUrl,
    apiPid,
    suggestedPorts,
    host,
    onSaved,
    startApi,
    stopApi,
    supervisor,
  }

  // An API started before us came up on the api.json already on disk.
  if (apiServer || apiRemoteUrl) {
    ctx.storeConfig = (await readApiConfig(configDir).catch(() => null))?.store ?? null
  }

  const handler = (req, res) => handleRequest(req, res, ctx)
  const useTLS = Boolean(tls?.cert && tls?.key)
  const server = useTLS
    ? https.createServer({ cert: tls.cert, key: tls.key }, handler)
    : http.createServer(handler)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bindHost, resolve)
  })

  const scheme = useTLS ? 'https' : 'http'
  const defaultPort = useTLS ? 443 : 80
  const url = `${scheme}://${host}${port === defaultPort ? '' : `:${port}`}`
  console.log(`Configurator: ${url}`)

  return server
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleRequest(req, res, ctx) {
  const { method, url } = req

  try {
    if (url === '/' && method === 'GET') {
      const page = ctx.nicConfig?.configured ? 'html/index.html' : 'html/configure.html'
      return await serveFile(res, page)
    }

    if (url === '/nt/config' && method === 'GET') return await serveConfig(res, ctx)
    if (url === '/nt/config' && method === 'POST') return await saveConfig(req, res, ctx)
    if (url?.startsWith('/nt/check-path') && method === 'GET')
      return await checkPath(req, res, ctx)
    if (url?.startsWith('/nt/check-dsn') && method === 'GET')
      return await checkDsn(req, res)
    if (url?.startsWith('/nt/detect-schema') && method === 'GET')
      return await detectSchema(req, res)
    if (url === '/nt/init-schema' && method === 'POST') return await initSchema(req, res)
    if (url === '/nt/api-config' && method === 'GET')
      return await serveApiConfig(res, ctx)
    if (url === '/nt/service' && method === 'GET') return serveService(res, ctx)
    if (url === '/nt/service' && method === 'POST')
      return await controlService(req, res, ctx)
    if (url === '/nt/status' && method === 'GET') return await serveStatus(res, ctx)
    if (url === '/nt/nameservers/status' && method === 'GET')
      return serveNameserversStatus(res, ctx)

    if (url?.startsWith('/api/') || url?.startsWith('/doc')) {
      if (ctx.apiServer) return await forwardToAPI(req, res, ctx.apiServer)
      // Must be awaited: `return promise` inside try/catch escapes the catch.
      if (ctx.apiRemoteUrl) return await forwardToRemote(req, res, ctx.apiRemoteUrl)
    }

    if (method === 'GET')
      return await serveStatic(req, res, path.join(__dirname, 'html'), '/')

    respond(res, 404, 'application/json', JSON.stringify({ error: `Not Found ${url}` }))
  } catch (err) {
    console.error(err)
    respond(
      res,
      500,
      'application/json',
      JSON.stringify({ error: 'Internal Server Error' }),
    )
  }
}

async function serveFile(res, relPath) {
  const ext = path.extname(relPath)
  const contentType = MIME[ext] ?? 'application/octet-stream'
  const content = await fs.readFile(path.join(__dirname, relPath), 'utf8')
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' })
  res.end(content)
}

async function serveStatic(req, res, rootDir, urlPrefix) {
  const urlPath = new URL(req.url, 'http://x').pathname
  const rel = path.normalize(urlPath.slice(urlPrefix.length) || '/')
  const filePath = path.join(rootDir, rel)

  // Prevent path traversal outside rootDir
  if (!filePath.startsWith(rootDir + path.sep) && filePath !== rootDir) {
    respond(res, 403, 'application/json', JSON.stringify({ error: 'Forbidden' }))
    return
  }

  try {
    // Fixed-name bundles (dist/app.js) change contents on every build, so force
    // the browser to revalidate rather than serve a stale cached copy — a stale
    // app.js was silently dropping the auth token and 401-ing every API call.
    const stat = await fs.stat(filePath)
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
    const contentType = MIME[path.extname(filePath)] ?? 'application/octet-stream'
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
      res.end()
      return
    }
    const content = await fs.readFile(filePath)
    res.writeHead(200, {
      'Content-Type': contentType,
      ETag: etag,
      'Cache-Control': 'no-cache',
    })
    res.end(content)
  } catch (err) {
    if (err.code === 'ENOENT') {
      respond(
        res,
        404,
        'application/json',
        JSON.stringify({ error: `Not Found: static ${urlPath}` }),
      )
    } else {
      throw err
    }
  }
}

/**
 * The configurator's view of what is already on disk. The store lives in
 * api.json rather than the bootstrap file, so it is read back from there —
 * without it the form comes up blank on every visit and the operator retypes
 * a connection the server already has.
 */
async function serveConfig(res, { configDir, nicConfig, suggestedPorts, host }) {
  const store = (await readApiConfig(configDir).catch(() => null))?.store ?? null

  const config = nicConfig ? { ...nicConfig } : { _suggested: suggestedPorts ?? {} }
  if (store?.type && !config.store) config.store = store
  config._hostname = host

  respond(res, 200, 'application/json', JSON.stringify(config, null, 2))
}

/**
 * The store a running API loaded, as a URI with the password redacted. Built
 * from the individual fields rather than store.dsn, which carries the password
 * in clear — this is reported to a page served before anyone authenticates.
 */
function storeUri(store) {
  if (!store?.type) return null

  if (storeTypeToEnv(store.type) === 'mysql') {
    const credentials = store.user
      ? `${encodeURIComponent(store.user)}${store.password ? ':***' : ''}@`
      : ''
    const port = store.port ? `:${store.port}` : ''
    return `mysql://${credentials}${store.host ?? '127.0.0.1'}${port}/${store.database ?? ''}`
  }

  return store.path ? `file://${store.path}` : null
}

// A tcp-mode API is reached by URL rather than by injection, so apiServer alone
// does not tell us whether one is up.
function serveService(res, ctx) {
  const api = { running: Boolean(ctx.apiServer || ctx.apiRemoteUrl) }
  if (ctx.apiError) api.error = ctx.apiError

  // What the API actually came up on, so the configurator can show that its
  // etc/api.json is the one in use rather than leaving the operator guessing.
  if (api.running) {
    api.mode = ctx.apiMode ?? normalizeApiMode(ctx.nicConfig?.api?.mode)
    if (ctx.apiPid) api.pid = ctx.apiPid
    const store = storeUri(ctx.storeConfig)
    if (store) api.store = store
  }

  respond(res, 200, 'application/json', JSON.stringify({ api }, null, 2))
}

/**
 * Start or stop the local API from the configurator, before anything is saved.
 * Starting writes etc/api.json first — the API reads its store from there at
 * module load, so it has to be on disk before the process or import happens.
 */
async function controlService(req, res, ctx) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return respond(
      res,
      400,
      'application/json',
      JSON.stringify({ error: 'Invalid JSON' }),
    )
  }

  const fail = (status, error) =>
    respond(res, status, 'application/json', JSON.stringify({ error }))

  if (body?.action === 'stop') {
    try {
      await ctx.stopApi?.(ctx)
    } catch (err) {
      return fail(500, err.message)
    }
    ctx.apiServer = null
    ctx.apiRemoteUrl = null
    ctx.apiError = null
    ctx.apiMode = null
    ctx.apiPid = null
    return respond(res, 200, 'application/json', JSON.stringify({ running: false }))
  }

  if (body?.action !== 'start') return fail(400, 'action must be "start" or "stop"')
  if (!ctx.startApi) return fail(501, 'This server cannot start an API')
  if (ctx.apiServer || ctx.apiRemoteUrl)
    return respond(res, 200, 'application/json', JSON.stringify({ running: true }))

  const mode = normalizeApiMode(body?.api?.mode)
  if (mode === 'remote') return fail(400, 'A remote API is not ours to start')

  const invalid = validateConfig({ api: { ...body.api, mode }, store: body.store })
  if (invalid) return fail(400, invalid)

  try {
    await writeApiConfig(ctx.configDir, body.store)
    const started = await ctx.startApi({ api: { ...body.api, mode } })
    ctx.apiServer = started?.apiServer ?? null
    ctx.apiRemoteUrl = started?.apiRemoteUrl ?? null
    ctx.storeConfig = body.store

    if (!ctx.apiServer && !ctx.apiRemoteUrl) {
      ctx.apiError = started?.error || 'The API did not start — see the server log'
      return fail(500, ctx.apiError)
    }
    ctx.apiError = null
    ctx.apiMode = mode
    ctx.apiPid = started?.pid ?? null
    respond(res, 200, 'application/json', JSON.stringify({ running: true }))
  } catch (err) {
    ctx.apiError = err.message
    fail(500, err.message)
  }
}

async function checkPath(req, res, { configDir }) {
  const qs = new URL(req.url, 'http://x').searchParams
  const p = qs.get('path')
  if (!p)
    return respond(
      res,
      400,
      'application/json',
      JSON.stringify({ error: 'path required' }),
    )

  const resolved = path.isAbsolute(p) ? p : path.resolve(configDir, p)

  try {
    const stat = await fs.stat(resolved)
    if (stat.isDirectory()) {
      respond(
        res,
        200,
        'application/json',
        JSON.stringify({ ok: true, exists: true, resolved }),
      )
    } else {
      respond(
        res,
        200,
        'application/json',
        JSON.stringify({ ok: false, error: 'Path exists but is not a directory' }),
      )
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return respond(
        res,
        200,
        'application/json',
        JSON.stringify({ ok: false, error: err.message }),
      )
    }
    let ancestor = path.dirname(resolved)
    while (ancestor !== path.dirname(ancestor)) {
      try {
        await fs.access(ancestor, fs.constants.W_OK)
        return respond(
          res,
          200,
          'application/json',
          JSON.stringify({ ok: true, exists: false, resolved }),
        )
      } catch (e) {
        if (e.code !== 'ENOENT') break
        ancestor = path.dirname(ancestor)
      }
    }
    respond(
      res,
      200,
      'application/json',
      JSON.stringify({ ok: false, error: 'No writable ancestor directory found' }),
    )
  }
}

/**
 * Parse a mysql:// DSN into a mysql2 connection config. Throws if the DSN is
 * not a well-formed mysql URL.
 */
function parseMysqlDsn(dsn) {
  const u = new URL(dsn)
  if (u.protocol !== 'mysql:') throw new Error('DSN must use the mysql:// scheme')
  return {
    host: u.hostname || '127.0.0.1',
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  }
}

/**
 * Live connectivity probe for a MySQL DSN. Opens a real (short-lived)
 * connection and runs SELECT 1, so the configurator can light up green only
 * when the credentials actually work. Always answers 200 with { ok, error }.
 */
async function checkDsn(req, res) {
  const dsn = new URL(req.url, 'http://x').searchParams.get('dsn')
  if (!dsn)
    return respond(
      res,
      400,
      'application/json',
      JSON.stringify({ error: 'dsn required' }),
    )

  let cfg
  try {
    cfg = parseMysqlDsn(dsn)
  } catch (err) {
    return respond(
      res,
      200,
      'application/json',
      JSON.stringify({ ok: false, error: err.message }),
    )
  }

  let conn
  try {
    conn = await mysql.createConnection({ ...cfg, connectTimeout: 4000 })
    await conn.query('SELECT 1')
    respond(res, 200, 'application/json', JSON.stringify({ ok: true }))
  } catch (err) {
    const error = err.code ? `${err.code}: ${err.message}` : err.message
    respond(res, 200, 'application/json', JSON.stringify({ ok: false, error }))
  } finally {
    try {
      await conn?.end()
    } catch {
      /* ignore */
    }
  }
}

async function serveStatus(res, { bootstrapFile, nicConfig, apiServer, supervisor }) {
  const configured = await fileExists(bootstrapFile)
  const api = { running: apiServer != null }
  const nameservers = supervisor?.status?.() ?? []
  respond(
    res,
    200,
    'application/json',
    JSON.stringify(
      { configured, bootstrapFile, config: nicConfig, api, nameservers },
      null,
      2,
    ),
  )
}

function serveNameserversStatus(res, { supervisor }) {
  const nameservers = supervisor?.status?.() ?? []
  respond(res, 200, 'application/json', JSON.stringify({ nameservers }, null, 2))
}

async function saveConfig(req, res, ctx) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return respond(
      res,
      400,
      'application/json',
      JSON.stringify({ error: 'Invalid JSON' }),
    )
  }

  const { startApi: _startApi, _hostname: _h, _suggested: _s, ...submitted } = body

  const invalid = validateConfig(submitted)
  if (invalid) {
    return respond(res, 400, 'application/json', JSON.stringify({ error: invalid }))
  }

  const mode = normalizeApiMode(submitted.api?.mode)
  const config = {
    configured: true,
    api: { ...submitted.api, mode },
  }

  try {
    // The store connection belongs to the API, not to the server. In remote
    // mode there is no local API to configure — the operator downloads the
    // same file from /nt/api-config and drops it in on the API host.
    if (mode !== 'remote') await writeApiConfig(ctx.configDir, submitted.store)

    await writeBootstrap(ctx.configDir, config)
    ctx.nicConfig = config
    ctx.storeConfig = submitted.store
    res.on('finish', () => ctx.onSaved?.(config, ctx))
    respond(res, 200, 'application/json', JSON.stringify({ ok: true }))
  } catch (err) {
    respond(res, 500, 'application/json', JSON.stringify({ error: err.message }))
  }
}

function validateConfig(config) {
  const schema = Joi.object({
    install: Joi.string().valid('new', 'upgrade').default('new'),
    api: Joi.object({
      mode: Joi.string()
        .valid(...API_MODES, 'local')
        .required(),
      host: Joi.when('mode', {
        is: 'remote',
        then: Joi.string().hostname().required(),
        otherwise: Joi.string().allow('').optional(),
      }),
      port: Joi.when('mode', {
        is: Joi.valid('remote', 'tcp'),
        then: Joi.number().port().required(),
        otherwise: Joi.number().port().optional(),
      }),
      scheme: Joi.string().valid('http', 'https').optional(),
    }).required(),
    store: Joi.object({
      type: Joi.string().valid('json', 'toml', 'directory', 'mysql').required(),
      path: Joi.when('type', {
        is: Joi.valid('json', 'toml', 'directory'),
        then: Joi.string().required(),
        otherwise: Joi.string().allow('').optional(),
      }),
    })
      .unknown(true)
      .required(),
  }).unknown(true)

  const { error } = schema.validate(config, { abortEarly: true })
  return error ? error.message : null
}

// Tables whose presence means the target database already holds NicTool data.
const NICTOOL_TABLES = ['nt_options', 'nt_zone']

/**
 * @param {object} [opts]
 * @param {boolean} [opts.multipleStatements] Required to apply a schema file,
 *   which holds many statements. Left off elsewhere so probe queries that
 *   interpolate operator input keep the single-statement guarantee.
 */
async function withMysql(dsn, fn, opts = {}) {
  const cfg = parseMysqlDsn(dsn)
  let conn
  try {
    conn = await mysql.createConnection({
      ...cfg,
      connectTimeout: 4000,
      multipleStatements: Boolean(opts.multipleStatements),
    })
    return await fn(conn, cfg)
  } finally {
    try {
      await conn?.end()
    } catch {
      /* ignore */
    }
  }
}

async function findNicToolTables(conn, database) {
  const [rows] = await conn.query(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_name IN (?)',
    [database, NICTOOL_TABLES],
  )
  return rows.map((r) => r.t ?? r.table_name)
}

/**
 * Report whether a database already holds a NicTool schema, and which version.
 * Drives the upgrade path: an existing 2.x database is adopted, never rebuilt.
 */
async function detectSchema(req, res) {
  const dsn = new URL(req.url, 'http://x').searchParams.get('dsn')
  if (!dsn) {
    return respond(
      res,
      400,
      'application/json',
      JSON.stringify({ error: 'dsn required' }),
    )
  }

  try {
    const result = await withMysql(dsn, async (conn, cfg) => {
      const tables = await findNicToolTables(conn, cfg.database)
      if (!tables.length) return { ok: true, found: false, tables: [] }

      let version = null
      try {
        const [rows] = await conn.query(
          "SELECT option_value AS v FROM nt_options WHERE option_name = 'db_version'",
        )
        version = rows[0]?.v ?? null
      } catch {
        /* nt_zone without nt_options — still an existing install */
      }
      return { ok: true, found: true, version, tables }
    })
    respond(res, 200, 'application/json', JSON.stringify(result))
  } catch (err) {
    const error = err.code ? `${err.code}: ${err.message}` : err.message
    respond(res, 200, 'application/json', JSON.stringify({ ok: false, error }))
  }
}

/**
 * Create the NicTool schema in an empty database.
 *
 * sql/*.sql is idempotent (CREATE TABLE IF NOT EXISTS / INSERT IGNORE) and the
 * destructive cleanup lives in sql/upgrade/, which is not applied here. The
 * refusal below is the second line of defence: adopting an existing database is
 * the upgrade path's job, not the installer's. There is deliberately no override.
 */
async function initSchema(req, res) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return respond(
      res,
      400,
      'application/json',
      JSON.stringify({ error: 'Invalid JSON' }),
    )
  }

  if (body.install === 'upgrade') {
    return respond(
      res,
      409,
      'application/json',
      JSON.stringify({ error: 'Refusing to initialize a schema during an upgrade' }),
    )
  }
  if (!body.dsn) {
    return respond(
      res,
      400,
      'application/json',
      JSON.stringify({ error: 'dsn required' }),
    )
  }

  try {
    const result = await withMysql(
      body.dsn,
      async (conn, cfg) => {
        const existing = await findNicToolTables(conn, cfg.database)
        if (existing.length) return { conflict: existing }

        const applied = []
        for (const file of await sqlFiles()) {
          await conn.query(await fs.readFile(file, 'utf8'))
          applied.push(path.basename(file))
        }
        return { applied }
      },
      { multipleStatements: true },
    )

    if (result.conflict) {
      return respond(
        res,
        409,
        'application/json',
        JSON.stringify({
          error: `Database already contains NicTool tables (${result.conflict.join(', ')}). Choose "upgrade" to adopt it.`,
        }),
      )
    }
    respond(
      res,
      200,
      'application/json',
      JSON.stringify({ ok: true, applied: result.applied }),
    )
  } catch (err) {
    const error = err.code ? `${err.code}: ${err.message}` : err.message
    respond(res, 500, 'application/json', JSON.stringify({ ok: false, error }))
  }
}

async function sqlFiles() {
  const dir = path.join(
    path.dirname(fileURLToPath(import.meta.resolve('@nictool/api/server.js'))),
    'sql',
  )
  const entries = await fs.readdir(dir)
  return entries
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(dir, f))
}

/**
 * The API's config file, for an operator to drop in on a remote API host.
 */
async function serveApiConfig(res, ctx) {
  const store = ctx.storeConfig ?? (await readApiConfig(ctx.configDir))?.store
  if (!store) {
    return respond(
      res,
      404,
      'application/json',
      JSON.stringify({ error: 'No store configured yet' }),
    )
  }

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Disposition': 'attachment; filename="api.json"',
  })
  res.end(toJson(buildRemoteApiConfig(store)))
}

// ---------------------------------------------------------------------------
// API forwarding — dispatches /api/* requests to the in-process Hapi server
// ---------------------------------------------------------------------------

async function forwardToAPI(req, res, hapiServer) {
  const apiPath = req.url.slice(4) || '/' // strip '/api' prefix

  const forwardHeaders = {}
  for (const hdr of ['authorization', 'content-type', 'accept']) {
    if (req.headers[hdr]) forwardHeaders[hdr] = req.headers[hdr]
  }

  let payload
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const body = await readBody(req)
    if (body) payload = body
  }

  const result = await hapiServer.inject({
    method: req.method,
    url: apiPath,
    headers: forwardHeaders,
    payload,
    remoteAddress: req.socket?.remoteAddress ?? '127.0.0.1',
  })

  res.writeHead(result.statusCode, {
    'Content-Type': result.headers['content-type'] ?? 'application/json',
  })
  res.end(result.rawPayload)
}

/**
 * Proxy /api/* to a remote API server at remoteBaseUrl.
 * Streams the request body directly without buffering.
 * Uses rejectUnauthorized:false so self-signed certs on internal services work.
 */
function forwardToRemote(req, res, remoteBaseUrl) {
  const apiPath = req.url.slice(4) || '/'
  const target = new URL(apiPath, remoteBaseUrl)
  const mod = target.protocol === 'https:' ? https : http

  const forwardHeaders = {}
  for (const hdr of ['authorization', 'content-type', 'accept', 'content-length']) {
    if (req.headers[hdr]) forwardHeaders[hdr] = req.headers[hdr]
  }

  return new Promise((resolve) => {
    // An unreachable API is an expected state — it restarts, and a remote one
    // can be down — so answer 502 rather than faulting the whole server.
    const fail = (err) => {
      if (!res.headersSent) {
        respond(
          res,
          502,
          'application/json',
          JSON.stringify({ error: `API unreachable: ${err.code ?? err.message}` }),
        )
      } else {
        res.end()
      }
      resolve()
    }

    const upReq = mod.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: req.method,
        headers: forwardHeaders,
        rejectUnauthorized: false,
      },
      (upRes) => {
        const chunks = []
        upRes.on('data', (c) => chunks.push(c))
        upRes.on('end', () => {
          res.writeHead(upRes.statusCode, {
            'Content-Type': upRes.headers['content-type'] ?? 'application/json',
          })
          res.end(Buffer.concat(chunks))
          resolve()
        })
        upRes.on('error', fail)
      },
    )
    upReq.on('error', fail)
    req.pipe(upReq)
  })
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function respond(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType })
  res.end(body)
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}
