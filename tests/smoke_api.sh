#!/usr/bin/env bash
# Boots the built dashboard and checks the endpoints answer. No credits spent:
# every route here is read-only.
#
#   npm --prefix dashboard run build && bash tests/smoke_api.sh
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-4399}
lsof -ti :$PORT | xargs -r kill -9 2>/dev/null
PORT=$PORT node dashboard/dist/server/entry.mjs >/tmp/tt-smoke.log 2>&1 &
SERVER=$!
trap 'kill -9 $SERVER 2>/dev/null' EXIT

for _ in $(seq 1 30); do
  curl -sf "localhost:$PORT/api/stats" >/dev/null && break
  sleep 0.5
done

fail=0
check() {                       # check <path> <jq-ish grep> <label>
  local body status
  body=$(curl -s "localhost:$PORT$1")
  status=$(curl -s -o /dev/null -w '%{http_code}' "localhost:$PORT$1")
  if [[ "$status" == "200" && "$body" == *"$2"* ]]; then
    echo "  ok   $3"
  else
    echo "  FAIL $3 (HTTP $status)"
    fail=1
  fi
}

echo "smoke test de la API:"
check "/api/stats"            '"total"'        "estadísticas"
check "/api/leads?limit=1"    '"leads"'        "listado de leads"
check "/api/jobs?limit=1"     '"queue"'        "cola de trabajos"
check "/api/magnific-models"  '"models"'       "catálogo de modelos"
check "/api/gallery?limit=1"  '"items"'        "galería"
check "/api/disk?days=3650"   '"report"'       "informe de disco"

# the QC gate and the budget guard must refuse, not crash
resp=$(curl -s -X POST "localhost:$PORT/api/generate" -H 'Content-Type: application/json' \
  -d '{"lead_id":1,"pages":[1],"pdf_slug":"x","model":"gpt-2","resolution":"2k","quality":"high",
       "styles":[{"id":"editorial","name":"E","prompt":"p"}]}')
if [[ "$resp" == *"credits_per_image"* || "$resp" == *"job_ids"* ]]; then
  echo "  ok   presupuesto evaluado antes de lanzar"
else
  echo "  FAIL el guardarraíl de presupuesto no respondió: $resp"
  fail=1
fi

[[ $fail == 0 ]] && echo "todo verde" || echo "hubo fallos"
exit $fail
