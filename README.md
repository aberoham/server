# NicTool Server

NicTool is an open-source DNS management system. This package provides the **server** — a Node.js process that ties the NicTool DNS system together. It wears several hats:

## Web configurator (index.js + html/)

- Starts a web server that serves the setup UI
- On first run it presents a config form to set the data store and API.

## TLS auto-provisioning (bin/start.js)

- Discovers an existing cert or uses openssl to generate a cert.
- Picks a listen port: prefers 443 → 8443 → random free port.

## Process supervisor / launcher (bin/start.js)

- CLI entry (nictool-server -c <dir>), reads etc/nictool.json. When api.mode =
  - in_process: hosts the @nictool/api server in-process (no socket)
  - tcp: forks the API as a supervised child on api.port and proxies to it
  - remote: it proxies /api/\* and /doc to the remote API
- Handles SIGINT/SIGTERM to cleanly stop nameservers and the API child.

## Nameserver supervisor (lib/nameservers.js)

- Reads nameserver records from the data store, starts/stops each one.
  Each record carries its own runtime config (type, listen, publisher,
  transport, dnssec) alongside the legacy 2.x fields. `type` is the
  nt_nameserver_export_type name — which software this is, stored once.
- Supports a native in-memory authoritative server plus the exporting types (bind, knot, nsd, powerdns, coredns, djbdns, maradns), wiring up the right Source (json / toml / mysql), Publisher (memory / rfc1035 / tinydns-cdb / powerdns-db / coredns-redis), Transport (noop / rsync / axfr / db-replication / pull), and DNSSEC Signer per type.

Publisher options, set under `[nameserver.publisher]`:

| type          | options                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory`      | — (required by the native engine)                                                                                                                                                                                                                                                                                                                                           |
| `rfc1035`     | `path` — directory for `<zone>.zone` files. Also writes the server's own config declaring them — `named.conf`, `knot.conf` or `nsd.conf` per engine. `config.file` overrides the path; `config: false` disables it                                                                                                                                                          |
| `tinydns-cdb` | `path` — directory for `data` + `data.cdb`; `compile` (default true) runs `tinydns-data`; `tinydnsData` overrides the binary. tinydns keeps one global data file, so any change recompiles every zone. Set `compile = false` when the binary lives on the target and a Transport compiles there.                                                                            |
| `maradns`     | `path` — directory for `<zone>.csv2` files. MaraDNS reads csv2, not RFC 1035, so this is its own format. `config: {}` also writes a `mararc` declaring the zones, with `chroot_dir` pointing at `path`; `config.bindAddress` and `config.globals` set the rest. **`terminator: ''` for MaraDNS 1.2**, whose csv2 has no record terminator and rejects the `~` that 2.x uses |
| `powerdns-db` | `dsn` (or `host`/`port`/`user`/`password`/`database`) for a PowerDNS **gmysql** backend; `domainType` (default `NATIVE`). This is the push model — the alternative is `nt-powerdns`, the pipe backend below, which leaves the data in NicTool. Use one or the other.                                                                                                        |

Publishers default by nameserver type: `native` → memory, `djbdns` → tinydns-cdb,
`maradns` → maradns, everything else → rfc1035.

## Data model / config

Config is layered so each file holds only what is needed to reach the next layer:

| File                            | Holds                                          |
| ------------------------------- | ---------------------------------------------- |
| `<config-dir>/etc/nictool.json` | `configured`, and how to reach the API         |
| `<config-dir>/etc/api.json`     | the API's store connection and its own secrets |
| the store                       | nameservers, zones, records, users, groups     |

A pre-existing `etc/nictool.toml` is migrated to this layout on first start, and
nameservers still listed in `nictool.json` are moved into the store.

The one place the server reads `api.json` is to build nameserver Sources: the
DNS engines stream zone data straight from the store rather than through the
API, so the supervisor needs the store connection as well as the records.

Store types: `json` (default) and `toml` write one file per entity into
`store.path`; `mysql` uses a DSN. Depends on the sibling workspace packages:
@nictool/api, dns-nameserver, dns-zone, dns-resource-record.

## Prerequisites

- [Node.js](https://nodejs.org/) 20 or later
- `openssl` in `$PATH` (to auto-generate self-signed TLS certs)
- MySQL 8+ **or** a writable directory (for the file-based stores)

## Quickstart

### 1. Install

```sh
npm install -g @nictool/server
```

### 2. Create a data directory

```sh
mkdir -p /var/lib/nictool
```

### 3. Start the server

```sh
nictool-server -c /var/lib/nictool
```

No build step is involved — the published package ships the built UI. (`npm run
server` is the in-repo development equivalent; it runs Vite first and needs the
dev dependencies.)

On first run the server will:

1. Generate a self-signed TLS certificate for your hostname and save it to `/var/lib/nictool/etc/tls/`.
2. Open the **web configurator** at `https://<hostname>` (falls back to port `8443` if 443 is unavailable).

### 4. Complete setup in the browser

Open the URL printed to the console and work through the four cards — installation
type, API location, API status, and data store — then click **Save**. The
configurator writes `/var/lib/nictool/etc/nictool.json` plus the API's
`etc/api.json`, and starts the API automatically.

Choosing **Upgrade from NicTool 2.x** points NicTool at an existing 2.x MySQL
database. Use **Detect** to confirm the schema is found; NicTool will not create
tables in a database that already has them.

> **TLS warning** – The auto-generated certificate is self-signed. Accept the browser security warning for the initial setup, then replace it with a trusted certificate (see [TLS](#tls) below).

### docker

`docker/Dockerfile` starts the server with `/data` as its config directory. On
the first start, the entrypoint writes `etc/nictool.json` for a remote API from
these environment variables:

| Variable             | Default  |
| -------------------- | -------- |
| `NICTOOL_API_HOST`   | `api`    |
| `NICTOOL_API_PORT`   | `3000`   |
| `NICTOOL_API_SCHEME` | `http`   |
| `NICTOOL_CONFIG_DIR` | `/data`  |
| `NICTOOL_HTTP_PORT`  | `8080`   |
| `NICTOOL_BIND_HOST`  | hostname |

Set `NICTOOL_TLS=false` to serve plain HTTP. Otherwise the normal certificate
discovery and generation apply. An existing `etc/nictool.json` is never
replaced by the entrypoint.

---

## Configuration

The server's own settings live in `<config-dir>/etc/nictool.json`, and the API's
store connection in `<config-dir>/etc/api.json`. Both are created by the web
configurator but can also be edited by hand. The server reads them on every start.

To run the API on a different host, set its mode to **remote** and use the
configurator's **Download api.json** button; drop that file into the API host's
config directory, or point `NICTOOL_CONF_DIR` at it.

### Data store options

Set in `etc/api.json`, since the store belongs to the API.

| `store.type` | Description                                              |
| ------------ | -------------------------------------------------------- |
| `json`       | Default. One file per entity, zero dependencies          |
| `toml`       | Same layout, TOML codec (`directory` is the legacy name) |
| `mysql`      | Production-ready; requires MySQL 8+                      |

#### MySQL example

```json
{
  "store": {
    "type": "mysql",
    "host": "127.0.0.1",
    "port": 3306,
    "user": "nictool",
    "password": "secret",
    "database": "nictool"
  }
}
```

#### File example

```json
{
  "store": { "type": "json", "path": "/var/lib/nictool/zones" }
}
```

### API mode

Set in `etc/nictool.json`:

```json
{
  "configured": true,
  "api": { "mode": "in_process" }
}
```

| `api.mode`   | Behavior                                                          |
| ------------ | ----------------------------------------------------------------- |
| `in_process` | Default. Hosted inside the server, no socket. `local` is an alias |
| `tcp`        | Forked as a supervised child on `api.port`, proxied over HTTP     |
| `remote`     | An API elsewhere; needs `api.host` and `api.port`                 |

---

## TLS

On startup the server looks for certificates in `<config-dir>/etc/tls/` in this order:

1. `<hostname>.pem` — combined PEM (private key + certificate chain)
2. `localhost.pem` — combined PEM, bound as `localhost`
3. `cert.pem` + `key.pem` — legacy split files

If none are found, a self-signed certificate is generated via `openssl` and saved as `<hostname>.pem`.

To use your own certificate, place a combined PEM file at:

```
<config-dir>/etc/tls/<hostname>.pem
```

---

## Nameservers

NicTool can serve DNS via a built-in native nameserver or by acting as a
co-process backend for PowerDNS. Both are configured in `nictool.toml` under
`[[nameserver]]` blocks.

### Native nameserver (in-memory)

The native engine is a pure-Node.js authoritative DNS server built on `dns2`.
It loads zone data into memory from the NicTool store at startup and keeps it
current through event-driven re-publishing (with a configurable cooldown).

Supports A, AAAA, CNAME, MX, NS, TXT, PTR, SRV, CAA, SOA over UDP and TCP.

```toml
[[nameserver]]
name = "ns1.example.com."
type = "native"

# Bind UDP and TCP on all interfaces, port 53.
[[nameserver.listen]]
address = "0.0.0.0"
port    = 53
proto   = "udp"

[[nameserver.listen]]
address = "0.0.0.0"
port    = 53
proto   = "tcp"

[nameserver.source]
type = "inherit"   # use the top-level [store]; or override with {type, host, ...}

[nameserver.publisher]
type = "memory"    # required for the native engine

[nameserver.transport]
type     = "noop"
interval = 0       # 0 = event-driven (publish on zone change); >0 = poll interval in seconds
cooldown = 5       # minimum seconds between consecutive publishes (burst protection)
```

Multiple native nameservers can run side-by-side by adding more `[[nameserver]]`
blocks — each gets its own UDP/TCP listener set.

### DNSSEC (native engine)

Attach a signing stage between the publisher and transport. The native engine
has no external signing tool, so `MemorySigner` signs the in-process zone map
directly and `NativeNS` answers with RRSIG, DNSKEY and NSEC when the query
carries the DO bit.

```toml
[nameserver.dnssec]
enabled   = true
algorithm = "ECDSAP256SHA256"
keyset    = "/var/lib/nictool/dnssec/ns1"
nsec3     = false           # NSEC only; the in-process signer has no NSEC3
```

`keyset` is a directory of BIND-format key files — the same
`K<zone>.+<alg>+<tag>.{key,private}` pair `dnssec-keygen` writes, so a zone can
move between this signer and the file signer without re-keying:

```sh
dnssec-keygen -a ECDSAP256SHA256 -K /var/lib/nictool/dnssec/ns1 -n ZONE example.com
dnssec-keygen -a ECDSAP256SHA256 -K /var/lib/nictool/dnssec/ns1 -f KSK -n ZONE example.com
```

NicTool signs with those keys but never generates or rolls them: rollover is an
operational decision, not something a publish cycle should make. Elliptic-curve
algorithms only (`ECDSAP256SHA256`, `ECDSAP384SHA384`, `ED25519`, `ED448`) —
RSA keys are reported as unusable rather than silently skipped.

---

### PowerDNS co-process backend

`nt-powerdns` implements the
[PowerDNS pipe/co-process backend](https://doc.powerdns.com/authoritative/backends/pipe.html)
protocol (v1). PowerDNS forks it and asks a question at a time over
stdin/stdout, and it answers from the NicTool database directly — the pull
alternative to the `powerdns-db` publisher above. Use one or the other.

It ships with **[@nictool/dns-nameserver](https://github.com/NicTool/dns-nameserver)**,
alongside the rest of the PowerDNS integration, and that package's README
documents its environment variables and supported query types.

```ini
launch=pipe
pipe-command=/path/to/node_modules/.bin/nt-powerdns
pipe-abi-version=1
pipe-timeout=2000

# Required from PowerDNS 4.5 on. The pipe backend cannot enumerate zones, so
# the zone cache has nothing to populate from and pdns_server exits at startup
# with "One of the backends does not support zone caching".
zone-cache-refresh-interval=0
```

Verified against PowerDNS Authoritative Server 5.1.3.

Set `NT_PDNS_DB_PASS` and friends in `/etc/default/pdns` (Debian/Ubuntu) so
PowerDNS passes them to the co-process when it forks.

---

## CLI reference

```
nictool-server -c <config-dir>

Options:
  -c, --config <dir>  Path to the NicTool data root (required).
```

---

## Development

```sh
# Install dependencies
npm install

# Run tests
npm test

# Run tests in watch mode
npm run watch

# Check formatting and linting
npm run format:check

# Auto-fix formatting and linting
npm run format
```

---

## License

BSD-3-Clause © [Matt Simerson](https://github.com/msimerson)
