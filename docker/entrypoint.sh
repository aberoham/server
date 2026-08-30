#!/bin/sh
set -eu

config_dir="${NICTOOL_CONFIG_DIR:-/data}"
export NICTOOL_CONFIG_DIR="$config_dir"

node docker/write-config.js
npm run build

exec node bin/start.js -c "$config_dir"
