// Full-window modal overlay. Portalled to <body>: `position: fixed` is measured
// against the nearest ancestor with layout containment (`.chat-main` has
// `contain: layout`), so rendered in place the scrim stopped at the chat
// panel's edge and left the sidebar lit up.

import { type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function ModalOverlay({
  testId,
  children,
}: {
  testId: string;
  children: ReactNode;
}): JSX.Element {
  return createPortal(
    <div className="modal-overlay" data-testid={testId}>
      {children}
    </div>,
    document.body,
  );
}
