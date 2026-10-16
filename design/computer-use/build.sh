#!/bin/sh
# index.html / settings.html = snapshots of the real Patch web UI (base*.html) + this design's overlay
cd "$(dirname "$0")"
python3 - <<'P'
css=open('overlay.css').read(); js=open('overlay.js').read()
for src,out in (('base.html','index.html'),('base-settings.html','settings.html')):
    b=open(src).read(); i=b.rindex('</body>')
    open(out,'w').write(b[:i]+'<style>'+css+'</style><script>'+js+'</script>'+b[i:])
P
