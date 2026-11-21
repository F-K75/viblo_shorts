#!/bin/sh
# Test stand-in for yt-dlp: records its arguments and writes a real MP4 of the requested section length
# (test pattern + real synthesised speech from the test talk), or fails like YouTube's bot check when FAKE_YTDLP_FAIL=1.
[ -n "$FAKE_YTDLP_ARGS" ] && printf '%s\n' "$@" > "$FAKE_YTDLP_ARGS"
if [ "$FAKE_YTDLP_FAIL" = "1" ]; then
  echo "ERROR: [youtube] abc: Sign in to confirm you're not a bot. See /home/someone/secret/cookies.txt" >&2
  exit 1
fi
out=""; sec=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    --download-sections) sec="$2"; shift ;;
  esac
  shift
done
range=${sec#\*}
dur=$(echo "$range" | awk -F- '{ printf "%.2f", $2 - $1 }')
file=$(printf '%s' "$out" | sed 's/%(ext)s/mp4/')
exec ffmpeg -nostdin -v error -y -f lavfi -i "testsrc2=s=1280x720:r=30:d=$dur" -f lavfi -i "flite=textfile='$(dirname "$0")/talk.txt':voice=slt,aloop=loop=-1:size=2147483647,atrim=0:$dur,aresample=48000" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "$file"
