# Voice hand-offs in the chat, and a "direct to agent" call mode.
# Built from Patch's real markup and stylesheet, captured from the web dev harness
# (design/_kit/capture-web.mjs, query "chat=chat_voice&voice=call") into _src/ + real.css.
# Only the transcript and the call bar are swapped; new styles live in proposal.css.
# Run: python3 build.py && python3 build_phone.py
import json, re

SRC = open('_src/call.html').read()
# The harness has no server, so it shows a load-error toast: not part of the design.
_i = SRC.index('class="error-toasts"'); _s = SRC.rindex('<', 0, _i)
_d = 0
for _m in re.finditer(r'<(/?)div\b[^>]*>', SRC[_s:]):
    _d += -1 if _m.group(1) else 1
    if _d == 0:
        SRC = SRC[:_s] + SRC[_s + _m.end():]
        break


def lucide(body, size=14, sw=2):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24" '
            f'fill="none" stroke="currentColor" stroke-width="{sw}" stroke-linecap="round" '
            f'stroke-linejoin="round" aria-hidden="true">{body}</svg>')


ARROW = lucide('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>', 12)
UP_R = lucide('<path d="M7 7h10v10"/><path d="M7 17 17 7"/>')
DOWN_L = lucide('<path d="M17 7 7 17"/><path d="M17 17H7V7"/>')
SWAP = lucide('<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>')
CHEV = lucide('<path d="m9 18 6-6-6-6"/>', 14)
SPEAKER = lucide('<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/>')


def block(html, marker, tag='div'):
    i = html.index(marker)
    s = html.rindex('<', 0, i)
    depth = 0
    for m in re.finditer(rf'<(/?){tag}\b[^>]*>', html[s:]):
        depth += -1 if m.group(1) else 1
        if depth == 0:
            return s, s + m.end()
    raise ValueError(marker)


s, e = block(SRC, 'class="msg msg-user voice')
USER_T = SRC[s:e]
s, e = block(SRC, 'class="msg msg-assistant voice"')
VOICE_T = SRC[s:e]
U_OLD = re.search(r'<div class="content md"[^>]*>(.*?)</div>', USER_T, re.S).group(1)
V_OLD = re.search(r'<div class="content md"[^>]*>(.*?)</div>', VOICE_T, re.S).group(1)
MARK = re.search(r'<span class="msg-voice-mark".*?</span>', VOICE_T, re.S).group(0)


def U(t): return USER_T.replace(U_OLD, f'<p>{t}</p>')
def V(t): return VOICE_T.replace(V_OLD, f'<p>{t}</p>')


def A(t, spoken=False):
    """A normal agent message. In direct mode it carries a speaker mark: it was read out on the call."""
    m = VOICE_T.replace('class="msg msg-assistant voice"', 'class="msg msg-assistant"').replace(V_OLD, f'<p>{t}</p>')
    mark = (f'<span class="msg-voice-mark dm-spoken" title="Read out on the call">{SPEAKER}</span>' if spoken else '')
    return m.replace(MARK, mark)


def DU(t, queued=False):
    """What you said in direct mode: your own message, sent straight to the agent."""
    m = U(t)
    if queued:
        m = m.replace('<div class="msg-meta"', '<span class="dm-queued">Queued</span><div class="msg-meta"', 1)
    return m


Q1 = ('What Android APIs or intents fire when wired or Bluetooth headphones are disconnected and reconnected? '
      'What does the app receive, and can it pause and resume audio without dropping the connection?')
A1 = ('Yes, that works. When headphones are unplugged, Android warns the app that audio is about to come out of the '
      'speaker, and it reports when an audio device is removed and added again. Earbuds that sense being taken out '
      'send a "pause" press. The app can stop the voice and mute the mic while keeping the call connected.')
Q2 = ('What does ElevenLabs charge for a silent open session: 30 seconds, 1, 2, 10 minutes and an hour?')


def dirlabel(a, b):
    return f'<span class="ho-dir">{a}<span class="ho-arrow">{ARROW}</span>{b}</span>'


def row_one(direction, text, state):
    """Variant A: each direction is its own one-line row in the voice gutter."""
    icon, who = (UP_R, dirlabel('Voice', 'Agent')) if direction == 'to' else (DOWN_L, dirlabel('Agent', 'Voice'))
    return (f'<div class="msg ho-msg"><div class="msg-voice-row"><span class="msg-voice-mark ho-mark">{icon}</span>'
            f'<button type="button" class="ho-row">{who}<span class="ho-text">{text}</span>'
            f'<span class="ho-state">{state}</span><span class="ho-chev">{CHEV}</span></button></div></div>')


def pair(q, a, state, open_=False, working=False):
    """Variant B: one row per hand-off, question and answer together."""
    st = (f'<span class="ho-state"><span class="ho-spin"></span>{state}</span>' if working
          else f'<span class="ho-state">{state}</span>')
    body = ''
    if open_:
        body = (f'<div class="ho-body"><div class="ho-part">{dirlabel("Voice", "Agent")}<p>{q}</p></div>'
                + (f'<div class="ho-part">{dirlabel("Agent", "Voice")}<p>{a}</p></div>' if a else '')
                + '</div>')
    return (f'<div class="msg ho-msg" data-open="{str(open_).lower()}"><div class="msg-voice-row">'
            f'<span class="msg-voice-mark ho-mark">{SWAP}</span><div class="ho-wrap">'
            f'<button type="button" class="ho-row"><span class="ho-dir">Asked the agent</span>'
            f'<span class="ho-text">{q}</span>{st}<span class="ho-chev">{CHEV}</span></button>{body}</div></div></div>')


OPEN = (U("I take my headphone out to talk to somebody, everything pauses. I put it back in and it picks up exactly where it was.")
        + V("Right, so the call stays open and only the audio pauses. Let me check what Android gives us."))
MID = (V("Android gives us what we need: it tells us when headphones go and when they come back, so we can pause and pick up again.")
       + U("What would a silent call cost us, for a minute, ten minutes, an hour?")
       + V("Good question. I've asked the agent, it's on it."))


def stream(inner):
    global SRC
    s, e = block(SRC, 'class="chat-stream-content"')
    open_tag = SRC[s:SRC.index('>', s) + 1]
    return SRC[:s] + open_tag + inner + '</div>' + SRC[e:]


def bar(page, mode):
    """The call bar says which kind of call it is. No mid-call switch: a direct call is started from the call menu."""
    s, e = block(page, 'class="vb-mode"', 'span')
    head = 'On call' if mode == 'voice' else 'On call · direct'
    page = page[:s] + f'<span class="vb-mode" data-testid="voice-bar-head">{head}</span>' + page[e:]
    sw = ''
    s, e = block(page, 'class="vb-line"', 'span')
    if mode == 'direct':
        line = ('<span class="vb-line"><span class="vb-status"><span class="ho-spin"></span>Agent working · 0:42</span></span>')
    else:
        line = page[s:e]
    return page[:s] + line + sw + page[e:]


def page(title, body):
    body = re.sub(r'<!--.*?-->', '', body, flags=re.S)
    body = re.sub(r'<script.*?</script>', '', body, flags=re.S)
    body = body.replace('<vite-error-overlay></vite-error-overlay>', '')
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title>'
            f'<link rel="stylesheet" href="real.css"><link rel="stylesheet" href="proposal.css">'
            f'<script>addEventListener("load",()=>document.querySelectorAll(".chat-stream").forEach(s=>s.scrollTop=s.scrollHeight))</script></head>'
            f'<body>{body}</body></html>')


screens = []


def out(fid, name, body):
    open(f'{fid}.html', 'w').write(page(name, body))
    screens.append({'id': fid, 'name': name, 'path': f'{fid}.html'})


# A — one row per direction
a = (OPEN + row_one('to', Q1, '15:31') + row_one('from', A1, '15:32 · 38s') + MID
     + row_one('to', Q2, 'received · working 0:24'))
out('index', 'A · one row per direction, collapsed', bar(stream(a), 'voice'))

# B — one row per exchange
b = OPEN + pair(Q1, A1, 'answered in 38s') + MID + pair(Q2, None, 'working 0:24', working=True)
out('b-paired', 'B · one row per hand-off, collapsed', bar(stream(b), 'voice'))
b_open = OPEN + pair(Q1, A1, 'answered in 38s', open_=True) + MID + pair(Q2, None, 'working 0:24', working=True)
out('b-paired-open', 'B · hand-off opened', bar(stream(b_open), 'voice'))

# Direct to agent
d = (DU("I take my headphone out to talk to somebody, everything pauses. I put it back in and it picks up where it was. What does Android give us?")
     + A("Android tells the app when headphones are removed and added again, so the call can pause and pick up.", spoken=True)
     + DU("Okay, what would a silent call cost on ElevenLabs, for ten minutes or an hour?")
     + A("Roughly pennies. A silent stretch is billed at a fraction of the normal rate, so ten minutes is about 5 cents "
         "and an hour about 25 cents. I haven't checked their current pricing.", spoken=True)
     + DU("And can we close the session while paused and keep the context?")
     + '<div class="dm-working"><span class="ho-spin"></span>Agent working · 0:42</div>'
     + DU("Also check what happens to the hand-off queue.", queued=True))
out('direct', 'Direct call · agent working', bar(stream(d), 'direct'))

json.dump({'screens': screens}, open('pad.json', 'w'), indent=1)
print('built', [x['id'] for x in screens])
