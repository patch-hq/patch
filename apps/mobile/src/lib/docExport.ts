// Saving a document export to the phone (spec/15 § Document editor). The host
// hands back the bytes; the phone has no share-out module, so the file goes
// where the user points: Android's folder picker (Storage Access Framework,
// part of expo-file-system), one grant per export. Cancelling the picker is
// not an error and writes nothing; every other failure throws.

import * as FileSystem from 'expo-file-system';
import { EXPORT_MIME, type ExportFormat } from './docEditor';

export type SaveExportResult = { status: 'saved'; uri: string } | { status: 'cancelled' };

/** `r.docx` to `r`: the picker adds the extension its MIME type implies. */
function stem(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i > 0 ? filename.slice(0, i) : filename;
}

export async function saveExport(opts: {
  base64: string;
  filename: string;
  format: ExportFormat;
}): Promise<SaveExportResult> {
  const saf = FileSystem.StorageAccessFramework;
  const grant = await saf.requestDirectoryPermissionsAsync();
  if (!grant.granted) return { status: 'cancelled' };
  const uri = await saf.createFileAsync(
    grant.directoryUri,
    stem(opts.filename),
    EXPORT_MIME[opts.format],
  );
  await FileSystem.writeAsStringAsync(uri, opts.base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return { status: 'saved', uri };
}
