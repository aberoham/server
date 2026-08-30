#!/usr/bin/env node

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseArgs, promisify } from 'node:util'

import { AxfrServer, FileSource, MysqlSource } from '@nictool/dns-nameserver'

import { startServer } from '../index.js'
import ApiProcess from '../lib/api-process.js'
import NameserverSupervisor from '../lib/nameservers.js'
import {
  buildRemoteUrl,
  etcDir,
  normalizeApiMode,
  readBootstrap,
  writeBootstrap,
} from '../lib/config.js'
import { migrateNameservers, resolveNameserverConfig } from '../lib/nameserver-config.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    config: { type: 'string', short: 'c' },
  },
  strict: true,
})

if (!values.config) {
  console.log(`Usage: nictool-server -c <config-dir>

Options:
  -c, --config <dir>  Path to the NicTool data root (required).
                      TLS certificates are read from <dir>/etc/tls/ and
                      auto-generated for ${os.hostname()} if absent.
                      The configurator will build <dir>/etc/nictool.json.

Example:
  nictool-server -c /var/lib/nictool`)
  process.exit(0)
}

const configDir = path.resolve(values.config)

// ---------------------------------------------------------------------------
// Verify config directory is readable
// ---------------------------------------------------------------------------

try {
  await fs.access(configDir, fs.constants.R_OK)
  await fs.readdir(configDir)
} catch (err) {
  console.error(`Cannot read directory ${configDir}: ${err.message}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// TLS – discover existing certs or generate a self-signed one
// ---------------------------------------------------------------------------

const useTLS = process.env.NICTOOL_TLS?.toLowerCase() !== 'false'
const osHostname = os.hostname()
const tlsDir = path.join(configDir, 'etc', 'tls')

let tls = null
let host = osHostname

if (useTLS) {
  const discovered = await discoverTLS(tlsDir, osHostname)
  if (discovered) {
    const { hostname: certHost, ...pemMaterial } = discovered
    tls = pemMaterial
    host = certHost
  } else {
    console.log(`Generating self-signed cert for ${osHostname}`)
    tls = await generateTLS(tlsDir, osHostname)
  }
} else {
  console.log('TLS disabled by NICTOOL_TLS=false')
}

const bindHost = process.env.NICTOOL_BIND_HOST || host

// ---------------------------------------------------------------------------
// NicTool bootstrap config (nictool.json)
// ---------------------------------------------------------------------------

const nicConfig = await readBootstrap(configDir)

// ---------------------------------------------------------------------------
// Port selection – prefer 443/8443 for HTTPS and 8080 for HTTP
// ---------------------------------------------------------------------------

let port
if (useTLS) {
  port =
    (await resolvePort(bindHost, 443)) ??
    (await resolvePort(bindHost, 8443)) ??
    (await randomAvailablePort(bindHost))
} else {
  port = parsePort(process.env.NICTOOL_HTTP_PORT, 8080)
}

// ---------------------------------------------------------------------------
// If already configured, skip the configurator and go straight to services
// ---------------------------------------------------------------------------

const supervisor = new NameserverSupervisor()
let apiProcess = null
let axfrServer = null

async function shutdown() {
  try {
    await supervisor.stop()
  } catch {
    /* ignore */
  }
  try {
    await axfrServer?.stop()
  } catch {
    /* ignore */
  }
  try {
    await apiProcess?.stop()
  } catch {
    /* ignore */
  }
  process.exit(0)
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)

if (nicConfig?.configured === true) {
  console.log('Already configured — starting services.')
  const { apiServer, apiRemoteUrl, pid } = await startAPI(nicConfig)
  await startServer({
    configDir,
    tls,
    host,
    bindHost,
    port,
    nicConfig,
    apiServer,
    apiRemoteUrl,
    apiPid: pid,
    supervisor,
    startApi: startAPI,
    stopApi: stopAPI,
  })
  await startNameservers(nicConfig)
} else {
  // ---------------------------------------------------------------------------
  // Pre-select a random port to suggest for the API in the configuration form
  // ---------------------------------------------------------------------------

  const suggestedApiPort = await randomAvailablePort(host)

  // ---------------------------------------------------------------------------
  // Start configurator; wire up API once config is saved
  // ---------------------------------------------------------------------------

  await startServer({
    configDir,
    tls,
    host,
    bindHost,
    port,
    nicConfig,
    supervisor,
    suggestedPorts: { api: suggestedApiPort },
    startApi: startAPI,
    stopApi: stopAPI,
    onSaved: async (config, ctx) => {
      if (!ctx.apiServer && !ctx.apiRemoteUrl) {
        const started = await startAPI(config)
        ctx.apiServer = started.apiServer
        ctx.apiRemoteUrl = started.apiRemoteUrl
        ctx.apiMode = normalizeApiMode(config.api?.mode)
        ctx.apiPid = started.pid ?? null
      }
      try {
        await ctx.supervisor?.stop()
      } catch {
        /* ignore */
      }
      await startNameservers(config)
    },
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try to load TLS from $hostname.pem, localhost.pem, or legacy cert.pem+key.pem.
 */
async function discoverTLS(dir, hostname) {
  const pemCandidates = [
    { file: path.join(dir, `${hostname}.pem`), hostname },
    { file: path.join(dir, 'localhost.pem'), hostname: 'localhost' },
  ]

  for (const { file, hostname: certHost } of pemCandidates) {
    try {
      const content = await fs.readFile(file, 'utf8')
      const parsed = parsePEMBlocks(content)
      if (parsed?.key && parsed?.cert) {
        console.log(`Using TLS from ${file}`)
        return { ...parsed, hostname: certHost }
      } else {
        console.warn(`missing valid PEM blocks in ${file}, skipping`)
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(e.message)
      /* not found — try next */
    }
  }

  return null
}

/**
 * Extract private key and certificate chain from a combined PEM file.
 */
function parsePEMBlocks(content) {
  const keyMatch = content.match(
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/,
  )
  const certMatches = [
    ...content.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g),
  ]
  if (!keyMatch || !certMatches.length) return null
  return {
    key: keyMatch[0] + '\n',
    cert: certMatches.map((m) => m[0]).join('\n') + '\n',
  }
}

/**
 * Generate a self-signed cert for hostname and store as $hostname.pem.
 */
async function generateTLS(dir, hostname) {
  const pemFile = path.join(dir, `${hostname}.pem`)
  await fs.mkdir(dir, { recursive: true })

  const tmpKey = path.join(dir, '.tmp-key.pem')
  const tmpCert = path.join(dir, '.tmp-cert.pem')

  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    tmpKey,
    '-out',
    tmpCert,
    '-days',
    '365',
    '-nodes',
    '-subj',
    `/CN=${hostname}`,
  ])

  const [key, cert] = await Promise.all([
    fs.readFile(tmpKey, 'utf8'),
    fs.readFile(tmpCert, 'utf8'),
  ])
  await fs.writeFile(pemFile, key + cert)
  await Promise.allSettled([fs.unlink(tmpKey), fs.unlink(tmpCert)])

  console.log(`Generated self-signed certificate: ${pemFile}`)
  return { key, cert }
}

/**
 * Start the nameserver engines described by the store. Nameservers still
 * carried in an older bootstrap config are moved into the store first.
 */
async function startNameservers(config) {
  try {
    const migrated = await migrateNameservers(configDir, config, writeBootstrap)
    const nsConfig = await resolveNameserverConfig(configDir, migrated)
    await supervisor.start(nsConfig)
    await startAxfrServer(config, nsConfig)
  } catch (err) {
    console.error(`Supervisor start failed: ${err.message}`)
  }
}

/**
 * Answer zone transfers, when `axfr` is configured, so a secondary can pull
 * from NicTool rather than from a primary NicTool feeds.
 *
 * It is not a nameserver and does not go through the supervisor: it publishes
 * nothing and reads the Source directly, so it serves whatever is current
 * rather than whatever was last published. Authorization comes from the same
 * nameserver records the supervisor uses — a peer is matched by address, and
 * gets exactly the zones assigned to it.
 */
async function startAxfrServer(config, nsConfig) {
  const axfr = config?.axfr
  if (!axfr?.listen?.length) return

  try {
    const source = buildAxfrSource(nsConfig.store)
    axfrServer = new AxfrServer({
      listen: axfr.listen,
      source,
      nameservers: nsConfig.nameserver ?? [],
      maxMessageSize: axfr.maxMessageSize,
    })
    axfrServer.on('error', (err) => console.error(`AXFR: ${err.message}`))
    axfrServer.on('refused', (d) =>
      console.warn(`AXFR refused ${d.zone} to ${d.peer}: ${d.reason}`),
    )
    await axfrServer.start()
    const where = axfrServer
      .addresses()
      .map((a) => `${a.address}:${a.port}`)
      .join(', ')
    console.log(`AXFR listener: ${where} (${axfrServer.status().authorized} peers)`)
  } catch (err) {
    console.error(`AXFR listener failed to start: ${err.message}`)
    axfrServer = null
  }
}

function buildAxfrSource(store) {
  switch (store?.type) {
    case 'mysql':
      return new MysqlSource(store)
    case 'json':
      return new FileSource({ path: store.path, format: 'json' })
    case 'toml':
    case 'directory':
      return new FileSource({ path: store.path, format: 'toml' })
    default:
      throw new Error(`unsupported store type for AXFR: ${store?.type ?? '(missing)'}`)
  }
}

/**
 * Bring up the API in whichever mode the bootstrap config selects.
 *
 * Failures are reported rather than thrown: at boot the configurator must stay
 * reachable so the operator can correct the config that broke the start.
 *
 * @returns {Promise<{apiServer: import('@hapi/hapi').Server|null, apiRemoteUrl: string|null, error?: string}>}
 */
async function startAPI(config) {
  if (!config?.api) return { apiServer: null, apiRemoteUrl: null }

  const mode = normalizeApiMode(config.api.mode)
  if (mode === 'remote') {
    return { apiServer: null, apiRemoteUrl: buildRemoteUrl(config) }
  }

  applyApiEnv()

  if (mode === 'tcp') {
    const port = config.api.port
    if (!port) {
      const error = 'api.mode is "tcp" but no api.port is set'
      console.error(error)
      return { apiServer: null, apiRemoteUrl: null, error }
    }
    apiProcess = new ApiProcess({ configDir, port })
    apiProcess.on('error', (err) => console.error(`API process error: ${err.message}`))
    try {
      await apiProcess.start()
      return {
        apiServer: null,
        apiRemoteUrl: apiProcess.url,
        pid: apiProcess.child?.pid ?? null,
      }
    } catch (err) {
      console.error(`API process failed to start: ${err.message}`)
      apiProcess = null
      return { apiServer: null, apiRemoteUrl: null, error: err.message }
    }
  }

  return initInProcessAPI()
}

/**
 * Shut down whichever local API startAPI brought up. A remote API is not ours
 * to stop, so only the caller's reference to it is dropped.
 */
async function stopAPI(ctx) {
  if (apiProcess) {
    await apiProcess.stop()
    apiProcess = null
  }
  await ctx.apiServer?.stop()
}

/**
 * The API resolves its config directory and store backend at module load, so
 * this must be set before it is first imported — hence the dynamic import in
 * initInProcessAPI. The store itself is read by the API from etc/api.json;
 * the server does not need to know where the data lives.
 */
function applyApiEnv() {
  process.env.NICTOOL_CONF_DIR = etcDir(configDir)
}

async function initInProcessAPI() {
  try {
    const { init: initAPI } = await import('@nictool/api/routes/index.js')
    const apiServer = await initAPI()
    console.log('API initialized in-process')
    return { apiServer, apiRemoteUrl: null, pid: process.pid }
  } catch (err) {
    console.error(`API init failed: ${err.message}`)
    return { apiServer: null, apiRemoteUrl: null, error: err.message }
  }
}

/**
 * Bind to port 0 to get a random available port assigned by the OS.
 */
function randomAvailablePort(bindHost = 'localhost') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, bindHost, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Return `preferred` if it is available to bind on `host`, otherwise null.
 * Covers both EACCES (no privilege) and EADDRINUSE (already in use).
 */
function resolvePort(bindHost, preferred) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(null))
    probe.once('listening', () => {
      probe.close(() => resolve(preferred))
    })
    probe.listen(preferred, bindHost)
  })
}

function parsePort(value, fallback) {
  if (value === undefined || value === '') return fallback
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid NICTOOL_HTTP_PORT: ${value}`)
    process.exit(1)
  }
  return port
}
