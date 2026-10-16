// lib/docExport.ts — saving an export into a folder the user picks.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { permSpy, createSpy, writeSpy } = vi.hoisted(() => ({
  permSpy: vi.fn(),
  createSpy: vi.fn(),
  writeSpy: vi.fn(),
}));
vi.mock('expo-file-system', () => ({
  EncodingType: { Base64: 'base64' },
  writeAsStringAsync: writeSpy,
  StorageAccessFramework: {
    requestDirectoryPermissionsAsync: permSpy,
    createFileAsync: createSpy,
  },
}));

import { saveExport } from '../src/lib/docExport';
import { EXPORT_MIME } from '../src/lib/docEditor';

beforeEach(() => {
  permSpy.mockReset().mockResolvedValue({ granted: true, directoryUri: 'content://dir' });
  createSpy.mockReset().mockResolvedValue('content://dir/r');
  writeSpy.mockReset().mockResolvedValue(undefined);
});

describe('saveExport', () => {
  it('creates the file in the picked folder with the format MIME and writes the bytes', async () => {
    const res = await saveExport({ base64: 'QUJD', filename: 'report.pdf', format: 'pdf' });
    expect(createSpy).toHaveBeenCalledWith('content://dir', 'report', EXPORT_MIME.pdf);
    expect(writeSpy).toHaveBeenCalledWith('content://dir/r', 'QUJD', { encoding: 'base64' });
    expect(res).toEqual({ status: 'saved', uri: 'content://dir/r' });
  });

  it('keeps a name that has no extension, and only strips the last one', async () => {
    await saveExport({ base64: '', filename: 'notes', format: 'md' });
    expect(createSpy).toHaveBeenLastCalledWith('content://dir', 'notes', EXPORT_MIME.md);
    await saveExport({ base64: '', filename: 'a.b.docx', format: 'docx' });
    expect(createSpy).toHaveBeenLastCalledWith('content://dir', 'a.b', EXPORT_MIME.docx);
  });

  it('writes nothing when the picker is cancelled', async () => {
    permSpy.mockResolvedValue({ granted: false });
    expect(await saveExport({ base64: 'QUJD', filename: 'r.md', format: 'md' })).toEqual({
      status: 'cancelled',
    });
    expect(createSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('throws a failed write rather than reporting a save', async () => {
    writeSpy.mockRejectedValue(new Error('disk full'));
    await expect(saveExport({ base64: 'x', filename: 'r.md', format: 'md' })).rejects.toThrow(
      'disk full',
    );
  });
});
