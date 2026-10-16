// Which desktop build files go to the box, and in what order.
//
// Shells poll latest-mac.yml and download whatever it names, so it must be the
// last thing to change: uploaded first, it advertises a zip that is not on the
// box yet and every shell that checks in that window records a 404.
export function desktopUploadOrder(zip, { blockmap }) {
  return [zip, ...(blockmap ? [`${zip}.blockmap`] : []), 'latest-mac.yml'];
}
