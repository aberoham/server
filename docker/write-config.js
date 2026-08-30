#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

import { bootstrapPath, toJson } from '../lib/config.js'

const configDir = path.resolve(process.env.NICTOOL_CONFIG_DIR ?? '/data')
const configFile = bootstrapPath(configDir)
const port = parsePort(process.env.NICTOOL_API_PORT ?? '3000')
const scheme = process.env.NICTOOL_API_SCHEME ?? 'http'

if (!['http', 'https'].includes(scheme)) {
  throw new Error(`NICTOOL_API_SCHEME must be http or https, got ${scheme}`)
}

const config = {
  configured: true,
  api: {
    mode: 'remote',
    scheme,
    host: process.env.NICTOOL_API_HOST ?? 'api',
    port,
  },
}

await fs.mkdir(path.dirname(configFile), { recursive: true })
try {
  await fs.writeFile(configFile, toJson(config), { flag: 'wx' })
  console.log(`Generated ${configFile}`)
} catch (err) {
  if (err.code !== 'EEXIST') throw err
  console.log(`Using existing ${configFile}`)
}

function parsePort(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`NICTOOL_API_PORT must be an integer from 1 to 65535, got ${value}`)
  }
  return parsed
}
