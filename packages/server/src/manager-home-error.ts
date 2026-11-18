// Refusals about the Manager's home host (spec/06 § Changing home). Its own
// module so the registry can raise one without importing ManagerHome.

export class ManagerHomeError extends Error {
  constructor(
    readonly code: 'unknown_host' | 'already_home' | 'no_home' | 'is_home',
    message: string,
  ) {
    super(message);
    this.name = 'ManagerHomeError';
  }
}
