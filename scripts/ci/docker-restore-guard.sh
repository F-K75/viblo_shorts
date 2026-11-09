#!/usr/bin/env bash
# D2: Docker-level test of the J1 restore guard (Track D-1). Uses only throwaway volumes and containers.
#  1. real data in a volume; a snapshot taken with the image's own backup CLI; more data written after it
#  2. a REAL restore inside the container, SIGKILLed mid-swap -> a genuine unfinished-restore journal
#  3. the app container must exit 1 with the refusal message, and must not modify the volume
#  4. `backup recover` rolls back to the data that was live; the app then starts and serves it
set -euo pipefail
IMAGE=${IMAGE:-forge-studio:ci}
VOL=forge-guard-$RANDOM$RANDOM
SECRET=$(openssl rand -hex 32)
FIX=$(cd "$(dirname "$0")" && pwd)/kill-restore-midswap.mts
APP_ENV=(-e SESSION_SECRET=$SECRET -e TRUST_PROXY=none -e STORAGE_BACKEND=json -e CAPTCHA_REQUIRED=false -e BACKUP_INTERVAL_HOURS=0)
cleanup() { docker rm -f guard-app guard-app2 guard-refused >/dev/null 2>&1 || true; docker volume rm -f "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT
fingerprint() { docker run --rm -v "$VOL":/data --entrypoint sh "$IMAGE" -c 'cd /data && find . -type f | LC_ALL=C sort | xargs -r sha256sum'; }
wait_ready() { for i in $(seq 1 60); do curl -fsS "localhost:$1/api/ready" >/dev/null 2>&1 && return 0; sleep 1; done; echo "not ready"; return 1; }

docker volume create "$VOL" >/dev/null
echo "== 1. real data, snapshot, then newer live data"
docker run -d --name guard-app -p 3100:3000 -v "$VOL":/data "${APP_ENV[@]}" "$IMAGE" >/dev/null
wait_ready 3100
TOKEN=$(curl -fsS -X POST localhost:3100/api/auth/guest | sed -E 's/.*"token":"([^"]+)".*/\1/')
curl -fsS -X POST localhost:3100/api/projects -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"title":"in the snapshot"}' >/dev/null
SNAP=$(docker exec guard-app node --import tsx scripts/backup.ts create | sed -nE 's/.*"created": "([^"]+)".*/\1/p')
test -n "$SNAP"
echo "snapshot: $SNAP"
curl -fsS -X POST localhost:3100/api/projects -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"title":"written after the snapshot"}' >/dev/null
docker stop guard-app >/dev/null && docker rm guard-app >/dev/null

echo "== 2. a real restore, SIGKILLed mid-swap"
set +e
# Under tini, as the app runs: with --entrypoint node, Node is the container's PID 1, and the kernel ignores signals a
# namespace's PID 1 sends itself without a handler, SIGKILL included (CI runs 39, 41, 43: the kill was issued, nothing died).
docker run --rm -v "$VOL":/data -v "$FIX":/ci/kill.mts:ro --entrypoint /usr/bin/tini "$IMAGE" -- node --import tsx /ci/kill.mts "$SNAP"
code=$?
set -e
echo "restore exit code: $code (137 = SIGKILL)"
test "$code" = 137
docker run --rm -v "$VOL":/data --entrypoint sh "$IMAGE" -c 'ls -la /data | grep -E "restore-in-progress|pre-restore"'

echo "== 3. the app refuses to start and leaves the volume untouched"
before=$(fingerprint)
set +e
docker run --name guard-refused -v "$VOL":/data "${APP_ENV[@]}" "$IMAGE" >/dev/null 2>&1
code=$?
set -e
docker logs guard-refused 2>&1 | tail -3
echo "app exit code: $code"
test "$code" = 1
docker logs guard-refused 2>&1 | grep -q 'Refusing to start: an interrupted restore'
after=$(fingerprint)
test "$before" = "$after" && echo "volume unchanged by the refused start ($(echo "$before" | wc -l) files, sha256 identical)"

echo "== 4. recover, then the app starts and serves the data that was live"
docker run --rm -v "$VOL":/data --entrypoint node "$IMAGE" --import tsx scripts/backup.ts recover | tee /dev/stderr | grep -q '"state": "rolled-back"'
docker run -d --name guard-app2 -p 3101:3000 -v "$VOL":/data "${APP_ENV[@]}" "$IMAGE" >/dev/null
wait_ready 3101
projects=$(curl -fsS localhost:3101/api/projects -H "authorization: Bearer $TOKEN")
echo "$projects" | grep -q 'written after the snapshot'
echo "$projects" | grep -q 'in the snapshot'
echo "D2 PASSED: journal -> exit 1, volume unchanged -> recover -> started, original data served"
