#!/bin/sh
#
# Container entrypoint.
#
# Bootstrap first, then hand the process over to the server with exec, so the
# app is PID 1 and receives Docker's stop signals directly. Without exec, the
# shell stays PID 1, swallows SIGTERM, and every restart waits out the full
# 10-second kill timeout.
#
# A failed bootstrap stops the container rather than starting an app against a
# half-migrated database.

set -e

if [ "${SKIP_BOOTSTRAP:-}" = "1" ]; then
  echo "[entrypoint] SKIP_BOOTSTRAP=1 — starting without migrating or seeding"
else
  node /app/bootstrap.mjs
fi

exec node server.js
