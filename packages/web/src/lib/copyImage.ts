// Copy the image at `url` to the system clipboard as an image. The async
// clipboard only accepts image/png, so any other format is redrawn to a PNG
// first. The URL is fetched (not read off the <img>) so the auth the app's
// own requests carry applies. NO FALLBACK: every failure rejects.

async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d canvas to convert the image to PNG');
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('PNG conversion failed'))),
        'image/png',
      ),
    );
  } finally {
    bitmap.close();
  }
}

export async function copyImageToClipboard(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  const png = await toPng(await res.blob());
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
