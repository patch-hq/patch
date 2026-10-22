# Builds the v4 mockup screens into the real Patch shell (sidebar + pane captured from the web app).
import json
shell = open('shell.html').read()
def svg(d): return f'<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{d}</svg>'
I = dict(
 clip=svg('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
 pen=svg('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>'),
 mic=svg('<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>'),
 phone=svg('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>'),
 wave=svg('<path d="M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3"/>'),
 send=svg('<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>'),
 copy=svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
 regen=svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
 more=svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
 edit=svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/>'),
 box=svg('<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>'),
 cog=svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
)
TITLE = 'Termin deployment kickoff'
PPL = 'Tom · Amit · Jan · 1 unknown'

def head(): return f'<header class="head"><span class="nav">‹ ›</span><h1>{TITLE}</h1><span class="ic">{I["edit"]}{I["box"]}{I["more"]}</span></header>'
def composer(mode, live):
    return f'''<div class="comp"><div class="box"><span class="ph">Ask about the meeting…</span></div>
<div class="tools"><span class="t">{I["clip"]}</span><span class="t">{I["pen"]}</span><span class="t">{I["mic"]}</span><span class="t">{I["phone"]}</span><span class="t{' hot' if live else ''}" title="Meeting">{I["wave"]}</span>
<span class="dd">Bypass permissions ▾</span><span class="dd">Claude Opus ▾</span><span class="sp"></span><span class="t">{I["send"]}</span></div></div>'''

CHAT = '''<div class="msg u">who owns the registry integration</div>
<div class="msg a">Nobody yet. Amit said Alex is building the integrated function it depends on, so it can't start until that lands. I've added "find an owner for registry integration" to your actions.</div>
<div class="msg u">what time is 12 IST for us</div>
<div class="msg a">07:30 BST now, 06:30 once the clocks go back on 25 October.</div>'''

def chat(mode, live): return f'<div class="chat">{head()}<main class="stream"><div class="col">{CHAT}</div></main>{composer(mode, live)}</div>'

def side_head(live, tab, counts):
    if live: top = f'<span class="pill"><span class="dot"></span>28:41</span><span class="ppl">{PPL}</span><button class="btn">Pause</button><a class="btn end" href="after.html">End</a>'
    else: top = f'<span class="pill done">Ended · 48 min</span><span class="ppl">{PPL}</span><a class="btn" href="live.html">Resume</a>'
    top += f'<a class="ib{" on" if tab == "Settings" else ""}" title="Settings" href="settings.html">{I["cog"]}</a>'
    names = [('Notes', None), ('My notes', None), ('Actions', counts), ('Transcript', None)]
    files = {'Notes': 'live.html' if live else 'after.html', 'My notes': 'live-mynotes.html' if live else 'after-mynotes.html', 'Actions': 'actions.html' if live else 'after-actions.html', 'Transcript': 'live-transcript.html' if live else 'transcript.html'}
    t = ''.join(f'<a class="{"on" if n==tab else ""}" href="{files[n]}">{n}{f"<b>{c}</b>" if c else ""}</a>' for n, c in names)
    return f'<div class="sh">{top}</div><nav class="tabs">{t}</nav>'

def res(q, verdict, body, src, cls=''):
    return f'<div class="res"><div class="h"><span class="q">{q}</span><span class="verdict {cls}">{verdict}</span></div><div class="b">{body}</div><div class="src">{src}</div></div>'

NOTES = (
 '<div class="pt"><span class="tm">00:08</span><div class="c"><span class="who">Tom:</span> no new cluster; the app builds on the existing product framework</div></div>'
 '<div class="pt"><span class="tm">01:12</span><div class="c"><span class="who">Tom:</span> Termin\'s monitoring lives in the Platform org in Datadog</div></div>'
 '<div class="pt"><span class="tm">02:18</span><div class="c"><span class="who">Amit:</span> first task is a proposal for how the app gets deployed<ul><li>Jan can deploy once he has cluster access</li></ul></div></div>'
 + res('"Unite uses Argo CD for deploys"', 'Correct', 'Unite\'s repo has an Argo CD app per environment under <i>deploy/argocd</i>.', 'unite/deploy/argocd · GitHub') +
 '<div class="pt"><span class="tm">06:45</span><div class="c"><span class="who">Tom:</span> Jan doesn\'t need AWS access to write the new app\'s config</div></div>'
 '<div class="pt"><span class="tm">08:10</span><div class="c"><span class="who">Amit:</span> works 12:00–21:30 India time</div></div>'
 + res('"12 noon Indian time is 7.30 BST"', 'Correct', 'India is 4½ hours ahead of BST. After 25 Oct it is 06:30.', 'timeanddate.com') +
 '<div class="pt"><span class="tm">09:00</span><div class="c"><span class="who">Tom:</span> three parts: deployment setup, the app and its UI, then registry integration</div></div>'
 '<div class="pt"><span class="tm">09:41</span><div class="c"><span class="who">Unknown:</span> most of the team is away for Diwali, so do the heavy lifting before 6 Nov</div></div>'
 + res('"Diwali is 6 November"', 'Off', 'Diwali is on 8 November this year; the holiday week starts around the 6th.', 'Government of India holiday list', 'off')
)
NOW = '<div class="pt now"><span class="tm">28:20</span><div class="c"><span class="who">Tom:</span> no big blocker; our side can be done by then<ul><li>Waiting on WS1 is the real risk</li></ul></div></div>'
TAIL = '''<div class="tail">
<div class="tl"><span class="tm">28:31</span><span><b>Amit</b>Okay, fine. Lemuski is back tomorrow, so maybe this group should check direction.</span></div>
<div class="tl prov"><span class="tm">28:40</span><span><b>Tom</b>Is there anything else from you in terms of access before we…</span></div></div>'''
SUM = f'''<div class="sum"><div class="h"><h2>Summary</h2><span class="meta">21 Oct · 48 min</span><span class="ib" title="Regenerate">{I["regen"]}</span><span class="ib" title="Copy">{I["copy"]}</span></div>
<ul><li>No new infrastructure: the app builds on Unite's existing deployment setup</li><li>Jan starts by reading how Unite deploys, then writes the new app's config; AWS access comes later</li><li>Deployment runs as its own workstream from now, next to the UI and registry integration</li><li>Heavy lifting and reviews done before Diwali, which starts 8 November</li></ul></div>'''

def act(text, owner, st='', mine=True):
    return f'<div class="act"><span class="box2"></span><div class="c">{text}<div class="o">{owner}</div></div>{f"<span class=st>{st}</span>" if st else ""}</div>'
ACTIONS = ('<div class="grp">Mine</div>' + act('Ask Marco about Datadog access for Jan', 'Tom · 01:40') + act('Find an owner for registry integration', 'Tom · from chat')
 + '<div class="grp">Others</div>' + act('Read how Unite deploys its apps', 'Jan · 06:57') + act('Proposal for how the app gets deployed', 'Amit · 02:18')
 + '<div class="grp">Agent</div>' + act('Draft the deployment proposal outline', 'Agent · 02:30', 'Done ›'))

TX = ''.join(f'<div class="ln"><span class="tm">{t}</span><span><b>{w}</b>{s}</span></div>' for t, w, s in [
 ('06:45','Tom',"If all you're doing is writing some config for the new app, you won't need the AWS access yet."),
 ('06:57','Tom',"I think the first thing is to take a look at the Unite repo and see how things are deployed."),
 ('07:05','Jan',"Yeah, makes sense. I'll take a look and see how it goes."),
 ('07:34','Tom',"Where are you and what hours do you work?"),
 ('07:46','Amit',"India. From 12 to 9.30 Indian time."),
 ('08:10','Amit',"12 noon, so around 7.30 BST, right? Till end of day."),
 ('08:59','Tom',"It can start deployment now, because it's a separate thing to work on."),
 ('09:35','Unknown',"November is a pretty long holiday here. Can we expedite the heavy lifting before 6th of November?"),
])

MINE = ''.join(f'<div class="pt mine"><span class="tm">{t}</span><div class="c">{n}</div></div>' for t, n in [
 ('01:40', 'ask Marco re datadog'),
 ('08:20', 'amit hrs 7.30 bst – eod'),
 ('09:50', 'diwali: get reviews booked before 6 nov'),
 ('27:15', 'WS1 is the risk, chase Lemuski tomorrow'),
])
def mynotes(live): return f'<div class="mine-wrap"><div class="mine-list">{MINE}</div>' + ('<div class="write"><span class="ph">Write a note…</span></div>' if live else '') + '</div>'

def toggle(label, on, hint=''):
    return f'<div class="set"><div class="c">{label}{f"<small>{hint}</small>" if hint else ""}</div><span class="sw{" on" if on else ""}"><i></i></span></div>'
def pick(label, val): return f'<div class="set col"><div class="c">{label}</div><span class="sel">{val} ▾</span></div>'
SETTINGS = ('<div class="grp">Agent</div>'
 + toggle('Fact check as we go', True, 'Checks claims and adds a card under the point')
 + toggle('Agent does its own actions', True)
 + '<div class="grp">Models</div>' + pick('Analysis model', 'Claude Sonnet') + pick('Research model', 'Claude Opus')
 + '<div class="grp">Ending</div>' + toggle('End when the call ends', True))

ERR = '<div class="err"><span>Research failed on 1 point: model gave an unknown verdict.</span><a href="live.html">Retry</a></div>'

def side(live, tab, body, err=False):
    return f'<aside class="side">{side_head(live, tab, 4)}{ERR if err else ""}<div class="pane">{body}</div></aside>'

def page(name, inner):
    main = f'<div class="mm">{inner}</div><script>for(const b of document.querySelectorAll(".mm .pane,.mm .stream"))if(!b.dataset.top)b.scrollTop=b.scrollHeight</script>'
    open(name, 'w').write(shell.replace('<!--MAIN-->', main))

screens = [
 ('live', 'Live · Notes', chat('Note', True) + side(True, 'Notes', NOTES + NOW + TAIL)),
 ('live-error', 'Live · with an error', chat('Note', True) + side(True, 'Notes', NOTES + NOW + TAIL, err=True)),
 ('actions', 'Live · Actions', chat('Note', True) + side(True, 'Actions', ACTIONS)),
 ('after', 'After · Notes', chat('Ask', False) + side(False, 'Notes', SUM.replace('class="sum"', 'class="sum" ') + NOTES).replace('<div class="pane">', '<div class="pane" data-top="1">')),
 ('live-transcript', 'Live · Transcript', chat('Note', True) + side(True, 'Transcript', TX)),
 ('after-actions', 'After · Actions', chat('Ask', False) + side(False, 'Actions', ACTIONS)),
 ('transcript', 'After · Transcript', chat('Ask', False) + side(False, 'Transcript', TX)),
 ('live-mynotes', 'Live · My notes', chat('Note', True) + side(True, 'My notes', mynotes(True))),
 ('after-mynotes', 'After · My notes', chat('Ask', False) + side(False, 'My notes', mynotes(False))),
 ('settings', 'Settings', chat('Note', True) + side(True, 'Settings', SETTINGS).replace('<div class="pane">', '<div class="pane" data-top="1">')),
]
for sid, _, html in screens: page(f'{sid}.html', html)
ORDER = ['live', 'live-mynotes', 'actions', 'live-transcript', 'live-error', 'settings', 'after', 'after-mynotes', 'after-actions', 'transcript']
screens.sort(key=lambda x: ORDER.index(x[0]))
json.dump({'screens': [{'id': s, 'name': n, 'path': f'{s}.html'} for s, n, _ in screens]}, open('pad.json', 'w'), indent=1)
