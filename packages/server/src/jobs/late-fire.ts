// A fire that has waited too long for its host (spec/12 § Cron fires while a
// host is down). It never started, so it is recorded in the bell for whoever
// opens the app and is never pushed: the module takes no router on purpose.

import type { NotificationLog } from '../notifications/log.js';
import type { LateFireInfo } from './dispatcher.js';

export function lateFireHandler(log: NotificationLog): (info: LateFireInfo) => void {
  return (info) => {
    const since = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(info.timezone !== undefined ? { timeZone: info.timezone } : {}),
    }).format(info.dueAt);
    log.add({
      message: `${info.jobName} has not run: host ${info.hostId ?? 'unknown'} unreachable since ${since}. It will run when the host is back.`,
      importance: 'silent',
      jobId: info.jobId,
    });
  };
}
