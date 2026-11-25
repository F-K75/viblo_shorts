#!/usr/bin/env bash
# D7: inside the production image (tini as PID 1, Node as its child), terminating Node must also terminate the ffmpeg
# render it spawned. Verified on host PIDs, not assumed from the presence of tini. Two paths:
#   normal: docker stop -> SIGTERM to tini -> forwarded to Node -> shutdown kills ffmpeg and releases the job
#   forced: SIGKILL to the Node process ONLY (from the host; tini and the container are not signalled)
# The image runs with NODE_ENV=test only so that a test Firebase signing key is accepted (renders need a signed-in
# user); process supervision, entrypoint and server code are those of the production image.
set -euo pipefail
IMAGE=${IMAGE:-forge-studio:ci}
WORK=$(mktemp -d)
cleanup() { docker rm -f ff-normal ff-forced >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

# a throwaway RSA key: certs file for the server, a signed ID token for the client (node built-ins only)
TOKEN=$(node -e '
const c = require("crypto"), fs = require("fs");
const { privateKey, publicKey } = c.generateKeyPairSync("rsa", { modulusLength: 2048 });
fs.writeFileSync(process.argv[1] + "/certs.json", JSON.stringify({ ci: publicKey.export({ type: "spki", format: "pem" }) }));
const now = Math.floor(Date.now() / 1000), b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const h = b({ alg: "RS256", kid: "ci" }), p = b({ aud: "forge-ci", iss: "https://securetoken.google.com/forge-ci", sub: "d7-user", iat: now - 5, exp: now + 3600 });
process.stdout.write(h + "." + p + "." + c.createSign("RSA-SHA256").update(h + "." + p).sign(privateKey).toString("base64url"));
' "$WORK")
chmod 755 "$WORK"; chmod 644 "$WORK/certs.json"

host_pids() { docker top "$1" -eo pid,comm | awk -v c="$2" 'NR > 1 && $2 == c { print $1 }'; }
# `ps -p` sees processes of every user (kill -0 would report EPERM for the container's uid as "not alive": a false pass)
alive() { for p in "$@"; do if ps -p "$p" -o pid= >/dev/null 2>&1; then echo "$p"; fi; done; }
# the container's processes belong to another uid than the CI user: signal them as root when sudo is available
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }

run_case() {
  local name=$1 how=$2 port=$3
  echo "== $name: $how"
  docker run -d --name "$name" -p "$port:3000" -v "$WORK":/ci:ro \
    -e NODE_ENV=test -e SESSION_SECRET=$(openssl rand -hex 32) -e STORAGE_BACKEND=json -e CAPTCHA_REQUIRED=false \
    -e FIREBASE_PROJECT_ID=forge-ci -e FIREBASE_CERTS_FILE=/ci/certs.json -e MAX_CONCURRENT_RENDERS=1 -e BACKUP_INTERVAL_HOURS=0 \
    "$IMAGE" >/dev/null
  for i in $(seq 1 60); do curl -fsS "localhost:$port/api/health" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS -X POST "localhost:$port/api/jobs/create" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"type":"render_video","payload":{"title":"d7","duration":60,"resolution":"1080p","beats":[{"text":"d7","start_s":0,"end_s":50}]}}' >/dev/null
  local ff=""
  for i in $(seq 1 60); do ff=$(host_pids "$name" ffmpeg); [ -n "$ff" ] && break; sleep 0.5; done
  test -n "$ff" || { echo "no ffmpeg render started"; docker logs "$name" | tail -5; return 1; }
  local node; node=$(host_pids "$name" node)
  local tini; tini=$(host_pids "$name" tini)
  echo "process tree (host PIDs): tini=$tini node=$node ffmpeg=$ff"
  docker top "$name" -eo pid,ppid,comm
  test -n "$(alive $ff)" || { echo "ffmpeg not observable from the host"; return 1; }
  if [ "$how" = "docker stop (SIGTERM)" ]; then
    docker stop -t 20 "$name" >/dev/null
  else
    as_root kill -KILL $node
  fi
  for i in $(seq 1 30); do [ -z "$(alive $node $ff)" ] && [ "$(docker inspect -f '{{.State.Running}}' "$name")" = false ] && break; sleep 0.5; done
  echo "container: running=$(docker inspect -f '{{.State.Running}}' "$name") exit=$(docker inspect -f '{{.State.ExitCode}}' "$name")"
  local left; left=$(alive $tini $node $ff)
  test -z "$left" || { echo "STILL RUNNING after Node terminated: $left"; ps -o pid,ppid,stat,comm -p $left || true; return 1; }
  echo "$name PASSED: node ($node) and ffmpeg ($ff) are gone; no orphan"
  docker logs "$name" 2>&1 | grep -E 'render_job_released_on_shutdown|SIGTERM received' || true
}
run_case ff-normal "docker stop (SIGTERM)" 3200
run_case ff-forced "SIGKILL to Node only" 3201
echo "D7 PASSED"
