# Builds the tabs-rethink screens: Patch's real sidebar, transcript and
# stylesheet (captured from the dev harness into _sb/_stream/_comp.html and
# real.css), with the proposed tab chrome from tabs.css. Run: python3 build.py
import json, re

SB = open('_sb.html').read()
STREAM = open('_stream.html').read()
COMP = open('_comp.html').read()

def lucide(body, size=16):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" '
            f'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{body}</svg>')
I = {
  'chat': lucide('<path d="M22 17a2 2 0 0 1-2 2H6.83a2 2 0 0 0-1.41.59l-2.2 2.2A.71.71 0 0 1 2 21.29V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>'),
  'term': lucide('<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2"/>'),
  'files': lucide('<path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M3 5a2 2 0 0 0 2 2h3"/><path d="M3 3v13a2 2 0 0 0 2 2h3"/>'),
  'web': lucide('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'),
  'art': lucide('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>'),
  'pad': lucide('<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>'),
  'pen': lucide('<path d="M13 21h8"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>'),
  'more': lucide('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
  'x': lucide('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  'plus': lucide('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  'left': lucide('<path d="m15 18-6-6 6-6"/>'),
  'right': lucide('<path d="m9 18 6-6-6-6"/>'),
  'reload': lucide('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'),
  'ext': lucide('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  'split': lucide('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>'),
  'jobs': lucide('<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>'),
  'gear': lucide('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
}

# ---- sidebar: the real one, with a fuller chat list ----
CHATS = [  # (folder, [(name, badge-class)])
  ('bus', [('bus-watch', 'badge-working')]),
  ('garden', [('garden-podcast', 'badge-done')]),
  ('portfolio', [('foreman server move', 'badge-permission'), ('nightcap live test', 'badge-working'), ('buy store notes', 'badge-done')]),
  ('patch', [('tabs rethink', 'badge-working'), ('artifact signing', 'badge-done')]),
]
def sidebar(active=None, ghost=None, marks=None):
    marks = marks or {}
    s = SB.replace('sb-row special active', 'sb-row special')
    i = s.index('<div class="sb-scroll"'); j = s.index('<div class="sb-lifecycle"')
    folder_tpl = re.search(r'<section class="sb-folder">.*?</section>', s, re.S).group(0)
    head = re.search(r'<div class="folder-head".*?</div>', folder_tpl, re.S).group(0)
    row = re.search(r'<a class="sb-row".*?</a>', folder_tpl, re.S).group(0)
    out = '<div class="sb-scroll">'
    for folder, rows in CHATS:
        out += '<section class="sb-folder">' + head.replace('>bus<', f'>{folder}<')
        for name, badge in rows:
            r = row.replace('title="bus-watch"', f'title="{name}"').replace('>bus-watch<', f'>{name}<')
            r = r.replace('badge badge-working', f'badge {badge}')
            r = r.replace('20753d', {'badge-working': 'now', 'badge-permission': '2m'}.get(badge, '1h'))
            if name == active: r = r.replace('class="sb-row"', 'class="sb-row active"')
            if name == ghost: r = r.replace('class="sb-row"', 'class="sb-row ghost"')
            if name in marks:
                g, n = marks[name]
                r = r.replace(f'<span class="name">{name}</span>', f'<span class="name" style="display:flex;align-items:center;gap:8px">{name}<span class="onscreen {g}">{n}</span></span>', 1)
            out += r
        out += '</section>'
    out += '</div>'
    return s[:i] + out + s[j:]

# ---- tab strip ----

# ---- tab strip: a panel shows one chat; its first tab is the chat itself ----
def tab(kind, title, on=False, g='g1', split=False, badge_cls=None):
    cls = f'ctab in-grp {g}' + (' on' if on else '') + (' split' if split else '') + (' chat' if badge_cls else '')
    fl = '<span class="fl l"></span><span class="fl r"></span>' if on else ''
    lead = f'<span class="badge {badge_cls}"></span>' if badge_cls else I[kind]
    return f'<div class="{cls}">{fl}{lead}<span class="t">{title}</span><span class="x">{I["x"]}</span></div>'
def chat_tab(name, b, on=False, g='g1'): return tab('chat', name, on, g, badge_cls=b)
def strip(*tabs, plus_open=False):
    return '<div class="strip">' + ''.join(tabs) + f'<div class="newtab{" open" if plus_open else ""}">{I["plus"]}</div></div>'

def tools(on=(), iconly=False):
    items = [('term', 'Terminal'), ('files', 'Files'), ('web', 'Browser'), ('pen', 'Editor')]
    h = f'<div class="tools{" iconly" if iconly else ""}">'
    for k, l in items:
        h += f'<span class="tool{" on" if k in on else ""}">{I[k]}<span class="l">{l}</span></span>'
    return h + f'<span class="tool">{I["more"]}</span></div>'
def chat_bar(title, on=(), iconly=False):
    return (f'<div class="bar"><span class="navb">{I["left"]}</span><span class="navb">{I["right"]}</span>'
            f'<span class="ttl">{title}</span><span class="sp"></span>{tools(on, iconly)}</div>')
def addr_bar(title, path, on=(), iconly=False, with_tools=True):
    t = tools(on, iconly) if with_tools else ''
    return (f'<div class="bar"><span class="navb">{I["left"]}</span><span class="navb">{I["right"]}</span><span class="navb">{I["reload"]}</span>'
            f'<span class="addr"><b>{title}</b>{path}</span><span class="navb">{I["ext"]}</span>{t}</div>')

CARD = (f'<button type="button" class="artifact-card">{I["art"]}<span><strong>Departures</strong> · departures.html</span></button>')
def chat_main(stream=STREAM):
    st = stream.replace('</div></section>', CARD + '</div></section>', 1)
    return f'<main class="chat-main"><div class="mm-contents" style="display:contents">{st}{COMP}</div></main>'
GARDEN = (STREAM
  .replace('Can you check whether the 5pm bus watcher actually fired today? It felt quiet.', 'Run the live test against tonight’s build.')
  .replace('Let me look at the watcher\'s run log for today and confirm the 17:00 tick landed.', 'Starting the nightcap run on the Pixel.'))
DEPS = ('<div class="art"><h2>Departures</h2><div class="sub">Broad Walk · next hour</div><div class="dep">'
        + ''.join(f'<div class="tm">{t}</div><div{" class=gap" if g else ""}>{d}</div><div class="r">{m}</div>' for t, d, m, g in [
          ('16:45', '2 · Cribbs Causeway', '4 min', 0), ('16:52', '36 · Withywood', '11 min', 0),
          ('17:00', 'No buses', '', 1), ('17:15', '2 · Cribbs Causeway', '34 min', 0), ('17:30', '36 · Withywood', '49 min', 0)])
        + '</div></div>')
SCRIPT = ('<div class="art"><h2>Episode 12 · Autumn bulbs</h2><div class="sub">script.html · 9 min 40 s</div>'
          '<p style="font-size:15px;line-height:1.7;color:var(--ink-2);max-width:620px">The ground is still warm in October, which is exactly why this is the month for tulips to wait and for daffodils to go in now. Start with the drainage…</p></div>')
def term_lines(p='bus'):
    return (f'<div><span class="p">~/projects/{p}</span> $ systemctl status {p}-watch</div>'
        f'<div class="d">● {p}-watch.service — running since 17:02</div>'
        f'<div><span class="p">~/projects/{p}</span> $ tail -3 runs/today.log</div><div>17:00 tick · 0 in window · silent</div>'
        f'<div>17:15 tick · 1 in window · notified</div><div>17:30 tick · window 45m · 2 in window</div><div><span class="p">~/projects/{p}</span> $ ▌</div>')
def TERM(p='bus'): return f'<div class="term">{term_lines(p)}</div>'
def dock(p='bus'):
    return (f'<div class="dock"><div class="dh">{I["term"]}Terminal<span class="cwd">~/projects/{p}</span><span class="sp"></span>'
            f'<span class="db" title="Move to a tab">{I["ext"]}</span><span class="db" title="Move to its own panel">{I["split"]}</span><span class="db" title="Close">{I["x"]}</span></div>'
            f'<div class="term">{term_lines(p)}</div></div>')
def stack(top, docked=''):
    return f'<div class="stack"><div class="top">{top}</div>{docked}</div>'

def col(strip_html, bar_html, body_html, focus=False, style=''):
    return f'<section class="col{" focus" if focus else ""}" style="{style}">{strip_html}{bar_html}<div class="body">{body_html}</div></section>'
def page(title, side, cols, extra=''):
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{title}</title><link rel="stylesheet" href="real.css"><link rel="stylesheet" href="tabs.css"></head>'
            f'<body><div class="shell">{side}<div class="cols">{cols}</div></div>{extra}'
            '<script>for(const e of document.querySelectorAll(".chat-stream"))e.scrollTop=e.scrollHeight</script></body></html>')

screens = []
def S(id, name, html, width=None):
    open(f'{id}.html', 'w').write(html)
    s = {'id': id, 'name': name, 'path': f'{id}.html'}
    if width: s['width'] = width
    screens.append(s)

# ---- v5: group (one chat) > panes > tabs. Every tab is the same kind of thing. ----
OPEN_BTNS = [('files', 'Files'), ('web', 'Browser'), ('pen', 'Editor'), ('term', 'Terminal')]
def ghead(name, b, on=(), mark=None, iconly=False):
    m = f'<span class="onscreen {mark[0]}">{mark[1]}</span>' if mark else ''
    t = f'<div class="tools{" iconly" if iconly else ""}">' + ''.join(
        f'<span class="tool{" on" if k in on else ""}">{I[k]}<span class="l">{l}</span></span>' for k, l in OPEN_BTNS) + f'<span class="tool">{I["more"]}</span></div>'
    return (f'<div class="ghead"><span class="navb">{I["left"]}</span><span class="navb">{I["right"]}</span>'
            f'<span class="gname"><span class="badge {b}"></span>{name}{m}</span><span class="sp" style="flex:1"></span>{t}</div>')
def pane(tabs, body, cls='', plus_open=False, overlay=''):
    return f'<div class="pane5 {cls}">{strip(*tabs, plus_open=plus_open)}<div class="content">{body}</div>{overlay}</div>'
def row(*kids): return '<div class="split">' + ''.join(kids) + '</div>'
def colm(*kids): return '<div class="split v">' + ''.join(kids) + '</div>'
def gcard(head, layout, focus=False, overlay=''):
    return f'<section class="gcard{" focus" if focus else ""}">{head}<div class="gbody">{layout}</div>{overlay}</section>'
def page5(title, side, groups, extra=''):
    return page(title, side, groups, extra).replace('<div class="cols">', '<div class="cols groups">')

TREE = ('<div class="tree"><div>▾ bus</div><div>&nbsp;&nbsp;&nbsp;▸ runs</div><div class="on">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;watcher.ts</div>'
        '<div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;departures.html</div><div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;config.json</div></div>')
CHAT_T = lambda on=False, g='g1': tab('chat', 'Chat', on, g)
DEP_T = lambda on=False: tab('art', 'Departures', on)
TERM_P = lambda p='bus', g='g1': pane([tab('term', 'Terminal', True, g)], TERM(p), 'short')

# 1 laptop: terminal is a tab, in a pane at the bottom (its default spot)
S('index', 'Laptop · terminal is a tab in a pane at the bottom', page5('Laptop', sidebar('bus-watch'),
  gcard(ghead('bus-watch', 'badge-working', on=('term',)),
        colm(pane([CHAT_T(True), DEP_T()], chat_main()), TERM_P()), focus=True)), 1440)

# 2 laptop: artifact as a tab; Files is a tab too, in a pane on the right
S('artifact', 'Laptop · artifact tab; Files is a tab in a right pane', page5('Artifact', sidebar('bus-watch'),
  gcard(ghead('bus-watch', 'badge-working', on=('files', 'term'), iconly=True),
        colm(row(pane([CHAT_T(), DEP_T(True)], DEPS), pane([tab('files', 'Files', True), tab('web', 'Browser')], TREE, 'narrow')), TERM_P()), focus=True)), 1440)

# 3 wide group: a new artifact opens in its own pane beside the chat
S('wide', 'Wide group · artifact opens in a pane beside the chat', page5('Wide', sidebar('bus-watch'),
  gcard(ghead('bus-watch', 'badge-working', on=('term',)),
        colm(row(pane([CHAT_T(True)], chat_main()), pane([DEP_T(True), tab('files', 'Files')], DEPS)), TERM_P()), focus=True)), 2560)

# 4 several groups
MARKS = {'bus-watch': ('g1', 1), 'garden-podcast': ('g2', 2), 'foreman server move': ('g3', 3)}
S('groups', 'Several groups · one per chat, numbered in the sidebar', page5('Groups', sidebar('foreman server move', marks=MARKS),
  gcard(ghead('bus-watch', 'badge-working', mark=('g1', 1), iconly=True), pane([CHAT_T(True), DEP_T()], chat_main()))
  + gcard(ghead('garden-podcast', 'badge-done', mark=('g2', 2), iconly=True), pane([CHAT_T(g='g2'), tab('art', 'Episode 12', True, 'g2')], SCRIPT))
  + gcard(ghead('foreman server move', 'badge-permission', on=('term',), mark=('g3', 3), iconly=True),
          colm(pane([CHAT_T(True, 'g3')], chat_main(GARDEN)), TERM_P('foreman', 'g3')), focus=True)), 1920)

# 5 sidebar click: the focused group switches chat, with that chat's own layout
S('switch', 'Sidebar click · the focused group switches to that chat', page5('Switch', sidebar('garden-podcast', marks={'garden-podcast': ('g1', 1), 'foreman server move': ('g3', 2)}),
  gcard(ghead('garden-podcast', 'badge-done', mark=('g1', 1), iconly=True), pane([CHAT_T(g='g2'), tab('art', 'Episode 12 script', True, 'g2')], SCRIPT), focus=True)
  + gcard(ghead('foreman server move', 'badge-permission', on=('term',), mark=('g3', 2), iconly=True),
          colm(pane([CHAT_T(True, 'g3')], chat_main(GARDEN)), TERM_P('foreman', 'g3')))), 1920)

# 6 right-click a sidebar row
CTX = (f'<div class="ctxmenu" style="left:200px;top:600px"><div class="i on">{I["chat"]}Open here</div>'
       f'<div class="i">{I["split"]}Open in new group</div><div class="i">{I["ext"]}Open in new window<kbd>⌘ click</kbd></div>'
       f'<hr><div class="i">{I["pen"]}Rename</div><div class="i">{I["more"]}More</div></div>')
S('menu', 'Right-click a chat · here, new group or new window', page5('Menu', sidebar('bus-watch', marks={'bus-watch': ('g1', 1)}),
  gcard(ghead('bus-watch', 'badge-working', mark=('g1', 1)), pane([CHAT_T(True), DEP_T()], chat_main()), focus=True), extra=CTX), 1440)

# 7 dragging a chat from the sidebar
S('drag', 'Drag a chat · onto a group, or into a gap for a new group', page5('Drag', sidebar('bus-watch', ghost='nightcap live test', marks={'bus-watch': ('g1', 1), 'foreman server move': ('g3', 2)}),
  gcard(ghead('bus-watch', 'badge-working', mark=('g1', 1), iconly=True), pane([CHAT_T(True), DEP_T()], chat_main()),
        overlay='<div class="gdrop"><div class="z" style="inset:14px">Show here</div></div>')
  + '<div class="gap-drop hot">New group</div>'
  + gcard(ghead('foreman server move', 'badge-permission', mark=('g3', 2), iconly=True), colm(pane([CHAT_T(True, 'g3')], chat_main(GARDEN)), TERM_P('foreman', 'g3')),
          overlay='<div class="gdrop"><div class="z" style="inset:14px">Show here</div></div>'),
  extra='<div class="dragrow" style="left:1050px;top:420px"><span class="badge badge-working"></span>nightcap live test</div>'), 1920)

# 8 dragging a tab: pane edge splits, pane middle adds a tab, gap makes a new group
DROPS = ('<div class="gdrop" style="inset:38px 0 0 0;background:rgba(255,255,255,.55)">'
         '<div class="z hot" style="top:10px;right:10px;bottom:10px;width:28%">Split right</div>'
         '<div class="z" style="left:10px;right:calc(28% + 20px);top:10px;bottom:10px">Add as tab</div></div>')
S('dragtab', 'Drag a tab · pane edge splits, middle adds a tab, gap makes a group', page5('Drag tab', sidebar('bus-watch', marks={'bus-watch': ('g1', 1), 'foreman server move': ('g3', 2)}),
  gcard(ghead('bus-watch', 'badge-working', mark=('g1', 1), iconly=True), pane([CHAT_T(True), DEP_T()], chat_main(), overlay=DROPS), focus=True)
  + '<div class="gap-drop">New group</div>'
  + gcard(ghead('foreman server move', 'badge-permission', mark=('g3', 2), iconly=True), pane([CHAT_T(True, 'g3')], chat_main(GARDEN))),
  extra='<div class="dragrow" style="left:900px;top:360px">' + I['art'] + 'Departures</div>'), 1920)

# 9 + menu
M = (f'<div class="menu" style="left:520px;top:92px"><input placeholder="Open…"><div class="h">bus-watch</div>'
     f'<div class="i on">{I["term"]}Terminal<kbd>⌃`</kbd></div><div class="i">{I["files"]}Files<kbd>⌥E</kbd></div><div class="i">{I["web"]}Browser</div><div class="i">{I["art"]}Departures</div>'
     f'<div class="h">Chats</div><div class="i"><span class="badge badge-permission"></span>foreman server move</div><div class="i"><span class="badge badge-working"></span>nightcap live test</div>'
     f'<div class="h">Pages</div><div class="i">{I["pad"]}Pads</div><div class="i">{I["jobs"]}Jobs</div><div class="i">{I["gear"]}Settings</div></div>')
S('plus', '+ opens anything as a tab', page5('Plus', sidebar('bus-watch'),
  gcard(ghead('bus-watch', 'badge-working'), pane([CHAT_T(True), DEP_T()], chat_main(), plus_open=True), focus=True), extra=M), 1440)

json.dump({'screens': screens}, open('pad.json', 'w'), indent=1)
print([s['id'] for s in screens])
