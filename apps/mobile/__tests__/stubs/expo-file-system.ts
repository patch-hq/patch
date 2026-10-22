export const cacheDirectory: string = 'file:///cache/';

export enum EncodingType {
  UTF8 = 'utf8',
  Base64 = 'base64',
}

const files = new Map<string, string>();
const present = new Set<string>();

export async function writeAsStringAsync(
  fileUri: string,
  contents: string,
  _options?: { encoding?: EncodingType | 'utf8' | 'base64' },
): Promise<void> {
  files.set(fileUri, contents);
}

export async function readAsStringAsync(fileUri: string): Promise<string> {
  return files.get(fileUri) ?? '';
}

export async function deleteAsync(fileUri: string): Promise<void> {
  files.delete(fileUri);
}

// The APK installer (src/lib/apkInstall.ts): a download that reports progress,
// and the content:// URI the installer reads it through.
export interface DownloadProgressData {
  totalBytesWritten: number;
  totalBytesExpectedToWrite: number;
}
export let __downloads: Array<{ url: string; fileUri: string }> = [];
export let __downloadStatus = 200;
export let __downloadError: Error | null = null;
export function __setDownload(opts: { status?: number; error?: Error | null }): void {
  __downloadStatus = opts.status ?? 200;
  __downloadError = opts.error ?? null;
}
export function __resetDownloads(): void {
  present.clear();
  __downloads = [];
  __downloadStatus = 200;
  __downloadError = null;
}
export function createDownloadResumable(
  url: string,
  fileUri: string,
  _options: object,
  onProgress?: (p: DownloadProgressData) => void,
): { downloadAsync(): Promise<{ uri: string; status: number } | undefined> } {
  return {
    async downloadAsync() {
      __downloads.push({ url, fileUri });
      if (__downloadError) throw __downloadError;
      onProgress?.({ totalBytesWritten: 50, totalBytesExpectedToWrite: 100 });
      onProgress?.({ totalBytesWritten: 100, totalBytesExpectedToWrite: 100 });
      if (__downloadStatus === 200) present.add(fileUri);
      return { uri: fileUri, status: __downloadStatus };
    },
  };
}
export async function getContentUriAsync(fileUri: string): Promise<string> {
  return fileUri.replace('file:///cache/', 'content://patch.files/cache/');
}

// Staged APKs: a finished download is a file; moveAsync promotes the .part.
export async function getInfoAsync(fileUri: string): Promise<{ exists: boolean }> {
  return { exists: present.has(fileUri) };
}
export async function moveAsync(opts: { from: string; to: string }): Promise<void> {
  present.delete(opts.from);
  present.add(opts.to);
}
