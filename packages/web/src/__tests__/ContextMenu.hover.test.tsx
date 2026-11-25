// Opening a context menu focuses its first row and focus is styled like hover,
// so hovering another row used to leave two rows highlighted (todoist
// 6hrjpXPcCCvWG2mc — "scheduled send hover state is broken"). Hover now moves
// focus, so exactly one row is ever highlighted.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ContextMenu } from '../components/ContextMenu.js';

afterEach(cleanup);

describe('ContextMenu hover', () => {
  it('moves focus to the hovered row so only one row is highlighted', () => {
    const items = ['a', 'b', 'c'].map((id) => ({
      id,
      label: id,
      icon: null,
      run: () => {},
    }));
    render(
      <ContextMenu
        anchor={{ x: 10, y: 10 }}
        items={items}
        onClose={() => {}}
        label="m"
        testId="m"
      />,
    );
    expect(document.activeElement).toBe(screen.getByTestId('m-a'));
    fireEvent.mouseMove(screen.getByTestId('m-c'));
    expect(document.activeElement).toBe(screen.getByTestId('m-c'));
  });

  it('drops the highlight when the pointer leaves the row', () => {
    const items = ['a', 'b'].map((id) => ({ id, label: id, icon: null, run: () => {} }));
    render(
      <ContextMenu
        anchor={{ x: 10, y: 10 }}
        items={items}
        onClose={() => {}}
        label="m"
        testId="m"
      />,
    );
    fireEvent.mouseMove(screen.getByTestId('m-b'));
    fireEvent.mouseLeave(screen.getByTestId('m-b'));
    expect(document.activeElement).toBe(screen.getByTestId('m'));
  });
});
