// Headphones out pauses the call; back in resumes it (spec/07 § Pause), on web
// and desktop. The browser says nothing about "headphones", but it does say
// which physical device the default output is (its `groupId`) and fires
// `devicechange` when one comes or goes. So the call watches the device it was
// heard on: when that device disappears the call pauses, and when the same
// device comes back a call it paused resumes. A call heard on built-in
// speakers never sees them disappear, so it never pauses this way.

export interface HeadphoneWatchDeps {
  mediaDevices: Pick<MediaDevices, 'enumerateDevices' | 'addEventListener' | 'removeEventListener'>;
  /** The call's output device went away. */
  onGone(): void;
  /** The same device is back. */
  onBack(): void;
}

/** The physical device behind the default audio output, or null when the browser does not say. */
async function defaultOutputGroup(
  mediaDevices: HeadphoneWatchDeps['mediaDevices'],
): Promise<string | null> {
  const outputs = (await mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
  const def = outputs.find((d) => d.deviceId === 'default') ?? outputs[0];
  return def !== undefined && def.groupId !== '' ? def.groupId : null;
}

async function present(
  mediaDevices: HeadphoneWatchDeps['mediaDevices'],
  groupId: string,
): Promise<boolean> {
  const devices = await mediaDevices.enumerateDevices();
  return devices.some((d) => d.kind === 'audiooutput' && d.groupId === groupId);
}

/**
 * Watch the device the call is heard on. Returns the stop function. A browser
 * that lists no output devices (Firefox without its flag) has nothing to
 * watch: that is logged, not hidden, and the call simply does not pause on it.
 */
export function watchCallHeadphones(deps: HeadphoneWatchDeps): () => void {
  let stopped = false;
  let groupId: string | null = null;
  let gone = false;
  const onChange = (): void => {
    if (stopped || groupId === null) return;
    const watched = groupId;
    void present(deps.mediaDevices, watched).then(
      (here) => {
        if (stopped) return;
        if (!here && !gone) {
          gone = true;
          deps.onGone();
        } else if (here && gone) {
          gone = false;
          deps.onBack();
        }
      },
      (err: unknown) => console.error('call headphones: could not list audio devices', err),
    );
  };
  void defaultOutputGroup(deps.mediaDevices).then(
    (g) => {
      if (stopped) return;
      if (g === null) {
        console.info('call headphones: this browser does not name its audio output; not watching');
        return;
      }
      groupId = g;
      deps.mediaDevices.addEventListener('devicechange', onChange);
    },
    (err: unknown) => console.error('call headphones: could not list audio devices', err),
  );
  return () => {
    stopped = true;
    deps.mediaDevices.removeEventListener('devicechange', onChange);
  };
}
