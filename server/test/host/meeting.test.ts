import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KakiEvent } from '@kaki/shared';
import type { KakiApp } from '../../src/app';
import { createMeetingModule } from '../../src/host/meeting';
import { createFakeLlm } from '../../src/llm';
import { connectClient, createTestApp, portOf, settle, waitForEvent, type TestClient } from '../helpers';

const reply = (body: Record<string, unknown>) =>
  JSON.stringify({ newQuestions: [], answeredQuestionIds: [], newTasks: [], ...body });

function isRecord(event: KakiEvent): event is Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }> {
  return event.type === 'MEETING_RECORD_UPDATED';
}

let app: KakiApp | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

async function connect(role: string): Promise<TestClient> {
  const client = await connectClient(portOf(app!), role);
  clients.push(client);
  return client;
}

describe('host meeting module', () => {
  it('turns a replayed transcript into a meeting record and suggested tasks', async () => {
    const llm = createFakeLlm((messages) =>
      messages[1]!.content.includes('oven')
        ? reply({
            agendaIndex: 0,
            newQuestions: [{ text: 'Who services the oven?', forRole: 'chef' }],
            newTasks: [
              { title: 'Call the oven repair man', context: 'The oven trips the fuse.', suggestedAssignee: 'chef' },
            ],
          })
        : reply({}),
    );
    app = await createTestApp({
      modules: [
        createMeetingModule({
          llm,
          notetakerIntervalMs: 50,
          replay: [
            { at: 0, speaker: 'Ada (Chef)', text: 'The oven trips the fuse again.' },
            { at: 0, speaker: 'Bao (Cashier)', text: 'Who services the oven?' },
          ],
        }),
      ],
    });
    const screen = await connect('screen');
    const chef = await connect('chef');

    const suggested = await waitForEvent(
      screen,
      (event) => event.type === 'TASK_UPDATED' && event.payload.task.status === 'SUGGESTED',
      'suggested task',
    );
    expect(suggested).toMatchObject({ payload: { task: { title: 'Call the oven repair man', suggestedAssignee: 'chef' } } });

    const record = await waitForEvent(
      chef,
      (event) => isRecord(event) && event.payload.openQuestions.length > 0,
      'record with a question',
    );
    expect(record).toMatchObject({
      audience: { kind: 'all' },
      payload: {
        agendaIndex: 0,
        openQuestions: [{ id: 'q-1', text: 'Who services the oven?', forRole: 'chef' }],
        speakerTalkSeconds: { chef: 2, cashier: 2 },
      },
    });

    // A late joiner gets the latest record straight away.
    const late = await connect('cashier');
    await waitForEvent(late, isRecord, 'retained record');
  });

  it('publishes nothing until the meeting has started', async () => {
    app = await createTestApp({ modules: [createMeetingModule({ notetakerIntervalMs: 50 })] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const screen = await connect('screen');

    await settle(1_200);
    expect(screen.messages.filter(isRecord)).toEqual([]);

    app.hub.publish({
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'screen' },
      payload: { speaker: 'Ada (Chef)', text: 'Let us begin.', timestamp: new Date().toISOString() },
    });
    const record = await waitForEvent(screen, isRecord, 'first record', 2_000);
    expect(record).toMatchObject({ payload: { agendaIndex: 0, openQuestions: [] } });
  });
});
