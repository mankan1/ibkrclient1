#!/usr/bin/env bash
set -Eeuo pipefail

# ===== Config =====
BASE_URL="${BASE_URL:-http://localhost:8080}"
ROOT="${ROOT:-ES}"
RIGHTS=("C" "P")            # CALL/PUT
OFFSETS=(-10 -5 0 5 10)     # strikes around ATM (ES uses 5-pt increments)
EXPIRY="${1-}"              # required arg (e.g., 20251114)

jq_ok() { command -v jq >/dev/null 2>&1; }

die() { echo "ERROR: $*" >&2; exit 1; }

info() { printf '[%s] %s\n' "$(date +%T)" "$*"; }

# ===== Pre-flight =====
[[ -n "$EXPIRY" ]] || die "Usage: $0 YYYYMMDD  (e.g., $0 20251114)"

jq_ok || die "Please install 'jq' first."

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
if [[ -z "${ATM}" ]]; then
  info "Fetching last price for ${ROOT} to compute ATM…"
  # Expecting your server to expose: /prices?symbols=ES  -> { rows:[{symbol:"ES", last: 6720.32, ...}] }
  price_json="$(curl -sS --fail-with-body "$BASE_URL/prices?symbols=${ROOT}")" || die "Failed to fetch prices from $BASE_URL"
  last_px="$(printf '%s' "$price_json" | jq -r '.rows[] | select(.symbol=="'"$ROOT"'") | .last' 2>/dev/null || echo "")"
  [[ -n "$last_px" && "$last_px" != "null" ]] || die "Could not parse last price for ${ROOT} from: $price_json"

  # Round to nearest 5 for ES options
  # bash math: nearest5 = round(last/5)*5
  ATM="$(python3 - <<'PY'
import math, os
lp=float(os.environ["LAST"])
print(int(round(lp/5.0)*5))
PY
  LAST="$last_px"
  )"
  info "Detected LAST=${last_px}, using ATM=${ATM}"
else
  info "Using provided ATM=${ATM}"
fi

# ===== Subscribe strikes around ATM =====
subscribe_one() {
  local root="$1" expiry="$2" right="$3" strike="$4"
  local payload
  payload=$(jq -n --arg r "$root" --arg e "$expiry" --arg rt "$right" --argjson k "$strike" \
      '{root:$r, expiry:$e, right:$rt, strike:$k}')
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

# ===== Show what's live =====
info "Current option subscriptions:"
subs="$(curl -sS --fail-with-body "$BASE_URL/api/options/subscriptions" || echo '{}')"
if jq_ok; then
  echo "$subs" | jq .
else
  echo "$subs"
fi

