# Builds the voice-call redesign screens from Patch's REAL markup and stylesheet,
# captured from the web dev harness (packages/web dev-harness.html) into _src/.
# Only the parts being redesigned are swapped; proposal.css holds the new bits.
# Run: python3 build.py
import json, random, re

random.seed(7)
SRC = {k: open(f'_src/{k}.html').read() for k in ['call', 'settings']}


def lucide(body, size=16, sw=2):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24" '
            f'fill="none" stroke="currentColor" stroke-width="{sw}" stroke-linecap="round" '
            f'stroke-linejoin="round">{body}</svg>')


PHONE_P = ('<path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 '
           '2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 '
           '14 14 0 0 0 6.392 6.384"/>')
MIC_OFF = lucide('<path d="M12 19v3"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/>'
                 '<path d="M16.95 16.95A7 7 0 0 1 5 12v-2"/><path d="M18.89 13.23A7 7 0 0 0 19 12v-2"/>'
                 '<path d="m2 2 20 20"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/>')
HEADPHONES = lucide('<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 '
                    '0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>')
GEAR = lucide('<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 '
              '4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 '
              '1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 '
              '0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>')


def block(html, start_marker):
    """(start, end) of the element whose opening tag contains start_marker."""
    i = html.index(start_marker)
    s = html.rindex('<', 0, i)
    depth, j = 0, s
    for m in re.finditer(r'<(/?)div\b[^>]*>', html[s:]):
        depth += -1 if m.group(1) else 1
        if depth == 0:
            return s, s + m.end()
    raise ValueError(start_marker)


def page(title, body, extra=''):
    body = re.sub(r'<!--.*?-->', '', body, flags=re.S)
    body = re.sub(r'<script.*?</script>', '', body, flags=re.S)
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title>'
            f'<link rel="stylesheet" href="real.css"><link rel="stylesheet" href="proposal.css"></head>'
            f'<body{extra}>{body}</body></html>')


# ---- transcript pieces, cut from the real messages ----
call = SRC['call']
s, e = block(call, 'class="msg msg-user voice')
USER_T = call[s:e]
s, e = block(call, 'class="msg msg-assistant voice"')
VOICE_T = call[s:e]


def said(tpl, old, text):
    return tpl.replace(f'<p>{old}</p>', f'<p>{text}</p>')


def U(t): return said(USER_T, "Okay, we'll restart those then.", t)
def V(t): return said(VOICE_T, 'Restarting the host now.', t)


def A(inner):
    """An ordinary agent message: the voice message minus its call mark and italics."""
    m = VOICE_T.replace('class="msg msg-assistant voice"', 'class="msg msg-assistant"')
    m = re.sub(r'<span class="msg-voice-mark".*?</span>', '', m, flags=re.S)
    return m.replace('<p>Restarting the host now.</p>', inner)


def tool(text):
    return (f'<div class="tool-call" data-open="false"><button type="button" class="tool-summary">'
            f'<span class="tool-chevron" aria-hidden="true">▸</span>'
            f'<span class="tool-summary-text">{text}</span></button></div>')


def working(open_, done=False):
    if done:
        # Answered: the agent's reply follows as a normal message, so this is
        # only the rule above it. No chevron: nothing here opens or closes.
        return ('<div class="agent-work" data-done="true"><div class="aw-head">'
                '<span>Agent answered in 1:14</span></div></div>')
    steps = ''
    if open_:
        steps = '<div class="aw-steps">' + ''.join(tool(t) for t in [
            'Searching the web: fischer DuoPower recommended load kN →',
            'Fetching fischer DuoPower data sheet (PDF) →',
            'Reading the load table →']) + '</div>'
    chev = lucide('<path d="m6 9 6 6 6-6"/>', 18) if open_ else lucide('<path d="m9 18 6-6-6-6"/>', 18)
    return (f'<div class="agent-work" data-done="false" data-open="{str(open_).lower()}"><button type="button" class="aw-head">'
            f'<span class="aw-chev">{chev}</span><span class="aw-spin"></span><span>Agent is working</span>'
            f'<span class="aw-timer">0:42</span></button>{steps}</div>')


def seg(label):
    return f'<div class="call-seg"><span>{label}</span></div>'


TABLE = ('<p>Safe working load per plug, from Fischer\'s data sheet:</p>'
         '<table><thead><tr><th></th><th>6×30</th><th>6×50</th><th>8×65</th></tr></thead><tbody>'
         '<tr><td>Solid brick</td><td>50 kg</td><td>55 kg</td><td>70 kg</td></tr>'
         '<tr><td>Concrete</td><td>95 kg</td><td>165 kg</td><td>230 kg</td></tr>'
         '<tr><td>Plasterboard</td><td>15 kg</td><td>15 kg</td><td>not rated</td></tr></tbody></table>'
         '<p>The longer plugs only pay off in concrete or soft blockwork.</p>')

OPENING = (seg('Call · Gemini Flash · 16:36')
           + U("If I've got DuoPower plugs, when should I use the 30 mil and when the 50 or 65?")
           + V('Thirty for light jobs in brick or concrete, the longer ones for soft blockwork. Want the weight limits?')
           + U('Yeah, what weight can each one take?')
           + V("I'll get the agent to look that up."))


def wave(n=200):
    return ('<span class="vb-wave" aria-label="Listening">' + ''.join(
        f'<i style="height:{random.randint(3, 14)}px;animation-delay:-{random.random():.2f}s"></i>'
        for _ in range(n)) + '</span>')


def with_call(stream, bar_text=None, on_call=True):
    h = call.replace('voice-fixture', 'DuoPower plugs')
    s, e = block(h, 'class="chat-stream-content"')
    h = h[:s] + f'<div class="chat-stream-content">{stream}</div>' + h[e:]
    if on_call:
        s2 = h.index('<span class="vb-line"')
        e2 = h.index('</span></span>', s2) + len('</span></span>')
        tail = f'<span class="vb-agent">{bar_text}</span>' if bar_text else ''
        h = h[:s2] + wave() + tail + h[e2:]
        h = re.sub(r'<span class="vb-timer"[^>]*>[^<]*</span>', '', h, count=1)
        h = h.replace('ON CALL</span>', 'ON CALL</span><span class="vb-len">1:58</span>', 1)
        # mute: a struck-through mic, so it reads as "mute" at a glance
        h = re.sub(r'(data-testid="voice-bar-mute" aria-label="mute">)<svg.*?</svg>',
                   lambda m: m.group(1) + MIC_OFF, h, count=1, flags=re.S)
    else:
        s2, e2 = block(h, 'class="voice-bar"')
        h = h[:s2] + h[e2:]
        h = h.replace('class="call-btn live"', 'class="call-btn"')
    h = re.sub(r'<div class="error-toasts".*?</div>', '<div class="error-toasts"></div>', h, flags=re.S)
    return h


screens = []


def out(fid, name, html):
    open(fid + '.html', 'w').write(html)
    screens.append({'id': fid, 'name': name, 'path': fid + '.html'})


out('index', 'Call – agent working',
    page('Call – agent working', with_call(OPENING + working(False), 'Agent working')))
out('working-open', 'Call – agent working, opened',
    page('Call – agent working, opened', with_call(OPENING + working(True), 'Agent working')))
out('done', 'Call – agent answered',
    page('Call – agent answered', with_call(
        OPENING + working(False, done=True) + A(TABLE) + seg('Voice')
        + V("Fifty to seventy kilos each in brick, about double in concrete. The table's in the chat.")
        + U('Great, thanks.'))))
out('ended', 'Call ended',
    page('Call ended', with_call(
        OPENING + working(False, done=True) + A(TABLE) + seg('Voice')
        + V("Fifty to seventy kilos each in brick, about double in concrete. The table's in the chat.")
        + U('Great, thanks.') + seg('Call ended · 3:26 · 2¢'), on_call=False)))

# ---- call button menu (long press on phone, right click on computer) ----
h = with_call(A(TABLE), on_call=False)
menu = (f'<div class="context-menu call-menu" role="menu">'
        f'<button type="button" class="context-menu-item" role="menuitem">{lucide(PHONE_P)}<span>Call</span></button>'
        f'<button type="button" class="context-menu-item" role="menuitem">{HEADPHONES}<span>Hands-free</span></button>'
        f'<div class="context-menu-sep"></div>'
        f'<button type="button" class="context-menu-item" role="menuitem">{GEAR}<span>Voice settings</span></button></div>')
h = h.replace('<div class="composer-tools">', '<div class="composer-tools" style="position:relative">' + menu, 1)
out('call-menu', 'Call button – long press / right click', page('Call menu', h))

X_ICON = lucide('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 16)
# ---- dictation: capped at a quarter of the window, scrolls, drag to resize ----
h = with_call(A(TABLE), on_call=False)
DICT = ("Okay, problems with this. Some of it went reasonably well. ElevenLabs Haiku is never going to work very "
        "well, and it costs 30 cents, which is quite a lot. ElevenLabs Haiku and ElevenLabs Sonnet should be a "
        "sub-setting, so you pick the provider and then the variant of that provider, like Flash or Thinking, "
        "Haiku or Sonnet. It's got hands-free hand-off, when needed, always and never, and I don't know what "
        "that's supposed to mean. Same with call hand-off. I can't read the settings page at all. "
        "<span class='dict-live'>so what else was wrong with that the design is pretty messy</span>")
h = re.sub(r'<textarea class="composer-input"[^>]*></textarea>',
           f'<div class="dict-grip" title="Drag to resize"></div><div class="composer-input dict-box">{DICT}</div>'
           f'<button type="button" class="dict-cancel" aria-label="Cancel dictation">{X_ICON}</button>',
           h, count=1)
h = h.replace('class="voice-note-btn "', 'class="voice-note-btn active"', 1)
out('dictation', 'Dictation – quarter height, drag to resize', page('Dictation', h))

# ---- settings ----
st = SRC['settings']


def pills(opts, on):
    return ('<div class="set-pills" role="group">' + ''.join(
        f'<button type="button"{" class=\"on\" aria-pressed=\"true\"" if o == on else " aria-pressed=\"false\""}>{o}</button>'
        for o in opts) + '</div>')


def row(title, ctrl, stack=False, sub=''):
    subh = f'<span class="set-sub">{sub}</span>' if sub else ''
    return (f'<div class="set-row{" stack" if stack else ""}"><div class="set-row-text"><span class="set-row-title">'
            f'{title}</span>{subh}</div><div class="set-row-ctrl">{ctrl}</div></div>')


def group(label, rows):
    return f'<section class="set-group"><h2 class="set-label">{label}</h2><div class="set-card">{rows}</div></section>'


TOGGLE_ON = ('<label class="toggle"><input role="switch" class="toggle-input" type="checkbox" checked>'
             '<span class="toggle-track" aria-hidden="true"><span class="toggle-knob"></span></span></label>')

MODELS = {
    'Gemini Live': (['2.5 Flash · 1¢ a min', '3.8 Live Thinking'], '2.5 Flash · 1¢ a min'),
    'OpenAI Realtime': (['Realtime 2.1 mini', 'Realtime 2.1'], 'Realtime 2.1 mini'),
    'ElevenLabs Agents': (['Claude Haiku 4.5 · 9¢ a min', 'Claude Sonnet 4.5', 'Gemini 2.5 Flash', 'GPT-4.1 mini'],
                   'Claude Haiku 4.5 · 9¢ a min'),
}
PROMPT = ("You are the voice of this conversation. The user is talking, out loud, to the same chat they have "
          "been typing in.\n\nAnswer in one or two short sentences. Offer more only if asked.\n\nIf you don't "
          "know something, or it needs looking up, their data, a tool or an action, pass it to the agent and "
          "say so in a few words. Never say you don't know without asking the agent.\n\nWhile the agent is "
          "working, don't offer to look it up again. When its answer arrives, give the gist in a sentence; the "
          "full answer is in the chat.\n\nSilence and noise are not requests: say nothing.")


TOGGLE_OFF = TOGGLE_ON.replace(' checked', '')


def settings(mode, provider=None, tidy=True):
    rows = row('Kind of call', pills(['Real-time', 'Turn-based'], mode), stack=True)
    if mode == 'Real-time':
        opts, on = MODELS[provider]
        rows += row('Provider', pills(list(MODELS), provider), stack=True)
        rows += row('Model', pills(opts, on), stack=True)
        rows += row('Can ask the agent', TOGGLE_ON)
    else:
        rows += row('Speech to text', pills(['Groq Whisper', 'Whisper on host', 'Parakeet on host', 'ElevenLabs Scribe'],
                                       'Groq Whisper'), stack=True)
        rows += row('Text to speech', pills(['Kokoro on host', 'ElevenLabs'], 'ElevenLabs'), stack=True)
    calls = group('Calls', rows)
    instr = ('<section class="set-group"><h2 class="set-label">Voice instructions</h2><div class="set-card">'
             '<div class="set-row stack"><div class="set-row-head"><div class="set-row-text">'
             '<span class="set-row-title">What the voice is told</span></div>'
             + pills(['Default', 'Custom'], 'Custom') +
             f'</div><textarea rows="11">{PROMPT}</textarea><div class="set-actions">'
             '<button type="button" class="set-btn ghost">Cancel</button>'
             '<button type="button" class="set-btn primary">Save</button></div></div></div></section>')
    tidy_row = row('Tidy up each phrase with', pills(['Off', 'Groq Whisper', 'Whisper on host', 'Parakeet on host'],
                                                      'Parakeet on host' if tidy else 'Off'), stack=True)
    dict_ = group('Dictation',
                  row('Phone', pills(['Android speech recognizer', 'Deepgram', 'ElevenLabs Scribe',
                                      'Parakeet on host'], 'Android speech recognizer'), stack=True)
                  + row('Computer', pills(['Deepgram', 'ElevenLabs Scribe', 'Parakeet on this computer'], 'Deepgram'),
                        stack=True)
                  + tidy_row)
    s, e = block(st, 'class="set-page"')
    body = (f'<div class="set-page" data-testid="settings-voice"><div class="set-head"><button type="button" '
            f'class="set-back" aria-label="Back">←</button><h1 class="display">Voice</h1></div>'
            f'{calls}{instr if mode == "Real-time" else ""}{dict_}</div>')
    return st[:s] + body + st[e:]


out('settings', 'Settings – real-time call', page('Settings – real-time', settings('Real-time', 'Gemini Live')))
out('settings-el', 'Settings – real-time, ElevenLabs', page('Settings – ElevenLabs', settings('Real-time', 'ElevenLabs Agents')))
out('settings-host', 'Settings – turn-based call', page('Settings – turn-based', settings('Turn-based', tidy=False)))

json.dump({'screens': screens}, open('pad.json', 'w'), indent=1)
print('built', len(screens))
