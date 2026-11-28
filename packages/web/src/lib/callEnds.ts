// Ending a call goes through the server (spec/07 § Ending a call): held until
// the server answers `voice.call_ended`, sent again while it does not.

import { CallEndOutbox } from '@patch/wire/call-end';
import { getActiveWs } from '../api/ws.js';

export const callEnds = new CallEndOutbox({
  send: (event) => {
    const ws = getActiveWs();
    if (!ws) throw new Error('not connected to the server');
    ws.send(event);
  },
});
