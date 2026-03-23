#!/usr/bin/env bash
set -euo pipefail

# Unified start script: select runtime (podman or docker) up front and use
# the chosen runtime consistently. This avoids mixing podman/docker commands
# in the same execution path which can cause confusing permission errors.

if command -v podman >/dev/null 2>&1; then
  RUNTIME=podman
elif command -v docker >/dev/null 2>&1; then
  RUNTIME=docker
else
  echo "No podman or docker found" >&2
  exit 1
fi

echo "Using container runtime: $RUNTIME"

run() { $RUNTIME "$@"; }
vol_create() { $RUNTIME volume create "$@" >/dev/null 2>&1 || true; }
ps_filter() { $RUNTIME ps "$@"; }
logs() { $RUNTIME logs "$@"; }
start_container() { $RUNTIME start "$@"; }
exec_in() { $RUNTIME exec "$@"; }

# Create/use a named volume to avoid host-mount issues
vol_create sourcebase-pgdata

if $RUNTIME ps --filter name=sourcebase-postgres --format "{{.Names}}" | grep -q sourcebase-postgres; then
  echo "$RUNTIME container already running"
elif $RUNTIME ps -a --filter name=sourcebase-postgres --format "{{.Names}}" | grep -q sourcebase-postgres; then
  echo "$RUNTIME container exists but not running; starting"
  # If prior initdb complained about non-empty mount, recreate using named volume
  if $RUNTIME logs --tail 50 sourcebase-postgres 2>/dev/null | grep -q "initdb: error: directory \"/var/lib/postgresql/data\" exists but is not empty"; then
    echo "Found prior initdb mount error; recreating with named volume"
    $RUNTIME rm -f sourcebase-postgres || true
    $RUNTIME run -d --name sourcebase-postgres \
      -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=sourcebase \
      -p 5432:5432 -v sourcebase-pgdata:/var/lib/postgresql/data docker.io/pgvector/pgvector:pg15 || true
  else
    start_container sourcebase-postgres || true
  fi
else
  echo "Creating and starting $RUNTIME container"
  $RUNTIME run -d --name sourcebase-postgres \
    -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=sourcebase \
    -p 5432:5432 -v sourcebase-pgdata:/var/lib/postgresql/data docker.io/pgvector/pgvector:pg15 || true
fi

# Wait for Postgres ready
echo "Waiting for Postgres to be available on localhost:5432..."
MAX_WAIT=180
WAITED=0
while true; do
  if bash -c "</dev/tcp/127.0.0.1/5432" >/dev/null 2>&1; then
    echo "Postgres TCP socket open; checking server readiness"
    if $RUNTIME ps --filter name=sourcebase-postgres --format "{{.Names}}" | grep -q sourcebase-postgres; then
      if exec_in sourcebase-postgres pg_isready -U postgres >/dev/null 2>&1; then
        echo "Postgres is accepting connections (pg_isready)"
        break
      else
        echo "pg_isready reports not ready yet"
        echo "--- recent container logs ---"
        logs --tail 30 sourcebase-postgres || true
      fi
    else
      echo "Postgres TCP socket open (no container exec available)"
      break
    fi
  fi

  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    echo "Timed out waiting for Postgres on localhost:5432" >&2
    break
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done

# Load .env for DATABASE_URL (if present), then ensure a sensible default.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Ensure DATABASE_URL environment variable is set for local runs
if [ -z "${DATABASE_URL:-}" ]; then
  export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/sourcebase"
  echo "Set DATABASE_URL to default: $DATABASE_URL"
fi

# If DATABASE_URL points to a non-existent DB, create it automatically so start
# works out-of-the-box in local dev.
if command -v node >/dev/null 2>&1; then
  node - <<'EOF'
const { Client } = require('pg');

function parseDbName(url) {
  try {
    const u = new URL(url);
    return (u.pathname || '').replace(/^\//, '') || 'sourcebase';
  } catch {
    return 'sourcebase';
  }
}

async function ensureDb() {
  const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/sourcebase';
  const desiredDb = parseDbName(dbUrl);

  const base = new URL(dbUrl);
  base.pathname = '/postgres';

  const admin = new Client({ connectionString: base.toString() });
  try {
    await admin.connect();
    const res = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [desiredDb]);
    if (!res.rowCount) {
      console.log(`Creating missing database: ${desiredDb}`);
      await admin.query(`CREATE DATABASE "${desiredDb.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end().catch(() => {});
  }
}

ensureDb().catch((e) => {
  console.error(`Failed ensuring database exists: ${e.message || e}`);
  process.exit(1);
});
EOF
fi

# Wait-for-db helper
if command -v node >/dev/null 2>&1; then
  echo "Waiting for DB (scripts/wait-for-db.js)"
  if ! node ./scripts/wait-for-db.js; then
    echo "Warning: wait-for-db failed or timed out; continuing anyway" >&2
  fi
fi

# Start Qdrant (if not running) using the chosen runtime
if command -v podman >/dev/null 2>&1 || command -v docker >/dev/null 2>&1; then
  echo "Ensuring Qdrant container is running"
  if $RUNTIME ps --filter name=sourcebase-qdrant --format "{{.Names}}" | grep -q sourcebase-qdrant; then
    echo "Qdrant container already running"
  elif $RUNTIME ps -a --filter name=sourcebase-qdrant --format "{{.Names}}" | grep -q sourcebase-qdrant; then
    echo "Qdrant container exists but not running; starting"
    start_container sourcebase-qdrant || true
  else
    echo "Creating and starting Qdrant container"
    $RUNTIME run -d --name sourcebase-qdrant -p 6333:6333 -p 6334:6334 -v sourcebase-qdrant-data:/qdrant/storage docker.io/qdrant/qdrant:v1.13.4 || true
  fi

  # Wait for Qdrant to accept connections on 6333, but avoid blocking if the
  # container exits unexpectedly.
  echo "Checking Qdrant container status"
  CONTAINER_STATUS=$($RUNTIME ps -a --filter name=sourcebase-qdrant --format "{{.Status}}" 2>/dev/null || true)
  if echo "$CONTAINER_STATUS" | grep -q "Exited"; then
    echo "Qdrant container is not running (status: $CONTAINER_STATUS). Skipping wait — check container logs for details."
    if command -v $RUNTIME >/dev/null 2>&1; then
      echo "--- recent Qdrant logs ---"
      $RUNTIME logs sourcebase-qdrant || true
      echo "--- end Qdrant logs ---"
    fi
  else
    echo "Waiting for Qdrant to be available on localhost:6333..."
    ANN_WAIT=120
    ANN_WAITED=0
    while true; do
      if bash -c "</dev/tcp/127.0.0.1/6333" >/dev/null 2>&1; then
        echo "Qdrant TCP socket open"
        break
      fi
      if [ "$ANN_WAITED" -ge "$ANN_WAIT" ]; then
        echo "Timed out waiting for Qdrant on localhost:6333" >&2
        break
      fi
      sleep 1
      ANN_WAITED=$((ANN_WAITED + 1))
    done
  fi
fi

# Run DB migrations (best-effort)
if command -v npm >/dev/null 2>&1; then
  echo "Running DB migrations (npm run db:migrate)"
  if ! npm run db:migrate --silent; then
    echo "db:migrate failed (continuing)" >&2
  else
    echo "db:migrate completed"
  fi
fi