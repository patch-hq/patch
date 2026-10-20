// The question shown on a signed-in device when another one asks to sign in
// (web, desktop and phone prompts, and the push). `label` is "<browser> on <os>"
// as built by the web client's deviceLabel.

const DEVICES: Record<string, string> = {
  Mac: 'a Mac',
  Windows: 'a Windows PC',
  Linux: 'a Linux PC',
  Android: 'an Android device',
  iOS: 'an iOS device',
};

export function signInQuestion(label: string): string {
  const at = label.lastIndexOf(' on ');
  if (at === -1) return `Approve a Patch sign-in from ${label}?`;
  const os = label.slice(at + 4);
  return `Approve a Patch sign-in from ${label.slice(0, at)} on ${DEVICES[os] ?? os}?`;
}
