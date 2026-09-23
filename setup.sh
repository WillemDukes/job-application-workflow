#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js 20+ is required. Install it from https://nodejs.org"
    exit 1
fi

exec node setup.mjs "$@"
