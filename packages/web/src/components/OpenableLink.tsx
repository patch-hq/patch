// OpenableLink — a link to something Patch can open (a chat, a job, a page)
// that offers every way of opening it: click opens here, ⌘/Ctrl-click opens it
// in a new window, middle-click in a new tab in the active pane, and
// right-click a menu with Open in new tab / to the side / in new window
// (spec/14 § Opening things). `useOpenable` is the same for things that are
// buttons rather than anchors.

import type { ButtonHTMLAttributes, JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { ExternalLink, PanelRightOpen, SquarePlus } from 'lucide-react';
import { ContextMenu, useContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { useLayoutStore, type TabDescriptor } from '../stores/layoutStore.js';
import { openDescriptorInNewWindow } from '../lib/newWindow.js';

export function isModifiedClick(e: ReactMouseEvent): boolean {
  return e.metaKey || e.ctrlKey;
}

export function useOpenable(
  target: TabDescriptor,
  label = 'Open actions',
): {
  /** True when the click was ⌘/Ctrl-click and has been handled (opened in a new window). */
  handleModifiedClick: (e: ReactMouseEvent) => boolean;
  onAuxClick: (e: ReactMouseEvent) => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  menu: JSX.Element;
} {
  const ctx = useContextMenu();
  const items: ContextMenuItem[] = [
    {
      id: 'open-new-tab',
      label: 'Open in new tab',
      icon: <SquarePlus size={14} aria-hidden />,
      run: () => useLayoutStore.getState().openTab(target, { placement: 'tab' }),
    },
    {
      id: 'open-to-the-side',
      label: 'Open to the side',
      icon: <PanelRightOpen size={14} aria-hidden />,
      run: () => useLayoutStore.getState().openTab(target, { placement: 'split', edge: 'right' }),
    },
    {
      id: 'open-new-window',
      label: 'Open in new window',
      icon: <ExternalLink size={14} aria-hidden />,
      run: () => openDescriptorInNewWindow(target),
    },
  ];
  return {
    handleModifiedClick: (e) => {
      if (!isModifiedClick(e)) return false;
      e.preventDefault();
      openDescriptorInNewWindow(target);
      return true;
    },
    onAuxClick: (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      useLayoutStore.getState().openTab(target, { placement: 'tab' });
    },
    onContextMenu: ctx.openAt,
    menu: (
      <ContextMenu
        anchor={ctx.anchor}
        items={items}
        onClose={ctx.close}
        label={label}
        testId="open-context-menu"
      />
    ),
  };
}

export function OpenableLink({
  opens,
  onClick,
  children,
  ...rest
}: Omit<LinkProps, 'onAuxClick' | 'onContextMenu'> & {
  opens: TabDescriptor;
  children?: ReactNode;
}): JSX.Element {
  const o = useOpenable(opens);
  return (
    <>
      <Link
        {...rest}
        onClick={(e) => {
          if (o.handleModifiedClick(e)) return;
          onClick?.(e);
        }}
        onAuxClick={o.onAuxClick}
        onContextMenu={o.onContextMenu}
      >
        {children}
      </Link>
      {o.menu}
    </>
  );
}

/** The button form: click runs `onOpen`, the other ways of opening are as on OpenableLink. */
export function OpenableButton({
  opens,
  onOpen,
  children,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onAuxClick' | 'onContextMenu'> & {
  opens: TabDescriptor;
  onOpen: () => void;
}): JSX.Element {
  const o = useOpenable(opens);
  return (
    <>
      <button
        type="button"
        {...rest}
        onClick={(e) => {
          if (o.handleModifiedClick(e)) return;
          onOpen();
        }}
        onAuxClick={o.onAuxClick}
        onContextMenu={o.onContextMenu}
      >
        {children}
      </button>
      {o.menu}
    </>
  );
}
