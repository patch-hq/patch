# Builds the mockup screens into the real Patch shell (sidebar + pane captured from the web app).
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
 down=svg('<path d="m6 9 6 6 6-6"/>'),
 up=svg('<path d="m18 15-6-6-6 6"/>'),
)
def head(title): return f'<header class="head"><span class="nav">‹ ›</span><h1>{title}</h1><span class="ic">{I["edit"]}{I["box"]}{I["more"]}</span></header>'
def tabs(on): return '<nav class="seg">'+''.join(f'<a class="{"on" if t==on else ""}" href="#">{t}</a>' for t in ['Summary','Transcript'])+'</nav>'
PPL='<span class="ppl">Tom · Amit · Jan · 1 unknown</span>'
def bar(live,on):
    if live: return f'<section class="bar"><span class="pill"><span class="dot"></span>11:52</span>{PPL}<span class="sp"></span>{tabs(on)}<span class="sp"></span><button class="btn">Pause</button><button class="btn end">End</button></section>'
    return f'<section class="bar"><span class="pill done">13:06</span>{PPL}<span class="sp"></span>{tabs(on)}<span class="sp"></span><button class="btn">Resume</button><span class="ibtn" title="Fold the meeting away">{I["up"]}</span></section>'
def composer(mode=None, hot=False, pop='', ph='Type a message'):
    m = '' if mode is None else '<span class="mode">'+''.join(f'<span class="{"on" if x==mode else ""}">{x}</span>' for x in ['Note','Ask'])+'</span>'
    return f'''<div class="comp">{pop}<div class="box">{m}<span class="ph">{ph}</span></div>
<div class="tools"><span class="t">{I["clip"]}</span><span class="t">{I["pen"]}</span><span class="t">{I["mic"]}</span><span class="t">{I["phone"]}</span><span class="t{' hot' if hot else ''}" title="Meeting">{I["wave"]}</span>
<span class="dd">Bypass permissions ▾</span><span class="dd">Claude Opus ▾</span><span class="dd">Auto account ▾</span><span class="sp"></span><span class="t">{I["send"]}</span></div></div>'''
TRAY=f'<section class="tray"><div class="trayhead"><span class="lb">Actions</span><span><b>1</b> mine · <b>2</b> others</span><span class="sp"></span>{I["down"]}</div></section>'

def page(name, inner, scroll_bottom=False):
    main = f'<div class="mm">{inner}</div>'
    if scroll_bottom: main += '<script>for(const b of document.querySelectorAll(".mm .body"))b.scrollTop=b.scrollHeight</script>'
    open(name,'w').write(shell.replace('<!--MAIN-->', main))

STREAM = '''
<div class="pt"><span class="tm">00:08</span><div class="c"><div class="nm"><span class="who">Tom:</span> no new cluster needed; the app builds on the existing product framework</div></div></div>
<div class="pt"><span class="tm">01:12</span><div class="c"><div class="nm"><span class="who">Tom:</span> Termin's monitoring lives in the Platform organisation in Datadog</div></div></div>
<div class="pt mine"><span class="tm">01:40</span><div class="c"><div class="nm">ask Marco re datadog</div><ul><li>Marco also has the ticket open for Jan's AWS access</li></ul></div></div>
<div class="pt"><span class="tm">02:18</span><div class="c"><div class="nm"><span class="who">Amit:</span> first task is a proposal for how the app gets deployed</div><ul><li>Jan can deploy once he has cluster access</li></ul></div></div>
<div class="pt"><span class="tm">06:45</span><div class="c"><div class="nm"><span class="who">Tom:</span> Jan doesn't need AWS access to write the new app's config</div><ul><li>Start by reading how Unite deploys its apps</li></ul></div></div>
<div class="pt mine"><span class="tm">08:20</span><div class="c"><div class="nm">amit hrs 7.30 bst – eod</div><ul><li>12:00–21:30 in India; 06:30 UK time once the clocks go back on 25 Oct</li></ul></div></div>
<div class="res"><div class="h"><span class="k">Fact check</span><span class="verdict">Correct</span><span class="tm" style="width:auto">08:10</span><span class="q">"12 noon Indian time is 7.30 BST"</span></div><ul><li>India is 4½ hours ahead of BST, so 12:00 IST is 07:30 BST</li></ul><div class="src">World Time Buddy · IST to BST</div></div>
<div class="pt"><span class="tm">09:00</span><div class="c"><div class="nm"><span class="who">Tom:</span> three parts: deployment setup (once), the app and its UI, then registry integration</div><ul><li>Deployment can start now, separately from the rest</li></ul></div></div>
<div class="msg u">who owns the registry integration</div>
<div class="msg a">Nobody yet. Amit said Alex is building the integrated function it depends on.<br><span class="did">✓ Added to actions</span></div>
<div class="pt"><span class="tm">09:41</span><div class="c"><div class="nm"><span class="who unk">Unknown:</span> the team is mostly away for Diwali, so do the heavy lifting before 6 November</div></div></div>'''
NOW = '''<div class="pt now"><span class="tm">10:35</span><div class="c"><div class="nm"><span class="tag">Now</span>Tom: no big blocker; our side can be done by then</div><ul><li>Waiting on WS1 is the real risk</li><li>Two weeks is enough for Amit's setup work</li></ul></div></div>'''
TAIL = '''<div class="tail"><div class="lbl">Not in the summary yet</div>
<div class="tl"><span class="tm">11:05</span><span><b>Tom</b>I think two weeks should be plenty of time to get it set up, because Unite already has such a solid base.</span></div>
<div class="tl"><span class="tm">11:11</span><span><b>Amit</b>Okay, fine. Lemuski is coming back tomorrow, so maybe this group should have a check on the direction.</span></div>
<div class="tl"><span class="tm">11:33</span><span><b>Unknown</b>She is looking at the chats, and Thomas is already on top of that.</span></div>
<div class="tl prov"><span class="tm">11:50</span><span><b>Tom</b>Is there anything else from you in terms of access before we wrap…</span></div></div>'''
LATER = '''<div class="pt"><span class="tm">10:35</span><div class="c"><div class="nm"><span class="who">Tom:</span> no big blocker; our side can be done by then</div><ul><li>Waiting on WS1 is the real risk</li><li>Two weeks is enough for Amit's setup work</li></ul></div></div>
<div class="pt"><span class="tm">11:11</span><div class="c"><div class="nm"><span class="who">Amit:</span> check direction with Lemuski when he's back tomorrow</div></div></div>
<div class="pt"><span class="tm">12:48</span><div class="c"><div class="nm"><span class="who">Amit:</span> reviews and check-ins for Sperata done early, before the holiday</div></div></div>'''
CLOSE = f'''<div class="close"><div class="h"><h2>Summary</h2><span class="meta">21 Oct · 13 min</span><span class="ibtn" title="Regenerate">{I["regen"]}</span><span class="ibtn" title="Copy">{I["copy"]}</span></div>
<ul><li>No new infrastructure: the app builds on Unite's existing deployment setup</li><li>Jan starts by reading how Unite deploys, then writes the new app's config; AWS access comes later</li><li>Deployment runs as its own workstream from now, next to the UI and <span class="fix" title="heard as: registry">registry</span> integration</li><li>The team is largely away for Diwali; heavy lifting and reviews done before 6 November</li><li>Our side can be done by then; waiting on WS1 is the risk</li></ul></div>'''

page('live.html', head('Termin deployment kickoff') + bar(True,'Summary') + f'<main class="body"><div class="col">{STREAM}{NOW}{TAIL}</div></main>' + TRAY + composer('Note', hot=True, ph='Write a note…'), scroll_bottom=True)
page('after.html', head('Termin deployment kickoff') + bar(False,'Summary') + f'<main class="body"><div class="col">{STREAM}{LATER}{CLOSE}</div></main>' + TRAY + composer('Ask'), scroll_bottom=True)
TX = f'''<div class="col"><div class="txhead"><span class="lb">Transcript</span><span class="sp"></span><span class="ibtn" title="Copy transcript">{I["copy"]}</span></div>
<div class="ln"><span class="tm">06:45</span><span><b>Tom</b>If all you're doing is writing some config for the new app, you won't need the AWS access yet.</span></div>
<div class="ln"><span class="tm">06:57</span><span><b>Tom</b>I think the first thing is to take a look at the Unite repo and see how things are deployed. That'll probably answer a lot of the questions.</span></div>
<div class="ln"><span class="tm">07:05</span><span><b>Jan</b>Yeah, makes sense. I'll take a look and see how it goes.</span></div>
<div class="ln"><span class="tm">07:15</span><span><b>Jan</b>I'll post in the group if I find anything.</span></div>
<div class="ln"><span class="tm">07:34</span><span><b>Tom</b>Where are you and what hours do you work?</span></div>
<div class="ln"><span class="tm">07:46</span><span><b>Amit</b>India. From 12 to 9.30 Indian time.</span></div>
<div class="ln"><span class="tm">08:10</span><span><b>Amit</b>12 noon, so around 7.30 BST, right? Till end of day.</span></div>
<div class="ln"><span class="tm">08:41</span><span><b>Amit</b>Once we have the UI portion and the integrated function, which Alex is working on, we need to move towards deployment.</span></div>
<div class="ln"><span class="tm">08:59</span><span><b>Tom</b>It can start deployment now, because it's a separate thing to work on.</span></div>
<div class="ln"><span class="tm">09:35</span><span><b>Unknown</b>November is a pretty long holiday here. Can we expedite the heavy lifting before 6th of November?</span></div>
<div class="ln"><span class="tm">09:59</span><span><b>Amit</b>All the people who belong to India will celebrate this; it's an annual festival, once a year.</span></div></div>'''
page('transcript.html', head('Termin deployment kickoff') + bar(False,'Transcript') + f'<main class="body">{TX}</main>' + TRAY + composer('Ask'))

EMPTY = '<main class="empty">No messages yet</main>'
FIRST = '''<div class="pop"><div class="ph2"><b>Meetings</b><button class="x" title="Not now">✕</button></div>
<div class="perm"><span class="n">Microphone<small>Your side of the call</small></span><span class="ok">✓ Allowed</span></div>
<div class="perm"><span class="n">Call audio<small>The other side of the call</small></span><button class="btn pri">Allow</button></div>
<div class="perm"><span class="n">Accessibility<small>Speaker names from Teams, Zoom and Meet</small></span><button class="btn pri">Allow</button></div></div>'''
page('setup-first-run.html', head('New chat') + EMPTY + composer(None, hot=True, pop=FIRST))
START = '''<div class="pop"><div class="ph2"><b>Start meeting</b></div>
<div class="perm"><span class="n">Microphone</span><span class="ok">✓ Allowed</span></div>
<div class="perm"><span class="n">Call audio</span><span class="ok">✓ Allowed</span></div>
<div class="perm"><span class="n">Accessibility<small class="warn">Without it, speakers show as Unknown</small></span><button class="btn">Allow</button></div>
<div class="acts"><button class="btn">Start without names</button><button class="btn pri" disabled style="opacity:.45">Start</button></div></div>'''
page('setup-start.html', head('New chat') + EMPTY + composer(None, hot=True, pop=START))

FOLDBAR = f'<section class="bar slim"><span class="pill done">Meeting · 13:06</span>{PPL}<span class="sp"></span><button class="btn">Summary</button><button class="btn">Transcript</button><span class="ibtn" title="Show the meeting">{I["down"]}</span></section>'
CHAT = f'''<div class="col chat">
<div class="mcard"><div class="h"><b>Meeting summary</b><span class="meta">21 Oct · 13 min</span></div>
<ul><li>No new infrastructure: the app builds on Unite's existing deployment setup</li><li>Deployment runs as its own workstream from now</li><li>Heavy lifting and reviews done before 6 November</li></ul></div>
<div class="msg u">draft a message to Jan with what he should do this week</div>
<div class="msg a full">Here's a draft for Teams:<br><br>Hi Jan, for this week: read through how the Unite repo deploys its apps, then sketch the config for the new Termin app. You won't need AWS access for that; Marco has the ticket open for when you do. Post anything you find in the group. Thanks!</div>
</div>'''
page('after-folded.html', head('Termin deployment kickoff') + FOLDBAR + f'<main class="body">{CHAT}</main>' + composer())
