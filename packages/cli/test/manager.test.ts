// `patch manager home` (spec/06 § Changing home): show the Manager's home, or
// move it — a visible handover that never happens without a confirmation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { managerHome, registerManagerCommands } from '../src/commands/manager.js';

const HOSTS = [
  { hostId: 'h-laptop-1', hostName: 'laptop', online: true },
  { hostId: 'h-server-1', hostName: 'server', online: true },
];

function fake(home: string | null = 'h-laptop-1') {
  const puts: Array<{ path: string; body: unknown }> = [];
  const gets: string[] = [];
  return {
    puts,
    gets,
    t: {
      get: async <T>(path: string): Promise<T> => {
        gets.push(path);
        if (path === '/api/hosts') return { hosts: HOSTS } as T;
        if (path === '/api/manager/home') return { hostId: home } as T;
        if (path.startsWith('/api/manager/home/draft?hostId=')) {
          return { message: 'user: hello' } as T;
        }
        throw new Error(`unrouted GET ${path}`);
      },
      put: async <T>(path: string, body?: unknown): Promise<T> => {
        puts.push({ path, body });
        return { hostId: (body as { hostId: string }).hostId } as T;
      },
    },
  };
}

function io(answer: boolean | null) {
  const said: string[] = [];
  return { said, io: { say: (l: string) => said.push(l), ask: async () => answer } };
}

test('manager home is registered with --set, --message, --no-message and --yes', () => {
  const program = new Command();
  registerManagerCommands(program);
  const home = program.commands
    .find((c) => c.name() === 'manager')
    ?.commands.find((c) => c.name() === 'home');
  assert.ok(home);
  const flags = home.options.map((o) => o.long);
  for (const f of ['--set', '--message', '--no-message', '--yes', '--json']) {
    assert.ok(flags.includes(f), `${f} is an option (have: ${flags.join(', ')})`);
  }
});

test('with no --set it names the current home and changes nothing', async () => {
  const f = fake();
  const res = await managerHome(f.t, {}, io(null).io);
  assert.deepEqual(res, { hostId: 'h-laptop-1', hostName: 'laptop' });
  assert.deepEqual(f.puts, []);
});

test('--set shows the drafted handover and moves only when the user says yes', async () => {
  const f = fake();
  const o = io(true);
  const res = await managerHome(f.t, { set: 'server' }, o.io);
  assert.ok(o.said.join('\n').includes('Move the Manager from laptop to server'));
  assert.ok(o.said.join('\n').includes('user: hello'));
  assert.deepEqual(f.puts, [
    { path: '/api/manager/home', body: { hostId: 'h-server-1', message: 'user: hello' } },
  ]);
  assert.equal('moved' in res && res.moved, true);
});

test('answering no, or having no terminal to ask on, moves nothing', async () => {
  for (const answer of [false, null]) {
    const f = fake();
    const o = io(answer);
    const res = await managerHome(f.t, { set: 'h-server' }, o.io);
    assert.equal('moved' in res && res.moved, false);
    assert.deepEqual(f.puts, []);
  }
});

test('--json without --yes previews the handover without moving', async () => {
  const f = fake();
  const res = await managerHome(f.t, { set: 'server', json: true }, io(true).io);
  assert.deepEqual(res, {
    moved: false,
    from: { hostId: 'h-laptop-1', hostName: 'laptop' },
    to: { hostId: 'h-server-1', hostName: 'server' },
    message: 'user: hello',
  });
  assert.deepEqual(f.puts, []);
});

test('--yes with --message or --no-message sends that instead of the draft', async () => {
  const f = fake();
  await managerHome(f.t, { set: 'server', yes: true, message: 'carry on' }, io(null).io);
  const g = fake();
  await managerHome(g.t, { set: 'server', yes: true, message: false }, io(null).io);
  assert.deepEqual(
    [...f.puts, ...g.puts].map((p) => p.body),
    [
      { hostId: 'h-server-1', message: 'carry on' },
      { hostId: 'h-server-1', message: '' },
    ],
  );
  assert.ok(!f.gets.some((p) => p.includes('/draft')), 'no draft fetched when one is given');
});

test('refuses the host that is already home, and an unknown host, naming them', async () => {
  await assert.rejects(managerHome(fake().t, { set: 'laptop', yes: true }, io(null).io), {
    message: /laptop is already the Manager's home/,
  });
  await assert.rejects(managerHome(fake().t, { set: 'nope', yes: true }, io(null).io), {
    message: /matches no registered host/,
  });
});
