#!/usr/bin/env bash
# Deploy the committed site (HEAD) plus the TV app to Vercel.
#   VERCEL_TOKEN=... scripts/deploy.sh            -> preview deployment (uses DATA_PREFIX test storage)
#   VERCEL_TOKEN=... scripts/deploy.sh production -> production
# Uncommitted changes are NOT deployed: the script exports HEAD with `git archive`.
# Secrets (FAMILY_CODE, BLOB_READ_WRITE_TOKEN) live in the Vercel project's environment variables,
# never in this repo. In Claude Code cloud sessions the token is injected by the network proxy,
# so VERCEL_TOKEN can be left unset there.
set -euo pipefail
TARGET="${1:-preview}"
TEAM="team_cenjY7K67YDYjgScV4l9JjEE"
ROOT="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/tree"
git -C "$ROOT" archive HEAD | tar -x -C "$WORK/tree"
cp "$ROOT/tv-app/dist/first-sounds-tv.apk" "$WORK/tree/tv.apk"
node "$ROOT/scripts/deploy-body.mjs" "$WORK/tree" "$WORK/body.json" "$TARGET"

AUTH=()
if [ -n "${VERCEL_TOKEN:-}" ]; then AUTH=(-H "Authorization: Bearer $VERCEL_TOKEN"); fi
API="https://api.vercel.com"
ID=$(curl -sS -X POST "${AUTH[@]}" -H 'content-type: application/json' --data-binary @"$WORK/body.json" \
  "$API/v13/deployments?teamId=$TEAM&skipAutoDetectionConfirmation=1" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);if(!j.id){console.error(JSON.stringify(j.error||j));process.exit(1)}console.log(j.id)})')
echo "deployment $ID"
for _ in $(seq 1 60); do
  STATE=$(curl -sS "${AUTH[@]}" "$API/v13/deployments/$ID?teamId=$TEAM" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.readyState+" "+(j.alias||[]).join(","))})')
  case "$STATE" in READY*|ERROR*|CANCELED*) echo "$STATE"; break;; esac
  sleep 4
done
