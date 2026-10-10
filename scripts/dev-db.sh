#!/usr/bin/env bash
# Start or stop a throwaway local Postgres for development and tests.
#
#   scripts/dev-db.sh start   # prints the TEST_DATABASE_URL to export
#   scripts/dev-db.sh stop
#
# Uses the PostgreSQL server binaries on this machine (no Docker needed).
# Postgres refuses to run as root; when run as root, set PG_RUN_AS to an
# unprivileged user name.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/.tmp/pg/data"
SOCK="$ROOT/.tmp/pg/sock"
PORT="${PG_PORT:-54329}"
BIN="$(pg_config --bindir)"

as_owner() {
  if [ "$(id -u)" = "0" ]; then
    : "${PG_RUN_AS:?Postgres will not run as root; set PG_RUN_AS to an unprivileged user}"
    runuser -u "$PG_RUN_AS" -- "$@"
  else
    "$@"
  fi
}

case "${1:-}" in
  start)
    mkdir -p "$DATA" "$SOCK"
    if [ "$(id -u)" = "0" ]; then chown -R "$PG_RUN_AS" "$ROOT/.tmp/pg"; fi
    if [ ! -f "$DATA/PG_VERSION" ]; then
      as_owner "$BIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 >/dev/null
    fi
    as_owner "$BIN/pg_ctl" -D "$DATA" -l "$ROOT/.tmp/pg/server.log" -w \
      -o "-k $SOCK -p $PORT -c listen_addresses=''" start >/dev/null
    echo "export TEST_DATABASE_URL='host=$SOCK port=$PORT user=postgres dbname=postgres'"
    ;;
  stop)
    as_owner "$BIN/pg_ctl" -D "$DATA" -w stop >/dev/null && echo "stopped"
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
