// The call sounds as bundled assets (spec/07 § Call sounds). Rendered from the
// web app's synthesis by packages/web/scripts/render-call-sounds.mjs, so the
// phone plays exactly what the web and desktop app play. Kept apart from
// callSounds.ts so tests can stand in for Metro's asset ids.
import connecting from '../../assets/sounds/call_connecting.wav';
import connected from '../../assets/sounds/call_connected.wav';
import passedToAgent from '../../assets/sounds/call_passed_to_agent.wav';
import reconnecting from '../../assets/sounds/call_reconnecting.wav';
import reconnected from '../../assets/sounds/call_reconnected.wav';
import paused from '../../assets/sounds/call_paused.wav';
import ended from '../../assets/sounds/call_ended.wav';
import agentCalling from '../../assets/sounds/call_agent_calling.wav';
import agentWorking from '../../assets/sounds/call_agent_working.wav';
import failed from '../../assets/sounds/call_failed.wav';
import type { CallSoundName } from './callSounds';

export const CALL_SOUND_ASSETS: Record<CallSoundName, number> = {
  connecting,
  connected,
  'passed-to-agent': passedToAgent,
  reconnecting,
  reconnected,
  paused,
  ended,
  'agent-calling': agentCalling,
  'agent-working': agentWorking,
  failed,
};
