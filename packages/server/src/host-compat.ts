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
// 1.1.2186 is the first host whose `patch.send_to` carries the `localId` the
// message is delivered under, and that asks for a sent message's reply with
// `patch.reply.request` (spec/03 § Cross-chat tools): an older host's sends
// fail to decode here, and a relayed one with `localId` fails to decode there.
export const MIN_SUPPORTED_HOST_VERSION = '1.1.2186';

export type HostSupport =
  | { supported: true }
  | { supported: false; reason: string; remedy: string };
