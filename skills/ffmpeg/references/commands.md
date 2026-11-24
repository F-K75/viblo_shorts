# Approved FFmpeg Command Patterns

All commands in Forge Studio are constructed as `string[]` arrays by `FfmpegCommandBuilder` (`server/media_engine/commandBuilder.ts`) and executed with `child_process.spawn(..., { shell: false })`, `-nostdin`, and `-protocol_whitelist file,pipe`.

## 1. Media Inspection (`MediaProbe`)
```bash
ffprobe -v error -protocol_whitelist file,pipe -show_format -show_streams -of json /authorized/path/asset.mp4
```

## 2. Vertical 9:16 Conversion (`buildConvertVertical`)
```bash
ffmpeg -nostdin -y -threads 2 -protocol_whitelist file,pipe -i input.mp4 \
  -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1" \
  -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart output.mp4
```

## 3. Exact Timestamp Trim (`buildTrimVideo`)
```bash
ffmpeg -nostdin -y -threads 2 -protocol_whitelist file,pipe -ss 5.000 -i input.mp4 -t 10.000 \
  -c:v libx264 -preset fast -pix_fmt yuv420p -c:a aac -movflags +faststart output.mp4
```

## 4. Audio Extraction (`buildExtractAudio`)
```bash
ffmpeg -nostdin -y -threads 2 -protocol_whitelist file,pipe -i input.mp4 -vn -acodec libmp3lame -q:a 2 output.mp3
```

## 5. Subtitle Burn-In (`buildBurnSubtitles`)
```bash
ffmpeg -nostdin -y -threads 2 -protocol_whitelist file,pipe -i input.mp4 \
  -vf "subtitles=filename='/staging/captions.srt':fontsdir='/app/assets/fonts'" \
  -c:v libx264 -preset fast -pix_fmt yuv420p -c:a copy -movflags +faststart output.mp4
```

## 6. Loudness Normalization (`buildNormalizeAudio`)
```bash
ffmpeg -nostdin -y -threads 2 -protocol_whitelist file,pipe -i input.mp4 \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11" -c:v copy -c:a aac -b:a 192k output.mp4
```

## 7. Thumbnail Generation (`buildThumbnail`)
```bash
ffmpeg -nostdin -y -threads 2 -protocol_whitelist file,pipe -ss 3.000 -i input.mp4 -frames:v 1 -q:v 2 -update 1 thumbnail.jpg
```

## 8. Video Fade In/Out (`buildFadeVideo`)
```bash
ffmpeg -nostdin -y -threads 2 -protocol_whitelist file,pipe -i input.mp4 \
  -vf "fade=t=in:st=0:d=1.000,fade=t=out:st=9.000:d=1.000" \
  -c:v libx264 -preset fast -pix_fmt yuv420p -c:a copy -movflags +faststart output.mp4
```
