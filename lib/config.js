import fs from 'node:fs/promises'
import path from 'node:path'

import { parse } from 'smol-toml'

// The server's own config holds only what it needs to reach the API. Store
// connection details belong to the API (etc/api.json); everything else belongs
// in the store.
export const API_MODES = ['in_process', 'tcp', 'remote']

export const etcDir = (configDir) => path.join(configDir, 'etc')
export const bootstrapPath = (configDir) => path.join(etcDir(configDir), 'nictool.json')
export const apiConfigPath = (configDir) => path.join(etcDir(configDir), 'api.json')
const legacyTomlPath = (configDir) => path.join(etcDir(configDir), 'nictool.toml')

/** "local" was the pre-tcp name for running the API inside this process. */
export function normalizeApiMode(mode) {
  if (!mode || mode === 'local') return 'in_process'
  return mode
}

/**
 * A file store keeps rows in one file per entity; "directory" was the original
 * name for that, before the codec became selectable.
 */
export function storeTypeToEnv(type) {
  if (type === 'directory') return 'toml'
  return type ?? 'mysql'
}

/**
 * Recursively order object keys so serialized output is stable — an unsorted
 * dump reshuffles on unrelated edits and makes diffs unreadable.
 */
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  if (Object.getPrototypeOf(value) !== Object.prototype) return value

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortKeys(value[k])]),
  )
}

/** Human-friendly JSON: sorted, shallow-indented, newline-terminated. */
export function toJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 1)}\n`
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * Read the server bootstrap config, migrating a pre-existing nictool.toml on
 * first sight. Returns null when the server has never been configured.
 */
export async function readBootstrap(configDir) {
  const existing = await readJson(bootstrapPath(configDir))
  if (existing) return existing

  let legacy
  try {
    legacy = parse(await fs.readFile(legacyTomlPath(configDir), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }

  const { bootstrap, store } = splitLegacyConfig(legacy)
  if (store) await writeApiConfig(configDir, store)
  await writeBootstrap(configDir, bootstrap)
  console.log(`Migrated ${legacyTomlPath(configDir)} to nictool.json + api.json`)
  return bootstrap
}

/**
 * Split a v0.2-era nictool.toml into the server's bootstrap config and the
 * API's store connection.
 */
export function splitLegacyConfig(legacy) {
  const bootstrap = {
    configured: legacy.configured === true,
    api: {
      ...legacy.api,
      mode: normalizeApiMode(legacy.api?.mode),
    },
  }
  // Nameserver topology still rides along here; moving it into the store is a
  // separate change, gated on reconciling the API's nameserver schema.
  //
  // `engine` was an early v3 spelling of `type`, which the export types already
  // named. Rewritten once, here, so nothing downstream has to know both.
  if (Array.isArray(legacy.nameserver)) {
    bootstrap.nameserver = legacy.nameserver.map(({ engine, ...ns }) =>
      ns.type === undefined && engine !== undefined ? { ...ns, type: engine } : ns,
    )
  }

  return { bootstrap, store: legacy.store ?? null }
}

export async function readApiConfig(configDir) {
  return readJson(apiConfigPath(configDir))
}

export async function writeBootstrap(configDir, config) {
  await fs.mkdir(etcDir(configDir), { recursive: true })
  await fs.writeFile(bootstrapPath(configDir), toJson(config))
}

/**
 * Write the store connection into the API's config, preserving any sections
 * the API generated for itself — clobbering them would rotate the JWT and
 * cookie secrets on every save and log every session out.
 */
export async function writeApiConfig(configDir, store) {
  const file = apiConfigPath(configDir)
  const existing = (await readJson(file)) ?? {}
  const merged = { ...existing, store: buildStoreConfig(store) }

  await fs.mkdir(etcDir(configDir), { recursive: true })
  await fs.writeFile(file, toJson(merged), { mode: 0o600 })
  return merged
}

/**
 * Normalize a configurator store payload into what the API needs to connect.
 * Only the keys relevant to the chosen type survive.
 */
export function buildStoreConfig(store = {}) {
  const type = storeTypeToEnv(store.type)

  if (type === 'mysql') {
    const { host, port, user, password, database, dsn } = store
    return { type, host, port, user, password, database, dsn }
  }

  return { type, path: store.path }
}

/** The drop-in api.json handed to an operator running the API on another host. */
export function buildRemoteApiConfig(store) {
  return { store: buildStoreConfig(store) }
}

/**
 * Base URL for a remotely-hosted API, or null when it runs locally.
 */
export function buildRemoteUrl(config) {
  if (normalizeApiMode(config?.api?.mode) !== 'remote') return null
  const { host, port, scheme: configuredScheme } = config.api ?? {}
  if (!host || !port) return null
  const scheme =
    configuredScheme ?? (/^(localhost|127\.|::1)/.test(host) ? 'http' : 'https')
  if (!['http', 'https'].includes(scheme)) return null
  return `${scheme}://${host}:${port}`
}
