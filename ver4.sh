#!/usr/bin/env bash
set -euo pipefail

API_BASE="http://localhost:8080"
ROOT="ES"
EXPIRY="20251114"   # adjust as needed
ATM=6805

log() { printf >&2 "[%s] %s\n" "$(date '+%H:%M:%S')" "$*"; }

curl_json() {
  local url="$1"
  local body http
  # capture body and HTTP code separately
  body="$(curl -sS --fail-with-body -w '\n%{http_code}' "$url")" || {
    log "curl failed for: $url"
    exit 1
  }
  http="${body##*$'\n'}"
  body="${body%$'\n'"$http"}"

  if [[ "$http" != "200" ]]; then
    log "HTTP $http from $url"
    printf >&2 "---- response body ----\n%s\n-----------------------\n" "$body"
    exit 1
  fi
  if [[ -z "$body" ]]; then
    log "Empty response from $url"
    exit 1
  fi

  # sanity check it's JSON
  python3 - <<'PY' <<<"$body" || {
import sys, json
try:
    json.loads(sys.stdin.read())
    print("OK")
except Exception as e:
    print(f"JSON validation failed: {e}", file=sys.stderr)
    sys.exit(1)
PY
    log "Non-JSON response from $url"
    printf >&2 "---- response body ----\n%s\n-----------------------\n" "$body"
    exit 1
  }

  # echo valid JSON to stdout for downstream use
  printf "%s" "$body"
}

log "Setting market data type to 1…"
curl -sS --fail-with-body -X POST "$API_BASE/api/debug/market-data-type?type=1" -H 'content-type: application/json' || {
  log "Failed to set market data type"
  exit 1
}
printf '{"ok":true,"type":1}\n'

log "Fetching ES months/expiries…"
# UPDATE this path to your actual endpoint that returns expiries/months JSON
MONTHS_JSON="$(curl_json "$API_BASE/api/fop/expiries?root=$ROOT")"
log "Got expiries: $(echo "$MONTHS_JSON" | jq -c '.')"

# If you prefer Python to parse/use it, do it *after* validation:
python3 - <<PY <<<"$MONTHS_JSON"
import sys, json
data = json.load(sys.stdin)
# pick one expiry if needed; here we just print a list:
print("Expiries:", data)
PY

log "Subscribing a small strike ladder…"
for K in $((ATM-10)) $((ATM-5)) $ATM $((ATM+5)) $((ATM+10)); do
  for R in C P; do
    echo "Subscribing $ROOT $R $K $EXPIRY"
    curl -sS --fail-with-body -X POST "$API_BASE/api/options/subscribe" \
      -H 'content-type: application/json' \
      -d "{ \"root\":\"$ROOT\", \"expiry\":\"$EXPIRY\", \"right\":\"$R\", \"strike\": $K }" \
    | jq -r '.ok // .error'
  done
done

log "Live subscriptions:"
curl -sS --fail-with-body "$API_BASE/api/options/subscriptions" | jq
