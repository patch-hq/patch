// A minimal ACP agent on stdio, for testing the adapter's real spawn path.
import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream } from '@agentclientprotocol/sdk';

const app = agent({ name: 'echo' })
  .onRequest(methods.agent.initialize, () => ({ protocolVersion: 1, agentCapabilities: {} }))
  .onRequest(methods.agent.session.new, () => ({ sessionId: 'echo-1' }))
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const text = params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('');
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo:${text}` } },
    });
    return { stopReason: 'end_turn' };
  });
app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
