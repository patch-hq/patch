// Size caps on a client crash report (`POST /api/client-crashes`). The server
// rejects anything over them, so the phone truncates to the same numbers.

export const CLIENT_CRASH_LIMITS = {
  message: 4_000,
  stack: 32_000,
  componentStack: 32_000,
  chatId: 200,
  route: 500,
  build: 200,
} as const;
