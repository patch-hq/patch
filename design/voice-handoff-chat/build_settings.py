# Settings → Voice as a sequence: each choice appears once the one before it is made.
# 1. Voice agent or Direct. Voice agent → provider → model → voice.
#    Direct → speech-to-text engine → its model → text-to-speech engine → its model → voice.
# Model and voice lists come from each provider's API; the entries here are examples.
# Plus the call button's menu with "Call direct". Built on the real Settings page
# (_src/settings.html, captured with design/_kit/capture-settings.spec.ts) and real.css.
# Run after build.py and build_phone.py: python3 build_settings.py
import json, re

SET = open('_src/settings.html').read()
CALL = open('_src/call.html').read()


def block(html, marker, tag='div'):
    i = html.index(marker)
    s = html.rindex('<', 0, i)
    depth = 0
    for m in re.finditer(rf'<(/?){tag}\b[^>]*>', html[s:]):
        depth += -1 if m.group(1) else 1
        if depth == 0:
            return s, s + m.end()
    raise ValueError(marker)


def strip_toast(h):
    if 'class="error-toasts"' not in h:
        return h
    s, e = block(h, 'class="error-toasts"')
    return h[:s] + h[e:]


SET, CALL = strip_toast(SET), strip_toast(CALL)


def lucide(body, size=14):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" '
            f'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{body}</svg>')


PHONE_I = lucide('<path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"/>')
DIRECT_I = lucide('<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>')
EAR_I = lucide('<path d="M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0"/><path d="M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"/>')
GEAR_I = lucide('<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>')
REFRESH_I = lucide('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>', 12)

# ---------- the sequence, as data ----------
MODE_SUB = {
    'Voice agent': 'A fast voice model talks with you and passes work to the chat’s agent.',
    'Direct': 'What you say goes to the chat’s agent as text, and its reply is read out.',
}
AGENT = {
    'Gemini': {'models': ['Gemini 2.5 Flash Native Audio', 'Gemini 3.8 Live Thinking'],
               'voices': ['Puck', 'Kore', 'Charon', 'Aoede']},
    'OpenAI': {'models': ['GPT Realtime 2.1 mini', 'GPT Realtime 2.1'],
               'voices': ['Marin', 'Cedar', 'Alloy', 'Verse']},
    'ElevenLabs': {'models': ['Claude Haiku 4.5', 'Claude Sonnet 4.5', 'Claude Sonnet 4', 'GPT-4.1', 'GPT-4.1 mini',
                              'GPT-4o', 'GPT-4o mini', 'Gemini 2.5 Flash', 'Gemini 2.5 Flash Lite', 'Custom LLM'],
                   'voices': ['Rachel', 'George', 'Charlotte', 'Brian']},
}
# Direct calls run speech to text and text to speech on the device you call from. Each device
# reports what it actually has (an installed on-device engine, or a cloud provider with a key);
# only those are offered, and a device with none can't make a direct call.
DEVICES = {
    'mac': {
        'name': 'this Mac',
        'stt': {'Parakeet': ('On device', ['Parakeet TDT 0.6B v3']),
                'Groq': ('Cloud', ['Whisper Large v3 Turbo', 'Whisper Large v3']),
                'ElevenLabs': ('Cloud', ['Scribe'])},
        'tts': {'Kokoro': ('On device', ['Kokoro 82M'], ['Heart (American F)', 'Emma (British F)', 'George (British M)']),
                'ElevenLabs': ('Cloud', ['Flash v2.5', 'Turbo v2.5', 'Multilingual v2', 'Eleven v3'], ['Rachel', 'George', 'Charlotte']),
                'OpenAI': ('Cloud', ['GPT-4o mini TTS', 'TTS-1 HD'], ['Marin', 'Cedar', 'Alloy'])},
    },
    'phone': {
        'name': 'this phone',
        'stt': {'Android': ('On device', ['Google on-device']),
                'Groq': ('Cloud', ['Whisper Large v3 Turbo', 'Whisper Large v3']),
                'ElevenLabs': ('Cloud', ['Scribe'])},
        'tts': {'Android': ('On device', ['Google text-to-speech'], ['English (UK) 1', 'English (UK) 2']),
                'ElevenLabs': ('Cloud', ['Flash v2.5', 'Turbo v2.5', 'Multilingual v2', 'Eleven v3'], ['Rachel', 'George', 'Charlotte']),
                'OpenAI': ('Cloud', ['GPT-4o mini TTS', 'TTS-1 HD'], ['Marin', 'Cedar', 'Alloy'])},
    },
}


def pills(label, opts, on, where=None):
    btn = []
    for o in opts:
        hint = f'<span class="vs-where">{where[o]}</span>' if where else ''
        cls = ' class="on"' if o == on else ''
        btn.append(f'<button type="button"{cls} aria-pressed="{str(o == on).lower()}">{o}{hint}</button>')
    return f'<div class="set-pills" role="group" aria-label="{label}">' + ''.join(btn) + '</div>'


def select(label, opts, on, open_=False):
    o = ''.join(f'<option{" selected" if x == on else ""}>{x}</option>' for x in opts)
    sel = f'<select aria-label="{label}">{o}</select>'
    if open_:
        items = ''.join(f'<div class="vs-opt{" on" if x == on else ""}">{x}</div>' for x in opts)
        sel = f'<div class="vs-select-wrap">{sel}<div class="vs-list" role="listbox">{items}</div></div>'
    return sel


def row(title, ctrl, sub=None, stack=False, step=None):
    sub_html = f'<span class="set-sub">{sub}</span>' if sub else ''
    n = ''
    cls = 'set-row stack set-row-choices' if stack else 'set-row'
    return (f'<div class="{cls}"><div class="set-row-text"><span class="set-row-title">{n}{title}</span>{sub_html}</div>'
            f'<div class="set-row-ctrl">{ctrl}</div></div>')


def fetched(provider, n):
    return f'{n} models <button type="button" class="set-link vs-refresh">{REFRESH_I}Refresh</button>'


# How the voice sounds: each provider's own controls, nothing more.
# Tone: written raw, the same field for every provider and kept per voice. Patch puts it in the
# voice's instructions as written; for ElevenLabs v3, any [bracketed] tags in it are also sent as
# suggested audio tags.
TONE = 'Calm and sincere. [slow] when explaining.'


SOUND = {
    'ElevenLabs': [('select', 'Speech model', None, ['Eleven v3 conversational', 'Eleven v4 Turbo', 'Eleven v4', 'Flash v2.5', 'Turbo v2.5', 'Multilingual v2'], 'Eleven v3 conversational'),
                   ('text', 'Tone', None, None, TONE),
                   ('toggle', 'Expressive mode', None, None, True),
                   ('slider', 'Stability', ('Expressive', 'Steady'), (0.0, 1.0, ''), 0.7),
                   ('slider', 'Similarity', None, (0.0, 1.0, ''), 0.8),
                   ('slider', 'Speed', ('Slower', 'Faster'), (0.7, 1.2, '×'), 0.95),
                   ('pills', 'Reply eagerness', None, ['Patient', 'Normal', 'Eager'], 'Patient')],
    'OpenAI': [('text', 'Tone', None, None, TONE),
               ('slider', 'Speed', ('Slower', 'Faster'), (0.25, 1.5, '×'), 1.0)],
    'Gemini': [('text', 'Tone', None, None, TONE),
               ('toggle', 'Match my tone', None, None, False)],
    'ElevenLabs TTS': [('text', 'Tone', None, None, TONE),
                       ('slider', 'Stability', ('Expressive', 'Steady'), (0.0, 1.0, ''), 0.7),
                       ('slider', 'Similarity', None, (0.0, 1.0, ''), 0.8),
                       ('slider', 'Style', None, (0.0, 1.0, ''), 0.0),
                       ('slider', 'Speed', ('Slower', 'Faster'), (0.7, 1.2, '×'), 0.95)],
    'Kokoro': [('slider', 'Speed', ('Slower', 'Faster'), (0.5, 2.0, '×'), 1.0)],
    'OpenAI TTS': [('text', 'Tone', None, None, TONE),
                   ('slider', 'Speed', ('Slower', 'Faster'), (0.25, 4.0, '×'), 1.0)],
}


def sound_rows(key):
    out = ''
    for kind, title, sub, opts, val in SOUND.get(key, []):
        stack = False
        if kind == 'slider':
            lo, hi, unit = opts
            ends = sub or ('', '')
            sub = None
            ctrl = (f'<span class="vs-slider"><span class="vs-end">{ends[0]}</span><input type="range" min="{lo}" max="{hi}" '
                    f'step="0.05" value="{val}" aria-label="{title}"><span class="vs-end">{ends[1]}</span>'
                    f'<span class="vs-val">{val:g}{unit}</span></span>')
        elif kind == 'toggle':
            ctrl = f'<span class="vs-toggle{" on" if val else ""}" role="switch" aria-checked="{str(val).lower()}"></span>'
        elif kind == 'select':
            ctrl = select(title, opts, val)
        elif kind == 'pills':
            ctrl = pills(title, opts, val)
        elif kind == 'tags':
            ctrl = ('<span class="vs-tags">' + ''.join(f'<span class="vs-tag">{t}<b>×</b></span>' for t in opts)
                    + '<input class="vs-tag-add" placeholder="Add a word" aria-label="Add a tone word"></span>')
            sub, stack = TONE_SUB[sub], True
        else:  # text: the tone, written raw
            ctrl = f'<textarea class="vs-text" rows="2" aria-label="{title}">{val}</textarea>'
            stack = True
        out += row(title, ctrl, sub, stack=stack)
    if out:
        out = f'<div class="vs-sound"><div class="vs-sound-head">How it sounds</div>{out}</div>'
    return out


def calls_group(on=True, auto=True):
    tog = lambda v: f'<span class="vs-toggle{" on" if v else ""}" role="switch" aria-checked="{str(v).lower()}"></span>'
    r = row('Agents can call you', tog(on), 'Rings every device')
    if on:
        r += row('Answer automatically in hands-free', tog(auto),
                 'Pauses playback while the agent talks')
    return (f'<section class="set-group"><h2 class="set-label">Agents calling you </h2>'
            f'<div class="set-card">{r}</div></section>')


def agent_group(provider=None, model=None, voice=None, open_models=False):
    """The voice agent: one setup for the account, it runs in the provider's cloud."""
    r = row('Provider', pills('Provider', list(AGENT), provider), None, stack=True, step=1)
    if provider:
        p = AGENT[provider]
        r += row('Model', select('Model', p['models'], model, open_models), fetched(provider, len(p['models'])), step=2)
        if model:
            r += row('Voice', select('Voice', p['voices'], voice), None, step=3)
            if voice:
                r += sound_rows(provider)
    return f'<section class="set-group"><h2 class="set-label">Voice agent</h2><div class="set-card">{r}</div></section>'


def device_group(dev, stt=None, stt_model=None, tts=None, tts_model=None, tts_voice=None, button='Voice agent'):
    """Direct calls from this device: only what this device has is offered."""
    d = DEVICES[dev]
    STT, TTS = d['stt'], d['tts']
    r = row('Speech to text', pills('Speech to text', list(STT), stt, {k: v[0] for k, v in STT.items()}),
            None, stack=True, step=1)
    if stt:
        r += row('Speech to text model', select('Speech to text model', STT[stt][1], stt_model), step=2)
        if stt_model:
            r += row('Text to speech', pills('Text to speech', list(TTS), tts, {k: v[0] for k, v in TTS.items()}),
                     stack=True, step=3)
            if tts:
                r += row('Text to speech model', select('Text to speech model', TTS[tts][1], tts_model),
                         fetched(tts, len(TTS[tts][1])) if TTS[tts][0] == 'Cloud' else None, step=4)
                if tts_model:
                    r += row('Voice', select('Voice', TTS[tts][2], tts_voice), None, step=5)
                    if tts_voice:
                        r += sound_rows({'ElevenLabs': 'ElevenLabs TTS', 'OpenAI': 'OpenAI TTS'}.get(tts, tts))
    return (f'<section class="set-group"><h2 class="set-label">Direct calls from {d["name"]}</h2>'
            f'<div class="set-card">{r}</div></section>')


CHEV_I = lucide('<path d="m9 18 6-6-6-6"/>', 14)
# Every linked device, from the account's device list. What each can run is what it last reported.
LINKED = [
    ('mac', 'MacBook Pro', 'Mac · this computer', 'Parakeet → Kokoro'),
    ('phone', 'Pixel 9', 'Android phone', 'Android → ElevenLabs'),
    (None, 'Work Mac', 'Mac · seen 2 days ago', 'Groq → ElevenLabs'),
    (None, 'Linux laptop', 'Linux · seen today', None),
]


def devices_group(open_dev=None, **steps):
    """Direct calls, set for every linked device from one place."""
    rows = ''
    for key, name, kind, summary in LINKED:
        is_open = key is not None and key == open_dev
        state = (f'<span class="vs-dev-sum">{summary}</span>' if summary
                 else '<span class="vs-dev-sum vs-dev-no">No speech engine</span>')
        rows += (f'<div class="set-row vs-dev" data-open="{str(is_open).lower()}"><div class="set-row-text">'
                 f'<span class="set-row-title">{name}</span><span class="set-sub">{kind}</span></div>'
                 f'<div class="set-row-ctrl">{state}<span class="vs-dev-chev">{CHEV_I}</span></div></div>')
        if is_open:
            inner = device_group(key, **steps)
            inner = inner[inner.index('<div class="set-card">') + len('<div class="set-card">'):inner.rindex('</div></section>')]
            rows += f'<div class="vs-dev-body">{inner}</div>'
    return f'<section class="set-group"><h2 class="set-label">Direct calls</h2><div class="set-card">{rows}</div></section>'


def engine(*groups):
    groups = (groups[0], calls_group()) + tuple(groups[1:])
    return f'<div data-testid="settings-voice-config">{"".join(groups)}</div>'


def settings_page(eng):
    s, e = block(SET, 'data-testid="settings-voice-config"', 'section')
    return SET[:s] + eng + SET[e:]


def page(title, body, css='proposal.css'):
    body = re.sub(r'<!--.*?-->', '', body, flags=re.S)
    body = re.sub(r'<script.*?</script>', '', body, flags=re.S)
    body = body.replace('<vite-error-overlay></vite-error-overlay>', '')
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title>'
            f'<link rel="stylesheet" href="real.css"><link rel="stylesheet" href="{css}"></head><body>{body}</body></html>')


screens = []


def out(fid, name, html):
    open(f'{fid}.html', 'w').write(html)
    screens.append({'id': fid, 'name': name, 'path': f'{fid}.html'})


AG = agent_group('ElevenLabs', 'Claude Haiku 4.5', 'Rachel')
out('settings-sound-elevenlabs', 'Settings · voice agent sound, ElevenLabs',
    page('Voice settings', settings_page(engine(AG, devices_group(None)))))
out('settings-sound-openai', 'Settings · voice agent sound, OpenAI',
    page('Voice settings', settings_page(engine(agent_group('OpenAI', 'GPT Realtime 2.1 mini', 'Marin'), devices_group(None)))))
out('settings-sound-gemini', 'Settings · voice agent sound, Gemini',
    page('Voice settings', settings_page(engine(agent_group('Gemini', 'Gemini 2.5 Flash Native Audio', 'Kore'), devices_group(None)))))
out('settings-agent-models', 'Settings · voice agent, model list',
    page('Voice settings', settings_page(engine(agent_group('ElevenLabs', 'Claude Haiku 4.5', 'Rachel', open_models=True),
                                                devices_group(None)))))
out('settings-direct-partway', 'Settings · a device partway set up',
    page('Voice settings', settings_page(engine(AG, devices_group('phone', stt='Android', stt_model='Google on-device')))))
out('settings-direct', 'Settings · every device in one place',
    page('Voice settings', settings_page(engine(AG, devices_group('mac', stt='Parakeet', stt_model='Parakeet TDT 0.6B v3',
                                                                    tts='Kokoro', tts_model='Kokoro 82M', tts_voice='Emma (British F)')))))
out('settings-devices', 'Settings · devices collapsed',
    page('Voice settings', settings_page(engine(AG, devices_group(None)))))

# ---------- the call button's menu ----------
chat = CALL
s, e = block(chat, 'class="voice-bar"')
chat = chat[:s] + chat[e:]
chat = chat.replace('class="call-btn live"', 'class="call-btn"')
menu = ('<div class="context-menu vs-callmenu" role="menu" aria-label="Call">'
        f'<button type="button" role="menuitem" class="context-menu-item">{PHONE_I}Call</button>'
        f'<button type="button" role="menuitem" class="context-menu-item" data-focus="true">{DIRECT_I}Call direct</button>'
        f'<button type="button" role="menuitem" class="context-menu-item">{EAR_I}Hands-free</button>'
        f'<button type="button" role="menuitem" class="context-menu-item">{GEAR_I}Voice settings</button></div>')
chat = chat.replace('</body>', '') + menu
out('call-menu', 'Call button menu · right-click', page('Call menu', chat))

# ---------- phone ----------
P_ICONS = {
    'back': '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
}


def ppills(opts, on, where=None):
    return '<div class="p-pills">' + ''.join(
        f'<span{" class=on" if o == on else ""}>{o}{f"<i class=vs-where>{where[o]}</i>" if where else ""}</span>' for o in opts) + '</div>'


def psel(v): return f'<div class="vs-psel">{v}<span>⌄</span></div>'


def prow(t, ctrl, sub=None):
    return f'<div class="p-row"><div class="rt">{t}</div>{f"<div class=vs-psub>{sub}</div>" if sub else ""}{ctrl}</div>'


def pslider(v, unit='', lo=0.0, hi=1.0, ends=None):
    pct = (v - lo) / (hi - lo) * 100
    e = f'<div class="vs-pends"><span>{ends[0]}</span><span>{ends[1]}</span></div>' if ends else ''
    return (f'<div class="vs-pslider"><span class="tr"><i style="width:{pct:.0f}%"></i><b style="left:{pct:.0f}%"></b></span>'
            f'<span class="v">{v:g}{unit}</span></div>{e}')


def ptog(t, sub=None):
    sub_html = f'<div class="vs-psub">{sub}</div>' if sub else ''
    return (f'<div class="p-row inline"><div><div class="rt">{t}</div>{sub_html}</div>'
            f'<span class="p-switch on"></span></div>')


def pengine():
    d = DEVICES['phone']
    STT, TTS = d['stt'], d['tts']
    ag = (prow('Provider', ppills(list(AGENT), 'ElevenLabs'))
          + prow('Model', psel('Claude Haiku 4.5'), '10 models') + prow('Voice', psel('Rachel'))
          + '<div class="vs-psound">How it sounds</div>'
          + prow('Speech model', psel('Eleven v3 conversational'))
          + prow('Tone', f'<div class="vs-ptext">{TONE}</div>')
          + ptog('Expressive mode')
          + prow('Stability', pslider(0.7, ends=('Expressive', 'Steady')))
          + prow('Similarity', pslider(0.8)) + prow('Speed', pslider(0.95, '×', 0.7, 1.2))
          + prow('Reply eagerness', ppills(['Patient', 'Normal', 'Eager'], 'Patient')))
    calls = (ptog('Agents can call you', 'Rings every device')
             + ptog('Answer automatically in hands-free', 'Pauses playback while the agent talks'))
    dev = ''
    for key, name, kind, summary in LINKED:
        st = summary or 'No speech engine'
        dev += (f'<div class="p-row vs-pdev"><div><div class="rt">{name}</div><div class="vs-psub">{kind}</div></div>'
                f'<div class="vs-pdev-sum{" vs-dev-no" if not summary else ""}">{st}</div></div>')
        if key == 'phone':
            dev += ('<div class="vs-pdev-body">'
                    + prow('Speech to text', ppills(list(STT), 'Android', {k: v[0] for k, v in STT.items()}))
                    + prow('Speech to text model', psel('Google on-device'))
                    + prow('Text to speech', ppills(list(TTS), 'ElevenLabs', {k: v[0] for k, v in TTS.items()}))
                    + prow('Text to speech model', psel('Flash v2.5'), '4 models')
                    + prow('Voice', psel('George'))
                    + '<div class="vs-psound">How it sounds</div>'
                    + prow('Tone', f'<div class="vs-ptext">{TONE}</div>')
                    + prow('Stability', pslider(0.7)) + prow('Similarity', pslider(0.8))
                    + prow('Style', pslider(0.0)) + prow('Speed', pslider(0.95, '×', 0.7, 1.2))
                    + '</div>')
    return (f'<div class="p-set"><div class="p-set-head">{P_ICONS["back"]}<h1>Voice</h1></div>'
            f'<div class="p-label">Voice agent</div><div class="p-card">{ag}</div>'
            f'<div class="p-label">Agents calling you</div><div class="p-card">{calls}</div>'
            f'<div class="p-label">Direct calls</div><div class="p-card">{dev}</div></div>')


def ppage(title, body):
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" '
            f'content="width=device-width,initial-scale=1"><title>{title}</title><link rel="stylesheet" href="phone.css">'
            f'<link rel="stylesheet" href="phone-proposal.css"></head><body><div class="screen">{body}</div></body></html>')


out('phone-settings', 'Phone · settings, every device', ppage('Voice settings', pengine()))

# Phone: long-press the call button in the chat header.
ph = open('phone-b.html').read()
pm = ('<div class="p-scrim"></div><div class="p-menu" style="right:96px;top:50px">'
      f'<div>{PHONE_I.replace("14", "20")}Call</div>'
      f'<div>{DIRECT_I.replace("14", "20")}Call direct</div>'
      f'<div>{EAR_I.replace("14", "20")}Hands-free</div><hr><div>{GEAR_I.replace("14", "20")}Voice settings</div></div>')
s, e = block(ph, 'class="p-call"')
ph = ph[:s] + ph[e:]
ph = ph.replace('<div class="screen">', '<div class="screen">' + pm, 1)
open('phone-call-menu.html', 'w').write(ph)
screens.append({'id': 'phone-call-menu', 'name': 'Phone · long-press the call button', 'path': 'phone-call-menu.html'})

pad = json.load(open('pad.json'))
pad['screens'] = [x for x in pad['screens'] if x['id'] not in {s['id'] for s in screens}]
order = ['settings-sound-elevenlabs', 'settings-sound-openai', 'settings-sound-gemini', 'phone-settings',
         'settings-devices', 'settings-direct', 'settings-direct-partway', 'settings-agent-models',
         'call-menu', 'phone-call-menu']
by = {s['id']: s for s in screens}
pad['screens'] = [by[i] for i in order] + pad['screens']
json.dump(pad, open('pad.json', 'w'), indent=1)
print('built', order)
