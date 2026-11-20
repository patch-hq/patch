// The Settings page being drawn: its registry title, one-line intro and
// whether it is experimental, so the page frame can show them. Its own file so
// the frame does not import the page registry (which imports every page).

import React from 'react';

export interface SettingsPageMeta {
  id: string;
  title: string;
  intro: string;
  experimental: boolean;
}

export const SettingsPageContext = React.createContext<SettingsPageMeta | null>(null);
