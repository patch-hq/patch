// Settings → MCP: the MCP servers one host wires into every chat it runs,
// beside Patch's own tools server, which is on unless switched off here.
//
// The host holds the list (`harnessMcpServers` in `host.host`) and every
// edit sends the WHOLE list back (`host.settings`), checked against the wire's
// own `McpServerList` first so a bad name or a duplicate is refused here, in
// the wire's words, rather than by the host after the fact. Nothing is
// patched locally: the list settles on the host's next report.

import type { JSX } from 'react';
import { useState } from 'react';
import {
  McpServerList,
  VOICE_TOOL_GROUPS,
  mcpServerSummary,
  voiceToolCount,
  voiceToolCountNote,
  withVoiceToolSwitch,
  type McpServerConfig,
} from '@patch/wire';
import { useUiStore } from '../../stores/uiStore.js';
import { Toggle } from '../../components/Toggle.js';
import type { HostPresence } from '../../stores/presenceStore.js';
import { hostLabel } from './hostScope.js';
import { sendHostSettings } from './hostWrite.js';
import { Group, Note, Row, SettingsPage, useHostGate } from './ui.js';

/**
 * `npx -y @playwright/mcp --headless` → command + args. Quotes group words and
 * may sit inside one (`--root="/my dir"`); inside double quotes `\"` and `\\`
 * are escapes, inside single quotes nothing is.
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let word = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      const next = line[i + 1];
      if (c === '\\' && (next === '"' || next === '\\')) {
        word += next;
        i++;
      } else if (c === '"') quote = null;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(word);
      word = '';
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (started) out.push(word);
  return out;
}

/** The reverse, quoting any word that is empty or holds a space or a quote. */
export function joinCommandLine(words: string[]): string {
  return words
    .map((w) =>
      /[\s"']/.test(w) || w === '' ? `"${w.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : w,
    )
    .join(' ');
}

/** `KEY=VALUE` lines → env. A line with no `=` is an error, named. */
export function parseEnvLines(text: string): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { error: `Environment line "${line}" is not KEY=VALUE` };
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return { env };
}

export function envToLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** The first thing the wire's schema says is wrong with a list, or null. */
export function mcpListProblem(list: McpServerConfig[]): string | null {
  const parsed = McpServerList.safeParse(list);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  if (!issue) return 'Invalid MCP server list';
  const field = issue.path.filter((p) => typeof p === 'string').join('.');
  if (field === 'name' && issue.code === 'invalid_string') {
    return 'Name may only use letters, digits, - and _ (at most 64)';
  }
  if (field === 'command') return 'Command is required';
  if (field === 'url') return 'URL must be a full address, like http://home.local:8123/api/mcp';
  return issue.message;
}

export function McpPage(): JSX.Element {
  const { host, gate } = useHostGate();
  const [adding, setAdding] = useState(false);
  const servers = host?.host?.harnessMcpServers;
  const canEdit = gate === null && servers !== undefined;
  return (
    <SettingsPage
      intro="Outside tools a host gives every chat it runs, beside Patch's own."
      title="Tools (MCP)"
      testid="settings-mcp"
      hostSwitch
      actions={
        canEdit ? (
          <button
            type="button"
            className="set-btn primary"
            data-testid="mcp-add"
            onClick={() => setAdding(true)}
            disabled={adding}
          >
            Add MCP server
          </button>
        ) : null
      }
    >
      {gate ??
        (host && servers === undefined ? (
          <Group>
            <Note testid="mcp-unsupported">Update {hostLabel(host)} to manage its MCP servers</Note>
          </Group>
        ) : host && servers ? (
          <ServerList
            host={host}
            servers={servers}
            adding={adding}
            onAddDone={() => setAdding(false)}
          />
        ) : null)}
    </SettingsPage>
  );
}

/** The two switches of a row: whether the voice has it, and whether every chat's agent has it. */
function Switches({
  voice,
  agent,
  voiceTestid,
  agentTestid,
  onVoice,
  onAgent,
}: {
  voice?: boolean;
  agent?: boolean;
  voiceTestid: string;
  agentTestid: string;
  onVoice?: (next: boolean) => void;
  onAgent?: (next: boolean) => void;
}): JSX.Element {
  return (
    <div className="mcp-switches">
      <label className="mcp-switch">
        <span className="set-sub">Voice</span>
        {voice === undefined || !onVoice ? (
          <span className="set-sub">–</span>
        ) : (
          <Toggle checked={voice} testid={voiceTestid} ariaLabel="Voice" onChange={onVoice} />
        )}
      </label>
      <label className="mcp-switch">
        <span className="set-sub">Agent</span>
        {agent === undefined || !onAgent ? (
          <span className="set-sub">–</span>
        ) : (
          <Toggle checked={agent} testid={agentTestid} ariaLabel="Agent" onChange={onAgent} />
        )}
      </label>
    </div>
  );
}

function ServerList({
  host,
  servers,
  adding,
  onAddDone,
}: {
  host: HostPresence;
  servers: McpServerConfig[];
  adding: boolean;
  onAddDone: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);
  const pushError = useUiStore((s) => s.pushError);
  const groupsOff = host.host?.voiceToolGroupsOff;
  const read = host.host?.mcpTools ?? {};

  /** Validate and send the whole list. Returns whether it went. */
  function save(next: McpServerConfig[]): string | null {
    const problem = mcpListProblem(next);
    if (problem) return problem;
    if (!sendHostSettings(host, { harnessMcpServers: next })) return 'Not sent';
    return null;
  }
  const saveQuiet = (next: McpServerConfig[]): void => {
    const problem = save(next);
    if (problem !== null && problem !== 'Not sent') pushError(problem);
  };

  return (
    <>
      <Group label="Built in" testid="mcp-builtin">
        <Row title="Patch tools" sub="Built-in MCP server" testid="mcp-server-patch">
          {host.host?.patchMcpEnabled === undefined ? (
            <span className="set-val">Always on</span>
          ) : (
            <Switches
              agent={host.host.patchMcpEnabled}
              voiceTestid="mcp-server-patch-voice"
              agentTestid="mcp-server-patch-enabled"
              onAgent={(next) => void sendHostSettings(host, { patchMcpEnabled: next })}
            />
          )}
        </Row>
        {groupsOff === undefined
          ? null
          : VOICE_TOOL_GROUPS.map((g) => (
              <Row key={g.id} title={g.label} sub={g.description} testid={`mcp-group-${g.id}`}>
                <Switches
                  voice={!groupsOff.includes(g.id)}
                  voiceTestid={`mcp-group-${g.id}-voice`}
                  agentTestid={`mcp-group-${g.id}-agent`}
                  onVoice={(on) =>
                    void sendHostSettings(host, {
                      voiceToolGroupsOff: on
                        ? groupsOff.filter((x) => x !== g.id)
                        : [...groupsOff, g.id],
                    })
                  }
                />
              </Row>
            ))}
      </Group>
      <Group label={`MCP servers on ${hostLabel(host)}`} testid="mcp-servers">
        {servers.map((s, i) =>
          editing === s.name ? (
            <ServerEditor
              key={s.name}
              initial={s}
              tools={read[s.name]}
              onCancel={() => setEditing(null)}
              onSave={(next) => {
                const problem = save(servers.map((x, j) => (j === i ? next : x)));
                if (problem === null) setEditing(null);
                return problem;
              }}
              onRemove={async () => {
                const ok = await useUiStore.getState().confirm({
                  title: `Remove ${s.name}`,
                  message: `Remove the ${s.name} MCP server from ${hostLabel(host)}? New chats and calls there stop getting its tools.`,
                  confirmLabel: 'Remove',
                  danger: true,
                });
                if (!ok) return;
                const problem = save(servers.filter((_, j) => j !== i));
                if (problem === null) setEditing(null);
                else if (problem !== 'Not sent') pushError(problem);
              }}
            />
          ) : (
            <Row
              key={s.name}
              title={s.name}
              sub={
                <>
                  <span data-testid={`mcp-server-${s.name}-summary`}>
                    {mcpServerSummary(s, read[s.name])}
                  </span>
                  {' · '}
                  <span className="mono">{serverTarget(s)}</span>
                </>
              }
              testid={`mcp-server-${s.name}`}
              onClick={() => setEditing(s.name)}
            >
              <Switches
                voice={s.voice}
                agent={s.enabled}
                voiceTestid={`mcp-server-${s.name}-voice`}
                agentTestid={`mcp-server-${s.name}-enabled`}
                onVoice={(next) =>
                  saveQuiet(servers.map((x, j) => (j === i ? { ...x, voice: next } : x)))
                }
                onAgent={(next) =>
                  saveQuiet(servers.map((x, j) => (j === i ? { ...x, enabled: next } : x)))
                }
              />
            </Row>
          ),
        )}
        {adding ? (
          <ServerEditor
            initial={{
              name: '',
              command: '',
              args: [],
              env: {},
              enabled: true,
              voice: true,
              voiceOff: [],
            }}
            tools={undefined}
            onCancel={onAddDone}
            onSave={(next) => {
              const problem = save([...servers, next]);
              if (problem === null) onAddDone();
              return problem;
            }}
          />
        ) : null}
        {groupsOff === undefined ? null : (
          <Note testid="mcp-voice-count">
            {voiceToolCountNote(voiceToolCount(servers, groupsOff, read))}
          </Note>
        )}
      </Group>
    </>
  );
}

/** Where a server is reached: its command line, or its address. */
function serverTarget(s: McpServerConfig): string {
  return 'url' in s ? s.url : joinCommandLine([s.command, ...s.args]);
}

type Transport = 'command' | 'url';

function ServerEditor({
  initial,
  tools,
  onSave,
  onCancel,
  onRemove,
}: {
  initial: McpServerConfig;
  /** What the host last read from this server. */
  tools: import('@patch/wire').McpServerTools | undefined;
  /** Returns the reason it was not saved, or null. */
  onSave: (next: McpServerConfig) => string | null;
  onCancel: () => void;
  onRemove?: () => void;
}): JSX.Element {
  const [name, setName] = useState(initial.name);
  const [transport, setTransport] = useState<Transport>('url' in initial ? 'url' : 'command');
  const [commandLine, setCommandLine] = useState(
    'command' in initial && initial.command !== ''
      ? joinCommandLine([initial.command, ...initial.args])
      : '',
  );
  const [envText, setEnvText] = useState('env' in initial ? envToLines(initial.env) : '');
  const [url, setUrl] = useState('url' in initial ? initial.url : '');
  const [tokenSecret, setTokenSecret] = useState(
    'url' in initial ? (initial.tokenSecret ?? '') : '',
  );
  const [voiceOff, setVoiceOff] = useState(initial.voiceOff);
  const [problem, setProblem] = useState<string | null>(null);

  function submit(): void {
    const base = {
      name: name.trim(),
      enabled: initial.enabled,
      voice: initial.voice,
      voiceOff,
    };
    let next: McpServerConfig;
    if (transport === 'url') {
      next = {
        ...base,
        url: url.trim(),
        ...(tokenSecret.trim() !== '' ? { tokenSecret: tokenSecret.trim() } : {}),
      };
    } else {
      const env = parseEnvLines(envText);
      if ('error' in env) {
        setProblem(env.error);
        return;
      }
      const [command = '', ...args] = splitCommandLine(commandLine);
      next = { ...base, command, args, env: env.env };
    }
    const result = onSave(next);
    setProblem(result === 'Not sent' ? null : result);
  }

  return (
    <form
      className="set-row stack set-form"
      data-testid="mcp-editor"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="set-field">
        <span className="set-row-title">Name</span>
        <input
          value={name}
          data-testid="mcp-editor-name"
          placeholder="home-assistant"
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </label>
      <label className="set-field">
        <span className="set-row-title">Reached by</span>
        <select
          value={transport}
          data-testid="mcp-editor-transport"
          onChange={(e) => setTransport(e.target.value as Transport)}
        >
          <option value="url">Address (remote server)</option>
          <option value="command">Command (runs on this host)</option>
        </select>
      </label>
      {transport === 'url' ? (
        <>
          <label className="set-field">
            <span className="set-row-title">Address</span>
            <input
              className="mono"
              value={url}
              data-testid="mcp-editor-url"
              placeholder="http://homeassistant.local:8123/api/mcp"
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label className="set-field">
            <span className="set-row-title">Token secret</span>
            <input
              className="mono"
              value={tokenSecret}
              data-testid="mcp-editor-token-secret"
              placeholder="HOME_ASSISTANT_TOKEN"
              onChange={(e) => setTokenSecret(e.target.value)}
            />
          </label>
        </>
      ) : (
        <>
          <label className="set-field">
            <span className="set-row-title">Command</span>
            <input
              className="mono"
              value={commandLine}
              data-testid="mcp-editor-command"
              placeholder="npx @playwright/mcp --headless"
              onChange={(e) => setCommandLine(e.target.value)}
            />
          </label>
          <label className="set-field">
            <span className="set-row-title">Environment</span>
            <textarea
              value={envText}
              rows={3}
              data-testid="mcp-editor-env"
              placeholder="KEY=VALUE"
              onChange={(e) => setEnvText(e.target.value)}
            />
          </label>
        </>
      )}
      {tools !== undefined && 'tools' in tools && tools.tools.length > 0 ? (
        <div className="set-field" data-testid="mcp-editor-tools">
          <span className="set-row-title">Tools for the voice</span>
          {tools.tools.map((t) => (
            <Row key={t.name} title={t.name} sub={t.description} testid={`mcp-tool-${t.name}`}>
              <Toggle
                checked={!voiceOff.includes(t.name)}
                testid={`mcp-tool-${t.name}-voice`}
                ariaLabel={`${t.name} for the voice`}
                onChange={(on) =>
                  setVoiceOff(withVoiceToolSwitch({ voiceOff }, t.name, on).voiceOff)
                }
              />
            </Row>
          ))}
        </div>
      ) : null}
      {problem ? (
        <p className="set-error" role="alert" data-testid="mcp-editor-error">
          {problem}
        </p>
      ) : null}
      <div className="set-actions">
        {onRemove ? (
          <button
            type="button"
            className="set-btn danger"
            data-testid="mcp-editor-remove"
            onClick={onRemove}
          >
            Remove
          </button>
        ) : null}
        <span className="set-spacer" />
        <button
          type="button"
          className="set-btn ghost"
          data-testid="mcp-editor-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button type="submit" className="set-btn primary" data-testid="mcp-editor-save">
          Save
        </button>
      </div>
    </form>
  );
}
