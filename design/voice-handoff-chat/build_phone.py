# Phone versions, on the Android app's look (design/_kit/phone/phone.css, checked
# against _kit/phone/reference/call-panel.png and chat.png).
# Run after build.py: python3 build_phone.py
import json, random, shutil

random.seed(3)
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
    'ear': ic('<path d="M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0"/><path d="M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"/>'),
    'search': ic('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
    'more': ic('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
    'mic': ic('<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>', 18),
    'end': ic('<path d="M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 '
              '18 18 0 0 1-12.728-5.272"/><path d="M22 2 2 22"/><path d="M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 '
              '2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473"/>', 18),
    'swap': ic('<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>', 15, 1.75),
    'up-r': ic('<path d="M7 7h10v10"/><path d="M7 17 17 7"/>', 15, 1.75),
    'down-l': ic('<path d="M17 7 7 17"/><path d="M17 17H7V7"/>', 15, 1.75),
    'arrow': ic('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>', 12, 2),
    'chev': ic('<path d="m9 18 6-6-6-6"/>', 16),
    'speaker': ic('<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/>', 15, 1.5),
}


def page(title, body):
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" '
            f'content="width=device-width,initial-scale=1"><title>{title}</title><link rel="stylesheet" '
            f'href="phone.css"><link rel="stylesheet" href="phone-proposal.css">'
            f'<script>addEventListener("load",()=>document.querySelectorAll(".p-stream").forEach(s=>s.scrollTop=s.scrollHeight))</script>'
            f'</head><body><div class="screen">{body}</div></body></html>')


HEAD = (f'<div class="p-head"><span class="back">{I["back"]}</span><div class="titles"><div class="folder">portfolio · Mac</div>'
        f'<div class="title">Voice call design</div></div><span class="ic">{I["phone"]}</span><span class="ic">{I["ear"]}</span>'
        f'<span class="ic">{I["search"]}</span><span class="ic">{I["more"]}</span></div>')


def vuser(t): return f'<div class="p-user p-voice"><span class="vm">{I["phone-s"]}</span><div class="b t">{t}</div></div>'
def voice(t): return f'<div class="p-agent p-voice"><span class="vm">{I["phone-s"]}</span><div class="t">{t}</div></div>'
def agent(t): return f'<div class="p-agent p-voice"><span class="vm" title="Read out on the call">{I["speaker"]}</span><div>{t}</div></div>'


def dirl(a, b): return f'<span class="ph-dir">{a}<span class="ph-arrow">{I["arrow"]}</span>{b}</span>'


def row_one(direction, text, state):
    icon, who = (I['up-r'], dirl('Voice', 'Agent')) if direction == 'to' else (I['down-l'], dirl('Agent', 'Voice'))
    return (f'<div class="ph-ho"><span class="vm">{icon}</span><div class="ph-main"><div class="ph-top">{who}'
            f'<span class="ph-state">{state}</span><span class="ph-chev">{I["chev"]}</span></div>'
            f'<div class="ph-text">{text}</div></div></div>')


def pair(q, a, state, open_=False, working=False):
    st = f'<span class="ph-state">{"<span class=p-spin></span>" if working else ""}{state}</span>'
    body = ''
    if open_:
        body = (f'<div class="ph-body"><div>{dirl("Voice", "Agent")}<p>{q}</p></div>'
                + (f'<div>{dirl("Agent", "Voice")}<p>{a}</p></div>' if a else '') + '</div>')
    text = '' if open_ else f'<div class="ph-text">{q}</div>'
    return (f'<div class="ph-ho" data-open="{str(open_).lower()}"><span class="vm">{I["swap"]}</span><div class="ph-main">'
            f'<div class="ph-top"><span class="ph-dir">Asked the agent</span>{st}<span class="ph-chev">{I["chev"]}</span></div>'
            f'{text}{body}</div></div>')


def wave(n=60):
    return '<span class="p-wave">' + ''.join(
        f'<i style="height:{random.randint(4, 20)}px;animation-delay:-{random.random():.2f}s"></i>' for _ in range(n)) + '</span>'


def call(mode):
    status = ('<span class="ph-status"><b>Direct</b><span class="p-spin"></span>Agent working · 0:42</span>' if mode == 'direct' else wave())
    who = '<span class="p-segc"><span class="on">Call</span><span>Hands-free</span></span>'
    return (f'<div class="p-call"><div class="top">{status}<span class="tm">4:12</span></div>'
            f'<div class="ctl"><span class="p-btn mute">{I["mic"]}Mute</span>{who}'
            f'<span class="p-btn end">{I["end"]}End</span></div></div>')


Q1 = 'What Android APIs fire when headphones are disconnected and reconnected, and can the app pause and resume without dropping the call?'
A1 = ('Yes. Android warns the app before audio moves to the speaker, and reports when a device is removed and added again. '
      'Earbuds that sense being taken out send a "pause" press.')
Q2 = 'What does ElevenLabs charge for a silent open session, from 30 seconds to an hour?'

OPEN = (vuser('I take my headphone out to talk to somebody, everything pauses. I put it back in and it picks up where it was.')
        + voice('Right, so the call stays open and only the audio pauses. Let me check what Android gives us.'))
MID = (voice('Android gives us what we need: it tells us when headphones go and come back.')
       + vuser('What would a silent call cost us?')
       + voice("Good question. I've asked the agent, it's on it."))


def stream(inner): return f'<div class="p-stream"><div class="spacer"></div>{inner}</div>'


screens = []


def out(fid, name, body):
    open(f'{fid}.html', 'w').write(page(name, body))
    screens.append({'id': fid, 'name': name, 'path': f'{fid}.html'})


out('phone-a', 'Phone · A · one row per direction',
    HEAD + stream(OPEN + row_one('to', Q1, '15:31') + row_one('from', A1, '38s') + MID
                  + row_one('to', Q2, 'working 0:24')) + call('voice'))
out('phone-b', 'Phone · B · one row per hand-off',
    HEAD + stream(OPEN + pair(Q1, A1, 'answered · 38s') + MID + pair(Q2, None, 'working 0:24', working=True)) + call('voice'))
out('phone-b-open', 'Phone · B · hand-off opened',
    HEAD + stream(OPEN + pair(Q1, A1, 'answered · 38s', open_=True) + MID) + call('voice'))
out('phone-direct', 'Phone · direct call, agent working',
    HEAD + stream(vuser('What does Android give us when headphones come out?')
                  + agent('<p>It tells the app when headphones are removed and added again, so the call can pause and pick up.</p>')
                  + vuser('What would a silent call cost on ElevenLabs, for ten minutes or an hour?')
                  + agent('<p>Roughly pennies. Silence is billed at a fraction of the normal rate: about 5 cents for ten '
                          'minutes, 25 cents for an hour.</p>')
                  + vuser('Can we close the session while paused and keep the context?')
                  + '<div class="ph-working"><span class="p-spin"></span>Agent working · 0:42</div>'
                  + vuser('Also check the hand-off queue.') + '<div class="ph-queued">Queued</div>')
    + call('direct'))

desk = json.load(open('pad.json'))['screens']
order = [desk[0], screens[0], desk[1], screens[1], desk[2], screens[2], desk[3], screens[3]]
json.dump({'screens': order}, open('pad.json', 'w'), indent=1)
# build_settings.py appends the settings and call-menu screens.
print('built', [s['id'] for s in screens])
