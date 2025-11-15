#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:8080}"
ROOT="${ROOT:-ES}"
EXPIRY="${EXPIRY:-}"   # optional override: YYYYMMDD
ATM="${ATM:-6805}"

log() { printf >&2 "[%s] %s\n" "$(date '+%H:%M:%S')" "$*"; }

curl_json() {
  local url="$1"
  local body="" http=""
  body="$(curl -sS -w $'\n%{http_code}' "$url")" || {
    log "curl failed for: $url"
    return 2
  }
  http="${body##*$'\n'}"
  body="${body%$'\n'"$http"}"

  if [[ "$http" != "200" ]]; then
    log "HTTP $http from $url"
    printf >&2 "---- response body ----\n%s\n-----------------------\n" "$body"
    return 2
  fi
  if [[ -z "$body" ]]; then
    log "Empty response from $url"
    return 2
  fi

  # JSON sanity check
  if ! python3 - <<'PY' <<<"$body" >/dev/null 2>&1; then
import sys, json
json.loads(sys.stdin.read())
PY
    log "Non-JSON response from $url"
    return 2
  fi

  printf "%s" "$body"
}

try_post_mdtype() {
  local t="${1:-1}"
  local endpoints=(
    "$API_BASE/api/debug/market-data-type?type=$t"
    "$API_BASE/api/market-data/type?type=$t"
    "$API_BASE/api/debug/md-type?type=$t"
  )
  log "Setting market data type to $t…"
  local e="" out="" http="" body=""
  for e in "${endpoints[@]}"; do
    out="$(curl -sS -X POST -w $'\n%{http_code}' "$e" || true)"
    http="${out##*$'\n'}"
    body="${out%$'\n'"$http"}"
    if [[ "$http" == "200" ]]; then
      log "Market data type set via: ${e#"$API_BASE"}"
      [[ -n "$body" ]] && printf "%s\n" "$body"
      return 0
    fi
    # 404 just means endpoint doesn't exist; keep trying
    if [[ "$http" != "404" ]]; then
      log "MD type POST got HTTP $http at ${e#"$API_BASE"}"
      [[ -n "$body" ]] && printf >&2 "%s\n" "$body"
    fi
  done
  log "No MD-type endpoint found; continuing without it."
  return 0
}

next_friday() {
  python3 - "$@" <<'PY'
import datetime, sys
today = datetime.date.today()
strict = ('--strict' in sys.argv)
days_ahead = 4 - today.weekday()
if days_ahead < 0 or (days_ahead == 0 and strict):
    days_ahead += 7
d = today + datetime.timedelta(days=days_ahead)
print(d.strftime("%Y%m%d"))
PY
}

pick_expiry() {
  # 1) Manual override
  if [[ -n "$EXPIRY" ]]; then
    echo "$EXPIRY"; return 0
  fi

  # 2) Probe likely endpoints
  local candidates=(
    "$API_BASE/api/fop/expiries?root=$ROOT"
    "$API_BASE/api/options/expiries?root=$ROOT"
    "$API_BASE/api/fop/months?root=$ROOT"
  )
  local u="" json="" exp=""
  for u in "${candidates[@]}"; do
    if json="$(curl_json "$u" 2>/dev/null)"; then
      exp="$(python3 - <<'PY' <<<"$json" 2>/dev/null || true
import sys, json, re
try:
    data=json.load(sys.stdin)
    txt=json.dumps(data)
    m=re.findall(r'20\d{6}', txt)  # YYYYMMDD
    print(m[0] if m else(""))
except Exception:
    print("")
PY
)"
      if [[ -n "$exp" ]]; then
        log "Picked expiry $exp from ${u#"$API_BASE"}"
        echo "$exp"
        return 0
      fi
    fi
  done

  # 3) Fallback: next Friday
  local nf=""
  nf="$(next_friday)"
  log "Falling back to next Friday: $nf"
  echo "$nf"
}

subscribe_one() {
  local root="$1" right="$2" strike="$3" expiry="$4"
  curl -sS --fail-with-body -X POST "$API_BASE/api/options/subscribe" \
    -H 'content-type: application/json' \
    -d "{ \"root\":\"$root\", \"expiry\":\"$expiry\", \"right\":\"$right\", \"strike\": $strike }" \
    | jq -r '.ok // .error // "ok"'
}

main() {
  try_post_mdtype 1 || true

  local exp=""
  exp="$(pick_expiry)"
  log "Using expiry: $exp"

  log "Subscribing a small strike ladder around ATM=$ATM…"
  local K R
  for K in $((ATM-10)) $((ATM-5)) $ATM $((ATM+5)) $((ATM+10)); do
    for R in C P; do
      echo "Subscribing $ROOT $R $K $exp"
      subscribe_one "$ROOT" "$R" "$K" "$exp" || true
    done
  done

  log "Live subscriptions:"
  curl -sS --fail-with-body "$API_BASE/api/options/subscriptions" | jq
}

main "$@"
