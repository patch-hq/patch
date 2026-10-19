// expo-intent-launcher stub: records the activities the app starts.
export interface IntentLauncherParams {
  data?: string;
  flags?: number;
  type?: string;
}
export const __started: Array<{ action: string; params: IntentLauncherParams }> = [];
export let __startError: Error | null = null;
export function __setStartError(e: Error | null): void {
  __startError = e;
}
export async function startActivityAsync(
  action: string,
  params: IntentLauncherParams = {},
): Promise<{ resultCode: number }> {
  __started.push({ action, params });
  if (__startError) throw __startError;
  return { resultCode: 0 };
}
