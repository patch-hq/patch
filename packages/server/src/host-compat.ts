// The wire protocol is the compatibility contract between server and host
// (spec/11 § Deployment: "server and host versions are independent. The wire
// protocol is the compatibility contract: the server states the host version
// range it supports, and a host outside that range is shown as needing an
// update").
//
// Without this, a machine running a host too old to speak the current wire
// shape simply misbehaved — decoding frames it did not understand, or omitting
// fields a surface then rendered as absent. Stating the range turns that into a
// visible "this host needs updating".
//
// The comparison itself lives in version-report.ts; this module holds only the
// range and the verdict so there is ONE version comparator in the server.

/**
 * The oldest host build this server can speak to. Raise it in the SAME change
 * that makes a wire frame's new shape mandatory rather than additive — that is
 * the moment older hosts stop being able to hold up their end.
 */
// 1.1.2200 is the first host whose audio server holds a dropped call's session and
// takes `audio.session_start.resumes` (spec/07 § A dropped call comes back): an older
// host rejects the frame, and ends a call the moment its line goes quiet. It also
// carries `patch.send_to`'s `localId` and asks for a sent message's reply with
// `patch.reply.request` (spec/03 § Cross-chat tools), from 1.1.2190.
// 1.1.2231 is the first host whose `host.settings` carries MCP servers reached over HTTP
// (`McpServerConfig` is a command or a URL) and the voice's tool switches (spec/07 § Voice tools).
export const MIN_SUPPORTED_HOST_VERSION = '1.1.2231';

export type HostSupport =
  | { supported: true }
  | { supported: false; reason: string; remedy: string };
