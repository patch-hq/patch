/** Local date and time for a timeline entry: `21 Oct, 12:53`. */
export function formatDateTime(at: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(at));
}
