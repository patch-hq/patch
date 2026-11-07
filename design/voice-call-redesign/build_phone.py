# Phone versions of the voice-call redesign, built on the Android app's look
# (design/_kit/phone/phone.css, checked against _kit/phone/reference/).
# Run after build.py: python3 build_phone.py
import json, random, shutil

random.seed(11)
shutil.copy('../_kit/phone/phone.css', 'phone.css')


def ic(body, size=24, sw=2):
    return (f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            f'stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round">{body}</svg>')


PHONE = ('<path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 '
         '0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"/>')
I = {
    'back': ic('<path d="m15 18-6-6 6-6"/>'),
    'phone': ic(PHONE),
    'phone-s': ic(PHONE, 15, 1.5),
    'more': ic('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
    'micoff': ic('<path d="M12 19v3"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M16.95 16.95A7 7 0 0 1 5 12v-2"/>'
                 '<path d="M18.89 13.23A7 7 0 0 0 19 12v-2"/><path d="m2 2 20 20"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/>', 20),
    'end': ic('<path d="M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 '
              '18 18 0 0 1-12.728-5.272"/><path d="M22 2 2 22"/><path d="M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 '
              '2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473"/>', 20),
    'plus': ic('<path d="M5 12h14"/><path d="M12 5v14"/>'),
    'mic': ic('<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>'),
    'shield': ic('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>'),
    'gauge': ic('<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>'),
    'user': ic('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/>'),
    'send': ic('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>', 18),
    'ear': ic('<path d="M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0"/><path d="M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"/>', 20),
    'gear': ic('<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>', 20),
    'chev-r': ic('<path d="m9 18 6-6-6-6"/>', 20),
    'chev-d': ic('<path d="m6 9 6 6 6-6"/>', 20),
    'x': ic('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 18),
    'camera': ic('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>', 22),
    'image': ic('<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>', 22),
    'clip': ic('<path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/>', 22),
    'stop': ic('<rect x="7" y="7" width="10" height="10" rx="1"/>', 16),
}


def page(title, body):
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" '
            f'content="width=device-width,initial-scale=1"><title>{title}</title><link rel="stylesheet" '
            f'href="phone.css"></head><body><div class="screen">{body}</div></body></html>')


def head(menu=''):
    return (f'<div class="p-head"><span class="back">{I["back"]}</span><div class="titles"><div class="folder">portfolio · Mac</div>'
            f'<div class="title">DuoPower plugs</div></div><span class="ic">{I["phone"]}{menu}</span>'
            f'<span class="ic">{I["more"]}</span></div>')


def user(t): return f'<div class="p-user"><div class="b">{t}</div></div>'
def vuser(t): return f'<div class="p-user p-voice"><span class="vm">{I["phone-s"]}</span><div class="b t">{t}</div></div>'
def voice(t): return f'<div class="p-agent p-voice"><span class="vm">{I["phone-s"]}</span><div class="t">{t}</div></div>'
def seg(t): return f'<div class="p-seg">{t}</div>'


def work(open_=False, done=False):
    if done:
        return '<div class="p-work" data-done="true"><div class="h">Agent answered in 1:14</div></div>'
    steps = ''
    if open_:
        steps = ('<div class="steps"><div>Searching the web: fischer DuoPower load →</div>'
                 '<div>Fetching the DuoPower data sheet →</div><div>Reading the load table →</div></div>')
    return (f'<div class="p-work"><div class="h"><span class="chev">{I["chev-d"] if open_ else I["chev-r"]}</span>'
            f'<span class="p-spin"></span>Agent is working <span class="tm">0:42</span></div>{steps}</div>')


TABLE = ('<div class="p-agent"><p>Safe working load per plug, from Fischer\'s data sheet:</p>'
         '<table class="p-table"><tr><th></th><th>6×30</th><th>6×50</th><th>8×65</th></tr>'
         '<tr><td>Brick</td><td>50 kg</td><td>55 kg</td><td>70 kg</td></tr>'
         '<tr><td>Concrete</td><td>95 kg</td><td>165 kg</td><td>230 kg</td></tr>'
         '<tr><td>Plasterboard</td><td>15 kg</td><td>15 kg</td><td>—</td></tr></table>'
         '<p>The longer plugs only pay off in concrete or soft blockwork.</p></div>')

OPENING = (seg('Call · Gemini Live · 16:36')
           + vuser("When should I use the 30 mil plugs and when the 50 or 65?")
           + voice('Thirty for light jobs in brick or concrete, the longer ones for soft blockwork. Want the weight limits?')
           + vuser('Yeah, what weight can each one take?')
           + voice("I'll get the agent to look that up."))


def wave(n=40):
    return '<span class="p-wave">' + ''.join(
        f'<i style="height:{random.randint(5, 24)}px;animation-delay:-{random.random():.2f}s"></i>' for _ in range(n)) + '</span>'


def strip():
    """The call, pinned to the top of every screen while it runs; tap it to go back to the chat."""
    return (f'<div class="p-strip"><span class="lbl">{I["phone-s"]}On call</span><span class="len">1:58</span>{wave(120)}'
            f'<span class="sb mute" aria-label="Mute">{I["micoff"]}</span>'
            f'<span class="sb end" aria-label="End call">{I["end"]}</span></div>')


COMPOSER = (f'<div class="p-comp"><div class="p-input">{I["plus"]}<span class="ph">Message</span>{I["mic"]}</div>'
            f'<div class="p-tools">{I["shield"]}<span class="p-model">Opus 5.5 ⌄</span>{I["gauge"]}{I["user"]}'
            f'<span class="p-send">{I["send"]}</span></div></div>')


def stream(inner):
    return f'<div class="p-stream"><div class="spacer"></div>{inner}</div>'


screens = []


def out(fid, name, html):
    open(f'{fid}.html', 'w').write(html)
    screens.append({'id': fid, 'name': name, 'path': f'{fid}.html'})


AFTER = (OPENING + work(done=True) + TABLE + seg('Voice')
         + voice("Fifty to seventy kilos each in brick, about double in concrete. The table's in the chat.")
         + vuser('Great, thanks.'))

out('phone-call', 'Phone · call, agent working', page('Phone call', strip() + head() + stream(OPENING + work()) + COMPOSER))
out('phone-call-open', 'Phone · agent working, opened', page('Phone call', strip() + head() + stream(OPENING + work(True)) + COMPOSER))
out('phone-done', 'Phone · agent answered', page('Phone call', strip() + head() + stream(AFTER) + COMPOSER))
out('phone-ended', 'Phone · call ended', page('Phone call', head() + stream(AFTER + '<div class="p-sum">Call 3:26 · Gemini Live · 2¢</div>') + COMPOSER))

menu = (f'<div class="p-scrim"></div><div class="p-menu" style="right:-40px;top:46px">'
        f'<div>{I["phone"]}Call</div><div>{I["ear"]}Hands-free</div><hr><div>{I["gear"]}Voice settings</div></div>')
out('phone-call-menu', 'Phone · long-press the call button', page('Call menu', head(menu) + stream(TABLE) + COMPOSER))

CHATS = (f'<div class="p-list-head"><span class="brand">patch</span></div>'
         '<div class="p-list">'
         + ''.join(f'<div class="p-chatrow"><div class="nm">{n}</div><div class="sub">{d}</div></div>'
                   for n, d in [('DuoPower plugs', 'portfolio · on call'), ('Reeling doorbell cable connectors', 'portfolio'),
                                ('Delivery monitor setup', 'Unite'), ('Four Seasons tea', 'portfolio')])
         + '</div>')
out('phone-elsewhere', 'Phone · call strip on other screens', page('Chats', strip() + CHATS))

DICT = ("Okay, problems with this. Some of it went reasonably well. ElevenLabs Haiku is never going to work very well, "
        "and it costs 30 cents, which is quite a lot. ElevenLabs Haiku and Sonnet should be a sub-setting, so you pick "
        "the provider and then the variant of that provider. It's got hands-free hand-off, when needed, always and "
        "never, and I don't know what that's supposed to mean. <span class='live'>same with call hand-off</span>")
dict_comp = (f'<div class="p-comp"><div class="p-dict"><div class="grip"></div>'
             f'<span class="cancel" aria-label="Cancel dictation">{I["x"]}</span><div class="txt">{DICT}</div>'
             f'<div class="bar">{I["camera"]}{I["image"]}{I["clip"]}{wave(22)}'
             f'<span class="p-send" style="margin-left:0;background:var(--leaf);color:var(--on-accent)">{I["send"]}</span>'
             f'</div></div></div>')
out('phone-dictation', 'Phone · dictation, quarter height', page('Dictation', head() + stream(TABLE) + dict_comp))


def pills(opts, on):
    return '<div class="p-pills">' + ''.join(f'<span{" class=\"on\"" if o == on else ""}>{o}</span>' for o in opts) + '</div>'


def row(t, ctrl): return f'<div class="p-row"><div class="rt">{t}</div>{ctrl}</div>'
def irow(t, on): return f'<div class="p-row inline"><div class="rt">{t}</div><span class="p-switch{" on" if on else ""}"></span></div>'
def card(label, rows): return f'<div class="p-label">{label}</div><div class="p-card">{rows}</div>'


MODELS = {
    'Gemini Live': (['2.5 Flash · 1¢ a min', '3.8 Live Thinking'], '2.5 Flash · 1¢ a min'),
    'OpenAI Realtime': (['Realtime 2.1 mini', 'Realtime 2.1'], 'Realtime 2.1 mini'),
    'ElevenLabs Agents': (['Claude Haiku 4.5 · 9¢ a min', 'Claude Sonnet 4.5', 'Gemini 2.5 Flash', 'GPT-4.1 mini'],
                          'Claude Haiku 4.5 · 9¢ a min'),
}
PROMPT = ("You are the voice of this conversation. The user is talking, out loud, to the same chat they have been "
          "typing in.\n\nAnswer in one or two short sentences. Offer more only if asked.\n\nIf you don't know "
          "something, or it needs looking up, their data, a tool or an action, pass it to the agent and say so in a "
          "few words.\n\nWhile the agent is working, don't offer to look it up again. When its answer arrives, give "
          "the gist in a sentence; the full answer is in the chat.\n\nSilence and noise are not requests: say nothing.")


def settings(mode, provider=None, tidy=True):
    rows = row('Kind of call', pills(['Real-time', 'Turn-based'], mode))
    if mode == 'Real-time':
        opts, on = MODELS[provider]
        rows += row('Provider', pills(list(MODELS), provider)) + row('Model', pills(opts, on)) + irow('Can ask the agent', True)
    else:
        rows += row('Speech to text', pills(['Groq Whisper', 'Whisper on host', 'Parakeet on host', 'ElevenLabs Scribe'], 'Groq Whisper'))
        rows += row('Text to speech', pills(['Kokoro on host', 'ElevenLabs'], 'ElevenLabs'))
    body = card('Calls', rows)
    if mode == 'Real-time':
        body += card('Voice instructions',
                     f'<div class="p-row"><div class="rt">What the voice is told</div>{pills(["Default", "Custom"], "Custom")}'
                     f'<textarea class="p-prompt">{PROMPT}</textarea><div class="p-acts"><span>Cancel</span>'
                     f'<span class="pri">Save</span></div></div>')
    trows = row('Tidy up each phrase with', pills(['Off', 'Groq Whisper', 'Whisper on host', 'Parakeet on host'],
                                                  'Parakeet on host' if tidy else 'Off'))
    body += card('Dictation',
                 row('Phone', pills(['Android speech recognizer', 'Deepgram', 'ElevenLabs Scribe', 'Parakeet on host'],
                                    'Android speech recognizer'))
                 + row('Computer', pills(['Deepgram', 'ElevenLabs Scribe', 'Parakeet on this computer'], 'Deepgram')) + trows)
    return (f'<div class="p-set"><div class="p-set-head">{I["back"].replace("m15 18-6-6 6-6", "M19 12H5M12 19l-7-7 7-7")}'
            f'<h1>Voice</h1></div>{body}</div>')


out('phone-settings', 'Phone · settings, real-time', page('Voice settings', settings('Real-time', 'Gemini Live')))
out('phone-settings-el', 'Phone · settings, ElevenLabs', page('Voice settings', settings('Real-time', 'ElevenLabs Agents')))
out('phone-settings-tb', 'Phone · settings, turn-based', page('Voice settings', settings('Turn-based', tidy=False)))

pad = json.load(open('pad.json'))
pad['screens'] = [s for s in pad['screens'] if not s['id'].startswith('phone-')]
desktop = [dict(s, name='Desktop · ' + s['name'].split(' · ', 1)[-1] if s['name'].startswith('Desktop · ') else 'Desktop · ' + s['name']) for s in pad['screens']]
# phone first, then desktop: Tom reviews on the phone
pad['screens'] = screens + desktop
json.dump(pad, open('pad.json', 'w'), indent=1)
print('phone screens', len(screens))
