import sys, os
D = sys.argv[1]
I = {
 'cl':'<path d="m15 18-6-6 6-6"/>','cr':'<path d="m9 18 6-6-6-6"/>',
 'cd':'<path d="m6 9 6 6 6-6"/>','cu':'<path d="m18 15-6-6-6 6"/>',
 'x':'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
 'ext':'<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
 'pen':'<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
 'arc':'<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
 'more':'<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
 'ok':'<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
 'tgt':'<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
 'spin':'<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
 'art':'<rect width="18" height="7" x="3" y="3" rx="1"/><rect width="9" height="7" x="3" y="14" rx="1"/><rect width="5" height="7" x="16" y="14" rx="1"/>',
}
def ic(n, cls='', size=18):
    return f'<svg viewBox="0 0 24 24" class="{cls}" style="width:{size}px;height:{size}px">{I[n]}</svg>'

def head(pill):
    p = '<span class="pill">OpenNext review and repair · running</span>' if pill else ''
    return f'''<header class="head"><div class="side">{ic('cl')}{ic('cr')}</div>
<div class="mid"><h1 class="title">opennext mocks</h1>{p}<span class="ico">{ic('ext',size=16)}</span></div>
<div class="side r">{ic('pen')}{ic('arc')}{ic('more')}</div></header>'''

TRANSCRIPT = '''<div class="transcript"><div class="bubble"><small>SCOPE</small><br>Which things should the agent look at? Nothing is attached to your message, so I want to be sure I'm looking at the right ones.</div></div>'''

def page(title, body, extra_css=''):
    return f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title>
<link rel="stylesheet" href="base.css"><style>{extra_css}</style></head><body><div class="panel">{body}</div></body></html>'''

# ---------- BEFORE (today) ----------
before_css = '''
.pill{background:#e8e2d4;color:var(--ink-2);border-radius:999px;padding:3px 10px;font-size:14px;font-weight:500}
.gb{padding:4px 16px;font-size:15px;color:var(--ink-2);border-bottom:1px solid var(--line-soft)}
.gb .m{display:flex;align-items:center;gap:8px}.gb .lab{font-size:14px;color:var(--ink-3);border:1px solid var(--line-soft);border-radius:6px;padding:0 6px}
.gb .t{flex:1;color:var(--ink)}.gb .meta{font-size:14px;padding-left:24px;line-height:1.4}
.bt{display:flex;padding:10px 16px;font-size:14px;color:var(--ink-2);border-bottom:1px solid var(--line-soft)}.bt .r{flex:1;display:flex;gap:16px;align-items:center}
.bt label{display:flex;gap:6px;align-items:center;color:var(--ink-3)}
.ab{padding:4px 16px;border-bottom:1px solid var(--line-soft)}.chip{display:inline-flex;gap:6px;align-items:center;border:1px solid #cfddc1;border-radius:6px;padding:2px 10px;font-size:14px;color:var(--ink-2);background:#fff;max-width:220px}
'''
before = head(True) + f'''
<div class="gb"><div class="m">{ic('tgt',size=16)}<span class="lab">Goal finished</span><span>27 Oct, 19:39</span><span class="t">Goal met: build this as you have it now, but it should all actually work</span>{ic('x',size=16)}</div>
<div class="meta">42m · 1 check · 69.5M tokens · The agent built OpenNext on real Cadence data and tested the flows in a browser against the real local stack and model: chat, approvals, app builder with publish, apps, workflows with a completed run, and Marketplace. I…</div></div>
<div class="bt"><div class="r"><span style="padding-left:24px">1 background task</span><label><input type="checkbox">Show all</label></div>{ic('cu',size=14)}</div>
<div class="bt"><div class="r">{ic('spin','spin',16)}<span>OpenNext review and repair</span><span style="color:var(--ink-3)">19m 30s</span></div></div>
<div class="ab"><span class="chip">{ic('art',size=14)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Cadence: two products, one platform</span></span></div>
''' + TRANSCRIPT

# ---------- AFTER ----------
after_css = '''
.stack{border-bottom:1px solid var(--line);padding:6px 0;background:var(--bg-panel)}
.row{display:grid;grid-template-columns:16px 72px minmax(0,1fr) auto 52px;column-gap:12px;align-items:center;min-height:32px;padding:0 28px;font-size:14px;line-height:20px;color:var(--ink)}
.row:hover{background:var(--bg-soft)}
.row .i{color:var(--ink-3);display:flex}.row .i.met{color:var(--goal-met)}.row .i.run{color:var(--accent)}
.row .k{color:var(--ink-3)}
.row .v{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .v b{font-weight:600}
.row .t{color:var(--ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.row .a{display:flex;justify-content:flex-end;gap:8px;color:var(--ink-3)}
.row .a svg{width:16px;height:16px}
.count{display:inline-flex;align-items:center;gap:4px;background:var(--bg-soft);border:1px solid var(--line-soft);border-radius:999px;padding:0 8px 0 10px;margin-right:8px;font-weight:600;line-height:20px}
.sub{grid-column:3 / 5;color:var(--ink-3);padding:0 0 8px;line-height:1.45;white-space:normal}
.links{display:flex;gap:16px;overflow:hidden}
.links a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}
.toggle{color:var(--ink-3);text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px}
@media (max-width:600px){.row{grid-template-columns:16px minmax(0,1fr) auto 44px;padding:0 16px}.row .k{display:none}.ck{display:none}.sub{grid-column:2 / 4}.head{padding:16px}.head .side.r{gap:12px}.head .side svg:nth-child(2){display:none}.title{font-size:19px}.head .side{flex:0 0 auto}.head .mid{flex:1;justify-content:center;padding:0 8px}}
'''
def row(icon, icls, key, val, t='', acts=''):
    return f'<div class="row"><span class="i {icls}">{icon}</span><span class="k">{key}</span><span class="v">{val}</span><span class="t">{t}</span><span class="a">{acts}</span></div>'

goal_row = row(ic('ok',size=16),'met','Goal','<b>Met</b> · build this as you have it now, but it should all actually work','27 Oct 19:39', ic('cd')+ic('x'))
agent_row = row(ic('spin','spin',16),'run','Agent','OpenNext review and repair','19m 30s')
task_row = row(ic('spin','spin',16),'run','Task','Dev server for opnnxt  <span style="color:var(--ink-3)">· listening on :3000</span>','4m', ic('x'))
art_row = row(ic('art',size=16),'','Artifacts','<span class="links"><a>Cadence: two products, one platform</a><a>Flow test report</a></span>')

after = head(False) + f'<div class="stack">{goal_row}{agent_row}{task_row}{art_row}</div>' + TRANSCRIPT

# ---------- AFTER, details open ----------
goal_open = f'''<div class="row"><span class="i met">{ic('ok',size=16)}</span><span class="k">Goal</span><span class="v"><b>Met</b> · build this as you have it now, but it should all actually work</span><span class="t">27 Oct 19:39</span><span class="a">{ic('cu')}{ic('x')}</span>
<span></span><span></span><span class="sub">42m · 1 check · 69.5M tokens. The agent built OpenNext on real Cadence data and tested the flows in a browser against the real local stack and model: chat, approvals, app builder with publish, apps, workflows with a completed run, and Marketplace.</span></div>'''
tasks_head = row(ic('spin','spin',16),'run','Tasks','<b>3 running</b> <span class="toggle" style="margin-left:12px">show ended</span>','', ic('cu'))
t1 = row('', '', '', 'Dev server for opnnxt <span style="color:var(--ink-3)">· listening on :3000</span>','4m', ic('x'))
t2 = row('', '', '', 'Playwright suite <span style="color:var(--ink-3)">· 41 of 63 passed</span>','2m', ic('x'))
t3 = row('', '', '', 'Watch CI on PR 412','1m', ic('x'))
details = head(False) + f'<div class="stack">{goal_open}{agent_row}{tasks_head}{t1}{t2}{t3}{art_row}</div>' + TRANSCRIPT

open(f'{D}/before.html','w').write(page('Before', before, before_css))
open(f'{D}/index.html','w').write(page('After', after, after_css))
open(f'{D}/details.html','w').write(page('After, opened', details, after_css))
open(f'{D}/pad.json','w').write('{"screens":[{"id":"after","name":"After","path":"index.html"},{"id":"details","name":"After, opened up","path":"details.html"},{"id":"before","name":"Before (today)","path":"before.html"}]}')

# ---------- AFTER, lots of agents ----------
agents_folded = row(ic('spin','spin',16),'run','Agents','<b>4 running</b> · 31 done · Block any ticket that loops, Check PR 1626, Fix Jira sync…','6h 02m', ic('cd'))
task_ck = row(ic('spin','spin',16),'run','Task','Block any ticket that loops through review','<span class="ck">check-in 18:01 · </span>5h 13m', ic('x'))
task2 = row(ic('spin','spin',16),'run','Task','Watch prod-1626 deploy log','12m', ic('x'))
many = head(False) + f'<div class="stack">{agents_folded}{task_ck}{task2}</div>' + TRANSCRIPT

agents_open = row(ic('spin','spin',16),'run','Agents','<b>4 running</b> · 31 done <span class="toggle" style="margin-left:12px">show done</span>','', ic('cu'))
a = [('Block any ticket that loops through review','6h 02m'),('Check PR 1626 against the Unite rules','41m'),('Fix the Jira sync for PLTFND','18m'),('Draft the release notes','3m')]
open_rows = ''.join(row('', '', '', n, t) for n,t in a)
many_open = head(False) + f'<div class="stack">{agents_open}{open_rows}{task_ck}{task2}</div>' + TRANSCRIPT

open(f'{D}/many.html','w').write(page('Many agents', many, after_css))
open(f'{D}/many-open.html','w').write(page('Many agents, opened', many_open, after_css))
open(f'{D}/pad.json','w').write('{"screens":[{"id":"after","name":"After","path":"index.html"},{"id":"details","name":"After, opened up","path":"details.html"},{"id":"many","name":"Lots of agents","path":"many.html"},{"id":"many-open","name":"Lots of agents, opened","path":"many-open.html"},{"id":"before","name":"Before (today)","path":"before.html"}]}')

I['pause'] = '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>'
I['tri_r'] = '<path d="M9 6l6 6-6 6" />'
GOAL = 'build this as you have it now, but it should all actually work'

# goal in progress rows
g_work = row(ic('tgt',size=16),'run','Goal',f'<b>Working</b> · {GOAL}','42m · 3 checks', ic('cd')+ic('x'))
g_work_open = f'''<div class="row"><span class="i run">{ic('tgt',size=16)}</span><span class="k">Goal</span><span class="v"><b>Working</b> · {GOAL}</span><span class="t">42m · 3 checks</span><span class="a">{ic('cu')}{ic('x')}</span>
<span></span><span></span><span class="sub">12.4M tokens so far. Last check, not met yet: the Marketplace page still loads mock data, and the workflow run hasn't been tested end to end. <span class="toggle">Edit goal</span></span></div>'''
g_pause = f'''<div class="row"><span class="i">{ic('pause',size=16)}</span><span class="k">Goal</span><span class="v"><b>Paused</b> · {GOAL}</span><span class="t">42m · 3 checks</span><span class="a">{ic('cd')}{ic('x')}</span>
<span></span><span></span><span class="sub" style="padding-bottom:6px">You stopped the chat. Send a message to resume.</span></div>'''

goal_page = head(False) + f'<div class="stack">{g_work}</div><div class="stack">{g_work_open}</div><div class="stack">{g_pause}</div>' + TRANSCRIPT
note_css = after_css + '.stack + .stack{border-top:8px solid var(--bg-app)}'

# multiples, folded
ag_f = row(ic('spin','spin',16),'run','Agents','<b>3 running</b> · OpenNext review and repair, Check PR 412, Draft notes','19m 30s', ic('cd'))
tk_f = row(ic('spin','spin',16),'run','Tasks','<b>2 running</b> · Dev server for opnnxt, Playwright suite','4m', ic('cd'))
ar_f = row(ic('art',size=16),'','Artifacts','<span class="links"><a>Cadence: two products, one platform</a><a>Flow test report</a><a>Marketplace audit</a></span>','<span class="toggle">+2 more</span>', ic('cd'))
multi = head(False) + f'<div class="stack">{g_work}{ag_f}{tk_f}{ar_f}</div>' + TRANSCRIPT

# multiples, opened
ag_o = row(ic('spin','spin',16),'run','Agents','<b>3 running</b> · 2 done <span class="toggle" style="margin-left:12px">show done</span>','', ic('cu'))
ag_rows = ''.join(row('','','',n,t) for n,t in [('OpenNext review and repair','19m 30s'),('Check PR 412 against the Unite rules','6m'),('Draft the release notes','1m')])
tk_o = row(ic('spin','spin',16),'run','Tasks','<b>2 running</b> <span class="toggle" style="margin-left:12px">show ended</span>','', ic('cu'))
tk_rows = row('','','','Dev server for opnnxt <span style="color:var(--ink-3)">· listening on :3000</span>','4m',ic('x')) + row('','','','Playwright suite <span style="color:var(--ink-3)">· 41 of 63 passed</span>','2m',ic('x'))
ar_o = row(ic('art',size=16),'','Artifacts','<b>5 published</b>','', ic('cu'))
ar_rows = ''.join(row('','','',f'<span class="links"><a>{n}</a></span>',t) for n,t in [('Cadence: two products, one platform','19:20'),('Flow test report','19:02'),('Marketplace audit','18:40'),('App builder walkthrough','18:12'),('Approvals screen notes','17:55')])
multi_open = head(False) + f'<div class="stack">{g_work}{ag_o}{ag_rows}{tk_o}{tk_rows}{ar_o}{ar_rows}</div>' + TRANSCRIPT

# chevron options
lab = lambda s: f'<div style="padding:14px 28px 4px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-3)">{s}</div>'
optA = row(ic('spin','spin',16),'run','Agents','<b>3 running</b> · OpenNext review and repair, Check PR 412…','19m 30s', ic('cd'))
optB = f'<div class="row"><span class="i run">{ic("spin","spin",16)}</span><span class="k" style="display:flex;align-items:center;gap:2px">Agents{ic("cr",size=14)}</span><span class="v"><b>3 running</b> · OpenNext review and repair, Check PR 412…</span><span class="t">19m 30s</span><span class="a"></span></div>'
optC = row(ic('spin','spin',16),'run','Agents','<b>3 running</b> · OpenNext review and repair, Check PR 412…','19m 30s', '<span class="toggle" style="text-decoration:none;font-size:14px">Show</span>')
optD = row(ic('spin','spin',16),'run','Agents','<span class="count">3 running ' + ic('cd',size=14) + '</span> OpenNext review and repair, Check PR 412…','19m 30s')
chev_css = after_css + '.count{display:inline-flex;align-items:center;gap:4px;background:var(--bg-soft);border:1px solid var(--line-soft);border-radius:999px;padding:0 8px 0 10px;margin-right:8px;font-weight:600}'
chev = head(False) + lab('A · chevron on the far right (current)') + f'<div class="stack">{optA}</div>' + lab('B · arrow after the label, like a folder tree') + f'<div class="stack">{optB}</div>' + lab('C · the word Show / Hide on the far right') + f'<div class="stack">{optC}</div>' + lab('D · the count is the button') + f'<div class="stack">{optD}</div>'

open(f'{D}/goal.html','w').write(page('Goal in progress', goal_page, note_css))
open(f'{D}/multi.html','w').write(page('Several of everything', multi, after_css))
open(f'{D}/multi-open.html','w').write(page('Several of everything, opened', multi_open, after_css))
open(f'{D}/chevron.html','w').write(page('Chevron options', chev, chev_css))
open(f'{D}/pad.json','w').write('{"screens":[{"id":"after","name":"After","path":"index.html"},{"id":"details","name":"After, opened up","path":"details.html"},{"id":"goal","name":"Goal in progress","path":"goal.html"},{"id":"multi","name":"Several of everything","path":"multi.html"},{"id":"multi-open","name":"Several of everything, opened","path":"multi-open.html"},{"id":"chevron","name":"Chevron options","path":"chevron.html"},{"id":"many","name":"Lots of agents","path":"many.html"},{"id":"many-open","name":"Lots of agents, opened","path":"many-open.html"},{"id":"before","name":"Before (today)","path":"before.html"}]}')

# ---------- apply option D everywhere: the bold count/status is the toggle ----------
import re
CD, CU = I['cd'], I['cu']
def svg(p): return f'<svg viewBox="0 0 24 24" class="" style="width:18px;height:18px">{p}</svg>'
for f in ['index','details','goal','multi','multi-open','many','many-open']:
    path = f'{D}/{f}.html'; html = open(path).read()
    rows = re.split(r'(?=<div class="row">)', html)
    out = []
    for r in rows:
        up = svg(CU) in r
        r = r.replace(svg(CD), '').replace(svg(CU), '')
        chev = f'<svg viewBox="0 0 24 24" style="width:14px;height:14px">{CU if up else CD}</svg>'
        r = re.sub(r'<b>(.*?)</b>( ·)?', lambda m: f'<span class="count">{m.group(1)} {chev}</span>', r, count=1)
        out.append(r)
    open(path,'w').write(''.join(out))
