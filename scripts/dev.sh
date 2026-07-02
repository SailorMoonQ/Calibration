#!/usr/bin/env bash
# Dev convenience wrapper. Starts Python venv if missing, then runs `npm run dev`,
# which concurrently launches Vite + Electron. Electron spawns the Python sidecar itself.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d backend/.venv ]]; then
  echo "[dev] creating Python venv at backend/.venv"
  python3 -m venv backend/.venv
  ./backend/.venv/bin/pip install -U pip
fi

REQ_STAMP="backend/.venv/.requirements.sha256"
REQ_HASH="$(sha256sum backend/requirements.txt | awk '{print $1}')"
if [[ ! -f "$REQ_STAMP" ]] || [[ "$(cat "$REQ_STAMP")" != "$REQ_HASH" ]]; then
  echo "[dev] installing Python requirements"
  ./backend/.venv/bin/pip install -r backend/requirements.txt
  printf '%s\n' "$REQ_HASH" > "$REQ_STAMP"
fi

export CALIB_PYTHON="$ROOT/backend/.venv/bin/python"

if [[ ! -d node_modules ]]; then
  echo "[dev] installing node modules"
  npm install
fi

exec npm run dev
