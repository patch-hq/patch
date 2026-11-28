// Ending a call goes through the server (spec/07 § Ending a call): held until
// the server answers `voice.call_ended`, sent again while it does not and when
// the link is back.

import { CallEndOutbox } from '@patch/wire/call-end';
import { getWs } from '../api/ws';

export const callEnds = new CallEndOutbox({ send: (event) => getWs().send(event) });
