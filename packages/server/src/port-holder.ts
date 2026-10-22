// Who is holding a port, for the error the server dies with when it cannot listen.

import { execFileSync } from 'node:child_process';

/** The process listening on `port`, as `"name" (pid N)`, or undefined when it cannot be found. */
export function describePortHolder(port: number): string | undefined {
  let out: string;
  try {
    out = execFileSync('ss', ['-H', '-ltnp', `sport = :${port}`], { encoding: 'utf8' });
  } catch {
    return undefined;
  }
  const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(out);
  return m ? `"${m[1]}" (pid ${m[2]})` : undefined;
}

export function portInUseMessage(port: number): string {
  const holder = describePortHolder(port);
  return (
    `Port ${port} is already in use by ${holder ?? 'another process (could not identify it; try: ss -ltnp)'}. ` +
    `patch-server does not pick another port. Stop that process, or set PORT in server.env ` +
    `(and point the reverse proxy at the same port).`
  );
}
