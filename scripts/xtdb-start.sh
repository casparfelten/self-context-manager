#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XTDB_DIR="$ROOT/xtdb"
DATA_DIR="$ROOT/data"
PID_FILE="$XTDB_DIR/xtdb.pid"
LOG_FILE="$XTDB_DIR/xtdb.log"
PORT="${XTDB_PORT:-3000}"
mkdir -p "$XTDB_DIR" "$DATA_DIR"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "XTDB already running with pid $(cat "$PID_FILE")"
  exit 0
fi

# Use pre-built standalone JAR from GitHub releases (includes RocksDB for persistence)
XTDB_JAR="$XTDB_DIR/xtdb-standalone-rocksdb.jar"
XTDB_VERSION="1.24.3"
if [[ ! -f "$XTDB_JAR" ]]; then
  echo "Downloading XTDB standalone v${XTDB_VERSION}..."
  curl -fsSL -o "$XTDB_JAR" \
    "https://github.com/xtdb/xtdb/releases/download/${XTDB_VERSION}/xtdb-standalone-rocksdb.jar"
fi

# Write XTDB config (HTTP server on configured port, RocksDB storage in data/)
XTDB_EDN="$XTDB_DIR/xtdb.edn"
cat > "$XTDB_EDN" <<EOF
{:xtdb.http-server/server {:port ${PORT}}
 :xtdb/index-store {:kv-store {:xtdb/module xtdb.rocksdb/->kv-store
                                :db-dir "${DATA_DIR}/idx"}}
 :xtdb/document-store {:kv-store {:xtdb/module xtdb.rocksdb/->kv-store
                                   :db-dir "${DATA_DIR}/docs"}}
 :xtdb/tx-log {:kv-store {:xtdb/module xtdb.rocksdb/->kv-store
                           :db-dir "${DATA_DIR}/txs"}}}
EOF

java -jar "$XTDB_JAR" -f "$XTDB_EDN" > "$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"

# Wait for XTDB to become ready
for i in {1..60}; do
  if curl -fsS "http://127.0.0.1:${PORT}/_xtdb/status" >/dev/null 2>&1; then
    echo "XTDB ready on port ${PORT} (pid $PID)"
    exit 0
  fi
  sleep 0.5
done

echo "XTDB failed to become ready within 30s. Last log lines:" >&2
tail -n 50 "$LOG_FILE" >&2 || true
kill "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
exit 1
