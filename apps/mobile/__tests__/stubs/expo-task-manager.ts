// expo-task-manager stub: keeps defined tasks so a test can run one as the OS would.
type Executor = (body: {
  data: unknown;
  error: unknown;
  executionInfo?: unknown;
}) => Promise<unknown>;
const tasks = new Map<string, Executor>();
export function defineTask(name: string, fn: Executor): void {
  tasks.set(name, fn);
}
export function isTaskDefined(name: string): boolean {
  return tasks.has(name);
}
export async function __runTask(name: string, data: unknown): Promise<void> {
  const fn = tasks.get(name);
  if (!fn) throw new Error(`task ${name} is not defined`);
  await fn({ data, error: null });
}
