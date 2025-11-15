#!/usr/bin/env bash
set -Eeuo pipefail

# ===== Config =====
BASE_URL="${BASE_URL:-http://localhost:8080}"
ROOT="${ROOT:-ES}"
RIGHTS=("C" "P")            # CALL/PUT
OFFSETS=(-10 -5 0 5 10)     # strikes around ATM (ES uses 5-pt increments)
EXPIRY="${1-}"              # required arg (e.g., 20251114)

die() { echo "ERROR: $*" >&2; exit 1; }
info() { printf '[%s] %s\n' "$(date +%T)" "$*"; }

[[ -n "$EXPIRY" ]] || die "Usage: $0 YYYYMMDD  (e.g., $0 20251114)"

# ===== Try to set Market Data Type (best-effort) =====
set_mdtype() {
  local body='{"type":1}'
  local candidates=(
    "/api/debug/market-data-type"
    "/api/debug/market_data_type"
    "/api/debug/set-market-data-type"
    "/api/debug/set_market_data_type"
  )
  info "Setting market data type to 1…"
  for path in "${candidates[@]}"; do
    if curl -sS -X POST --fail-with-body \
         -H 'content-type: application/json' \
         -d "$body" \
         "$BASE_URL$path" >/dev/null 2>&1; then
      info "Market data type set via $path"
      return 0
    fi
  done
  info "Could not set market data type (continuing anyway)."
}
set_mdtype

# ===== Determine ATM =====
ATM="${ATM:-}"
if [[ -z "$ATM" ]]; then
  info "Fetching last price for ${ROOT} to compute ATM…"
  price_json="$(curl -sS --fail-with-body "$BASE_URL/prices?symbols=${ROOT}")" \
    || die "Failed to fetch prices from $BASE_URL"
  # Robustly parse JSON with Python (no jq)
  last_px="$(
python3 - "$ROOT" <<'PY' || true
import json, sys
sym = sys.argv[1]
data = json.loads(sys.stdin.read() or "null")
# Expect: { "rows": [ { "symbol": "ES", "last": 6720.32, ... }, ... ] }
for row in (data or {}).get("rows", []):
    if row.get("symbol") == sym:
        v = row.get("last")
        if v is not None:
            print(v)
            break
PY
  <<<"$price_json"
  )"
  [[ -n "${last_px}" ]] || die "Could not parse last price for ${ROOT}. Raw: $price_json"

  # Round LAST to nearest 5 (ES strikes)
  ATM="$(
python3 - "$last_px" <<'PY'
import math, sys
lp = float(sys.argv[1])
print(int(round(lp/5.0)*5))
PY
  )"
  info "Detected LAST=${last_px}, using ATM=${ATM}"
else
  info "Using provided ATM=${ATM}"
fi

# ===== Subscribe strikes around ATM =====
subscribe_one() {
  local root="$1" expiry="$2" right="$3" strike="$4"
  # Build JSON manually (no jq)
  local payload
  payload=$(cat <<JSON
{"root":"$root","expiry":"$expiry","right":"$right","strike":$strike}
JSON
)
  curl -sS -X POST --fail-with-body \
    -H 'content-type: application/json' \
    -d "$payload" \
    "$BASE_URL/api/options/subscribe"
}

info "Subscribing ${ROOT} options around ATM=${ATM} for expiry ${EXPIRY}…"
for off in "${OFFSETS[@]}"; do
  strike=$(( ATM + off ))
  for right in "${RIGHTS[@]}"; do
    info "Subscribe ${ROOT} ${right} ${strike} ${EXPIRY}"
    if ! subscribe_one "$ROOT" "$EXPIRY" "$right" "$strike" >/dev/null; then
      echo "WARN: subscribe failed for ${ROOT} ${right} ${strike} ${EXPIRY}" >&2
    fi
  done
done

# ===== Show what's live (raw text, still jq-free) =====
info "Current option subscriptions (raw):"
curl -sS --fail-with-body "$BASE_URL/api/options/subscriptions" || echo "{}"
echo

