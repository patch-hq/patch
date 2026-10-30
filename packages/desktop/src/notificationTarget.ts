// Where a clicked toast lands (spec/09 § Batch check-in, § Account sign-in).
// `batch` and `sign-in` notifications carry a reserved non-chat `chatId`, so
// they must never be resolved as a chat.

export function notificationClickPath(
  kind: string | undefined,
  chatId: string | undefined,
): string | null {
  if (kind === 'batch') return '/batch';
  if (kind === 'host-health') return '/settings/hosts';
  if (kind === 'sign-in') return '/settings/usage';
  if (chatId) return `/chats/${chatId}`;
  return null;
}
