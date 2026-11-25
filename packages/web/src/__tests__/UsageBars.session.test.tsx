// The 5-hour row is always drawn, even when the host has not reported it.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { UsageBars } from '../routes/settings/accountList.js';

describe('UsageBars 5-hour row', () => {
  afterEach(cleanup);

  it('says the 5-hour window is not reported rather than leaving it out', () => {
    render(
      <UsageBars
        usage={{ week: { status: 'allowed', utilization: 0.2 }, at: 1 }}
        testId="bars"
        testIdFor={(s) => `bar-${s}`}
      />,
    );
    expect(screen.getByTestId('bar-session').textContent).toContain('5-hour');
    expect(screen.getByTestId('bar-session').textContent).toContain('not reported');
  });
});
