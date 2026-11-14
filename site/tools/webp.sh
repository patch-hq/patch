#!/bin/sh
# Turn capture.mjs's PNGs and recordings into what the page uses.
#   site/tools/webp.sh <capture-dir> site
# Stills go to site/img as .webp (desktop 1600px wide, phone 860px); clips and
# their posters go to site/vid. Names missing from <capture-dir> are skipped,
# so a partial capture updates just what it took.
set -eu
src=$1
out=$2
mkdir -p "$out/img" "$out/vid"
for name in accounts machines status prompts threads models move queued artifact; do
  for theme in light dark; do
    [ -f "$src/$name-$theme.png" ] && cwebp -quiet -q 84 -resize 1600 0 "$src/$name-$theme.png" -o "$out/img/$name-$theme.webp"
    [ -f "$src/$name-phone-$theme.png" ] && cwebp -quiet -q 84 -resize 860 0 "$src/$name-phone-$theme.png" -o "$out/img/$name-phone-$theme.webp"
  done
done
for name in switch pad jobs panes; do
  for theme in light dark; do
    for v in "$name-$theme" "$name-$theme-phone"; do
      for ext in webm mp4; do
        [ -f "$src/vid/$v.$ext" ] && cp "$src/vid/$v.$ext" "$out/vid/"
      done
      [ -f "$src/vid/$v-poster.jpg" ] && cwebp -quiet -q 80 "$src/vid/$v-poster.jpg" -o "$out/vid/$v-poster.webp"
    done
  done
done
true
