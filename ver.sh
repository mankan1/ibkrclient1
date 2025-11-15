#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://localhost:8080}"
WS="${WS:-ws://localhost:8080/ws}"
ROOT="${ROOT:-ES}"
DAYS="${DAYS:-7}"         # within N days to expiry
ATM_WINDOW="${ATM_WINDOW:-30}"  # +/- window around ATM (points)
STEP="${STEP:-5}"         # strike step
TAIL_SECS="${TAIL_SECS:-30}"

say() { printf "\n\033[1m%s\033[0m\n" "$*"; }

req() { # curl wrapper: args... ; prints body; returns curl exit if non-2xx
  curl -fsS "$@"
}

# ---------- 0) Quick health check ----------
say "Ping months endpoint…"
RAW_MONTHS="$(req "$BASE/api/debug/months?root=$ROOT" || true)"
if [[ -z "${RAW_MONTHS:-}" ]]; then
  echo "ERROR: empty response from /api/debug/months?root=$ROOT"
  exit 1
fi

# Verify it looks like JSON
if ! python3 - <<'PY' >/dev/null 2>&1 <<<"$RAW_MONTHS"
import sys, json; json.loads(sys.stdin.read())
PY
then
  echo "ERROR: months returned non-JSON:"
  echo "$RAW_MONTHS"
  exit 1
fi

# ---------- 1) Real-time market data ----------
say "Setting market data type to REAL-TIME (1)…"
req -X POST "$BASE/api/debug/mdtype" \
  -H 'content-type: application/json' \
  -d '{"type":1}'

# ---------- 2) Pick nearest futures month and subscribe it ----------
say "Picking nearest $ROOT month…"
YYYYMM="$(
  python3 - "$@" <<'PY' <<<"$RAW_MONTHS"
import sys,json
j=json.load(sys.stdin)
items=j.get("items",[])
if not items:
    print("") ; raise SystemExit(0)
# Prefer the first (already front) entry
print(items[0].get("yyyymm",""))
PY
)"
if [[ -z "$YYYYMM" ]]; then
  echo "ERROR: could not pick a month from /api/debug/months payload:"
  echo "$RAW_MONTHS"
  exit 1
fi
echo "Using month: $YYYYMM"

say "Subscribing future $ROOT $YYYYMM (to seed UL price)…"
req "$BASE/api/debug/subscribe-future?yyyymm=$YYYYMM" | cat

# ---------- 3) Get UL price ----------
say "Fetching current $ROOT UL price…"
PRICES_JSON="$(req "$BASE/prices?symbols=$ROOT" || true)"
if [[ -z "${PRICES_JSON:-}" ]]; then
  echo "ERROR: empty response from /prices?symbols=$ROOT"
  exit 1
fi
ULPX="$(
  python3 - "$@" <<'PY' <<<"$PRICES_JSON"
import sys,json
j=json.load(sys.stdin)
rows=j.get("rows",[])
print(rows[0]["last"] if rows and "last" in rows[0] else "")
PY
)"
if [[ -z "$ULPX" ]]; then
  echo "ERROR: UL price missing. Raw /prices payload:"
  echo "$PRICES_JSON"
  exit 1
fi
echo "UL price: $ULPX"

# ---------- 4) Subscribe ~25 options around ATM within DAYS ----------
say "Subscribing ~25 options (±$ATM_WINDOW, step $STEP), within $DAYS days…"
SUB_JSON="$(
  req -X POST "$BASE/api/options/subscribe_batch" \
    -H 'content-type: application/json' \
    -d "{
          \"root\":\"$ROOT\",
          \"days\":$DAYS,
          \"rights\":[\"C\",\"P\"],
          \"atmWindow\":$ATM_WINDOW,
          \"step\":$STEP,
          \"ul\": $ULPX
        }" || true
)"
if [[ -z "${SUB_JSON:-}" ]]; then
  echo "ERROR: empty response from subscribe_batch"
  exit 1
fi
echo "$SUB_JSON" | sed -e 's/{"/{\n"/g' -e 's/,"/,\n"/g'

# Optional: show how many items were actually added
python3 - "$@" <<'PY' <<<"$SUB_JSON" || true
import sys,json
try:
    j=json.load(sys.stdin)
    print(f"\nAdded: {j.get('added')}  Skipped: {j.get('skipped')}")
    print(f"Expiry: {j.get('expiry')}  Rights: {j.get('rights')}")
    print(f"ATM: {j.get('atm')}  Window: {j.get('window')}")
except Exception as e:
    pass
PY

# ---------- 5) Tail WS for a while ----------
say "Tailing WS (topic=option_quotes) for ${TAIL_SECS}s…"
if command -v timeout >/dev/null 2>&1; then
  timeout "${TAIL_SECS}s" npx --yes wscat -c "$WS" | grep -E '"topic":"option_quotes"' || true
else
  echo "Note: 'timeout' not found; press Ctrl-C to stop."
  npx --yes wscat -c "$WS" | grep -E '"topic":"option_quotes"'
fi

say "Done."
