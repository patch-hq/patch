// "Capture this screen for agents" on the phone: photograph the window with
// react-native-view-shot and file it with the server, where an agent reads it
// back through `patch_capture_screen`. NO FALLBACK: any failure is thrown for
// the caller to show.

import { Dimensions } from 'react-native';
import { captureScreen } from 'react-native-view-shot';
import { api } from '../api/rest';

export async function captureScreenForAgents(route: string): Promise<void> {
  const png = await captureScreen({ format: 'png', result: 'base64' });
  const { width, height } = Dimensions.get('window');
  await api.captureScreen({
    surface: 'phone',
    route,
    viewport: { width: Math.round(width), height: Math.round(height) },
    png,
  });
}
