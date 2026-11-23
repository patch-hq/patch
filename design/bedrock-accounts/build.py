# Builds the Bedrock-accounts screens from Patch's real markup and stylesheet,
# captured from the dev harness (_captured/*.html, real.css). Run: python3 build.py
import re, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
C = lambda n: open(f'_captured/{n}').read()

def clean(h, title):
    h = re.sub(r'<script\b.*?</script>', '', h, flags=re.S)
    h = re.sub(r'<link[^>]*>', '', h)
    h = re.sub(r'<style\b.*?</style>', '', h, flags=re.S)
    h = re.sub(r'<title>.*?</title>', f'<title>{title}</title>', h, flags=re.S)
    h = h.replace('</head>', '<link rel="stylesheet" href="real.css"><link rel="stylesheet" href="pad.css"></head>', 1)
    h = h.replace('Empty group', 'Settings')
    return h

def one(h, old, new):
    if h.count(old) != 1:
        raise SystemExit(f'expected exactly one: {old[:80]}')
    return h.replace(old, new)

# ---------- One Claude list: every account has an Auto checkbox ----------
AUTO = lambda on: f'<input type="checkbox" class="acct-auto" aria-label="Switch to automatically"{" checked" if on else ""}>'

def bedrock(id_, title, host, profile, region, extra='', menu='', auto=False, rank=None):
    lead = (f'<button type="button" class="set-handle" title="Drag to reorder">⠿</button><span class="set-rank">{rank}</span>'
            if auto else '<span></span><span></span>')
    return (f'<div class="set-ranked-item"><div class="set-acct" data-testid="account-bedrock-{id_}">{AUTO(auto)}{lead}'
            f'<div class="set-acct-body"><span class="set-row-title">{title}<span class="acct-kind">Bedrock</span></span>'
            f'<div class="set-bars">'
            f'<div class="set-bar-row"><span class="set-bar-label">Host</span><span class="acct-val">{host}</span></div>'
            f'<div class="set-bar-row"><span class="set-bar-label">AWS profile</span><span class="acct-val">{profile}</span></div>'
            f'<div class="set-bar-row"><span class="set-bar-label">Region</span><span class="acct-val">{region}</span></div>'
            f'{extra}</div></div>'
            f'<div class="set-acct-more"><button type="button" class="set-btn ghost set-more" aria-label="{title} actions">⋯</button>{menu}</div></div></div>')

SPEND = ('<div class="set-bar-row"><span class="set-bar-label">Monthly</span>'
         '<span class="set-bar" aria-hidden="true"><i style="width: 18%;"></i></span>'
         '<span class="set-bar-value">18%</span><span class="set-bar-reset">resets Dec 1</span></div>'
         '<div class="set-bar-row"><span class="set-bar-label">Spent</span><span class="acct-val">$18.42 of $100 cap · estimated</span></div>')
EXPIRED = '<div class="set-bar-row"><span class="set-bar-label">Status</span><span class="acct-val set-error">AWS sign-in expired</span></div>'
MENU = ('<div class="set-acct-menu" role="menu">'
        '<button type="button" role="menuitem" class="set-acct-menu-item"><span class="set-acct-menu-label">Edit</span></button>'
        '<button type="button" role="menuitem" class="set-acct-menu-item danger"><span class="set-acct-menu-label">Remove</span></button>'
        '</div>')
HEAD = '<div class="acct-head"><span>Auto</span><span>Account</span></div>'

def pills(label, opts, on):
    b = ''.join(f'<button type="button" class="{"on" if o == on else ""}" aria-pressed="{str(o == on).lower()}">{o}</button>' for o in opts)
    return f'<div class="set-pills" role="group" aria-label="{label}">{b}</div>'

ADD_FORM = ('<form class="set-row stack set-form">'
    '<span class="set-row-title bedrock-form-title">Add Amazon Bedrock account</span>'
    '<label class="set-field"><span class="set-row-title">Name</span><input value="Work Bedrock"></label>'
    '<div class="set-field"><span class="set-row-title">Host</span>' + pills('Host', ['mac-mini', 'hetzner'], 'mac-mini') + '</div>'
    '<div class="set-field"><span class="set-row-title">AWS profile</span>' + pills('AWS profile', ['default', 'work-bedrock', 'client-x'], 'work-bedrock') + '</div>'
    '<label class="set-field"><span class="set-row-title">Region</span><input class="mono" value="eu-west-2"></label>'
    '<div class="set-field"><span class="set-row-title">Requests run in</span>' + pills('Requests run in', ['Auto (EU)', 'EU', 'US', 'APAC', 'Japan', 'Australia', 'Global'], 'Auto (EU)') + '</div>'
    '<label class="set-field"><span class="set-row-title">Monthly cap</span><input class="mono bedrock-cap" value="$100"></label>'
    '<label class="acct-auto-label"><input type="checkbox" class="acct-auto"> Switch to automatically</label>'
    '<div class="set-actions"><span class="set-spacer"></span><button type="button" class="set-btn ghost">Cancel</button>'
    '<button type="submit" class="set-btn primary">Add</button></div>'
    '</form>')

ADD_CHOICE = ('<div class="set-inline set-add-bar start"><div class="set-acct-more bedrock-add">'
    '<button type="button" class="set-btn" aria-expanded="true">Add account</button>'
    '<div class="set-acct-menu bedrock-add-menu" role="menu">'
    '<button type="button" role="menuitem" class="set-acct-menu-item"><span class="set-acct-menu-label">Claude subscription</span></button>'
    '<button type="button" role="menuitem" class="set-acct-menu-item"><span class="set-acct-menu-label">Amazon Bedrock</span></button>'
    '</div></div></div>')

usage = C('usage.html')
# every subscription row gets the checkbox, ticked
usage = re.sub(r'(<div class="set-acct" data-testid="account-claude-code-a\d">)', r'\1' + AUTO(True).replace('\\', '\\\\'), usage)
usage = one(usage, '<div class="set-ranked" data-testid="accounts-rank-claude-code">', HEAD + '<div class="set-ranked" data-testid="accounts-rank-claude-code">')
RANKED_END = '</div></div></div><div class="set-inline set-add-bar start"><button type="button" class="set-btn" data-testid="add-claude-account">Add account</button></div></section>'
ADD_BAR = '<div class="set-inline set-add-bar start"><button type="button" class="set-btn" data-testid="add-claude-account">Add account</button></div></section>'

def usage_screen(extra, title, add_bar=None, target='[data-testid="strategy-row-claude-code"]', block='start', after_list=''):
    # Bedrock rows join the same ranked list, after the ticked ones
    h = one(usage, RANKED_END, extra + '</div>' + after_list + '</div></div>' + (add_bar or ADD_BAR))
    h = clean(h, title)
    h = h.replace('</body>', '<script>addEventListener("load",()=>document.querySelector(\'' + target + '\').scrollIntoView({block:"' + block + '"}))</script></body>')
    return h

WORK = lambda menu='': bedrock('work', 'Work Bedrock', 'mac-mini', 'work-bedrock', 'eu-west-2', SPEND, menu)
CLIENT = bedrock('client', 'Client X', 'hetzner', 'client-x', 'us-east-1', EXPIRED)
open('index.html', 'w').write(usage_screen(WORK() + CLIENT, 'Usage'))
open('add-choice.html', 'w').write(usage_screen(WORK() + CLIENT, 'Add account', ADD_CHOICE + '</section>', '.bedrock-add', 'center'))
open('add.html', 'w').write(usage_screen(CLIENT, 'Add Bedrock account', '</section>', '.set-form', 'start', ADD_FORM))
open('menu.html', 'w').write(usage_screen(WORK(MENU) + CLIENT, 'Account actions'))

# ---------- Settings → Chats: which account titles and status use ----------
chats = C('chats.html')
chats = one(chats, '</div></div></div></section><section class="set-group" data-testid="settings-sidebar">',
    '</div></div><div class="set-row"><div class="set-row-text"><span class="set-row-title">Account for titles and status</span></div>'
    '<div class="set-row-ctrl"><select aria-label="Account for titles and status"><option>Automatic</option><option>Personal</option><option>Max</option><option>Work Bedrock</option></select></div></div>'
    '</div></section><section class="set-group" data-testid="settings-sidebar">')
chats = re.sub(r'(data-testid="snooze-morning-hour">.*?<option value="9")', r'\1 selected', chats, count=1, flags=re.S)
chats = re.sub(r'(data-testid="snooze-evening-hour">.*?<option value="17")', r'\1 selected', chats, count=1, flags=re.S)
open('chats.html', 'w').write(clean(chats, 'Chats'))

# ---------- chat account picker (chat on mac-mini) ----------
chat = C('chat-picker.html')
chat = one(chat, '<span class="model-option-name">Always Max</span></button>',
    '<span class="model-option-name">Always Max</span></button>'
    '<button type="button" role="option" class="model-option" aria-selected="false" data-value="b1">'
    '<span class="model-option-name">Always Work Bedrock (pay per use)</span></button>')
chat = one(chat, 'Now on Personal. Moves to another account when one runs out.', 'Current: Personal')
open('chat.html', 'w').write(clean(chat, 'Chat account'))

# ---------- new chat (host mac-mini chosen) ----------
nc = C('new-chat.html')
nc = one(nc, 'data-testid="new-chat-account-a2" aria-checked="false">Max</button>',
    'data-testid="new-chat-account-a2" aria-checked="false">Max</button>'
    '<button type="button" role="radio" class="folder-quick" aria-checked="false">Work Bedrock</button>')
nc = one(nc, '<span class="new-chat-usage-backend">Claude</span></div><p class="new-chat-usage-empty">not read yet</p></div></div></section>',
    '<span class="new-chat-usage-backend">Claude</span></div><p class="new-chat-usage-empty">not read yet</p></div>'
    '<div class="new-chat-usage-card selectable" role="button" tabindex="0"><div class="new-chat-usage-name"><span>Work Bedrock</span>'
    '<span class="new-chat-usage-backend">Bedrock</span></div><p class="new-chat-usage-empty">$18.42 of $100 this month · estimated</p></div></div></section>')
open('new-chat.html', 'w').write(clean(nc, 'New chat'))
print('built')
