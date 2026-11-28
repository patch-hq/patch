// The line under a Settings choice that lacks something on a host: an
// invitation with the one-step fix, not an error (spec/14 § Voice readiness).

import type { JSX } from 'react';
import { Link } from 'react-router-dom';

export function SetupLine({ text, testid }: { text: string; testid: string }): JSX.Element {
  return (
    <span className="set-sub-line" data-testid={testid}>
      {text}{' '}
      <Link to="/settings/providers" data-testid={`${testid}-setup`}>
        Set up
      </Link>
    </span>
  );
}
