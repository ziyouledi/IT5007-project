import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KakiEvent } from '@kaki/shared';
import { createApp, type KakiApp } from '../../src/app';
import { createMeetingModule } from '../../src/host/meeting';
import { createFakeLlm } from '../../src/llm';
import { testScenario } from '../fixtures/scenario';
import { connectClient, createTestApp, portOf, settle, waitFor, waitForEvent, type TestClient } from '../helpers';

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

function say(text: string): void {
  app!.hub.publish({
    type: 'TRANSCRIPT_CHUNK',
    audience: { kind: 'screen' },
    payload: { speaker: 'Ada (Chef)', text, timestamp: new Date().toISOString() },
  });
}

describe('host meeting module', () => {
  it('turns a replayed transcript into a meeting record and suggested tasks', async () => {
    const llm = createFakeLlm((messages) =>
      messages[1]!.content.includes('oven')
        ? reply({
            agendaIndex: 0,
            newQuestions: [{ text: 'Who services the oven?', forRole: 'chef' }],
            newTasks: [
              {
                title: 'Call the oven repair man',
                context: 'The oven trips the fuse.',
                suggestedAssignee: 'chef',
                evidence: 'The oven trips the fuse again.',
              },
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
      screen,
      (event) => isRecord(event) && event.payload.openQuestions.length > 0,
      'record with a question',
    );
    expect(record).toMatchObject({
      audience: { kind: 'screen' },
      payload: {
        agendaIndex: 0,
        openQuestions: [{ id: 'q-1', text: 'Who services the oven?', forRole: 'chef' }],
        speakerTalkSeconds: { chef: 2, cashier: 2 },
      },
    });
    // Phones never get the record, so it cannot pile up there.
    expect(chef.messages.filter(isRecord)).toEqual([]);

    // A late joiner gets the latest record straight away.
    const late = await connect('screen');
    await waitForEvent(late, isRecord, 'retained record');
  });

  it('publishes nothing until the meeting has started', async () => {
    app = await createTestApp({ modules: [createMeetingModule({ notetakerIntervalMs: 50 })] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const screen = await connect('screen');

    await settle(1_200);
    expect(screen.messages.filter(isRecord)).toEqual([]);

    say('Let us begin.');
    const record = await waitForEvent(screen, isRecord, 'first record', 2_000);
    expect(record).toMatchObject({ payload: { agendaIndex: 0, openQuestions: [] } });
  });

  it('says when the notes are stale and who has been quiet', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const llm = createFakeLlm(() => {
      throw new Error('gateway unreachable');
    });
    app = await createTestApp({ modules: [createMeetingModule({ llm, notetakerIntervalMs: 50 })] });
    const screen = await connect('screen');

    // Ada talks for over a minute; Bao says nothing.
    say(Array.from({ length: 160 }, () => 'word').join(' '));

    const record = await waitForEvent(
      screen,
      (event) => isRecord(event) && event.payload.notetakerStatus === 'stale',
      'stale record',
      3_000,
    );
    expect(record).toMatchObject({ payload: { quietRoles: ['cashier'], speakerTalkSeconds: { chef: 64 } } });
  });

  it('holds back unchanged records but sends a heartbeat', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // At 20x, the 30 s heartbeat comes every 1.5 real seconds.
    app = await createTestApp({ modules: [createMeetingModule({ speed: 20 })] });
    const screen = await connect('screen');
    say('Let us begin.');

    const first = await waitForEvent(screen, isRecord, 'first record', 2_000);
    expect(first).toMatchObject({ payload: { notetakerStatus: 'off', quietRoles: [] } });
    await settle(500);
    expect(screen.messages.filter(isRecord)).toHaveLength(1);

    await waitFor(() => (screen.messages.filter(isRecord).length === 2 ? true : undefined), 'heartbeat', 3_000);
  });

  it('follows the replay agenda markers and ends the meeting after the last line', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // The LLM keeps saying item 0; a replay goes by its own markers instead.
    const llm = createFakeLlm(() => reply({ agendaIndex: 0 }));
    app = await createApp({
      scenario: { ...testScenario, agenda: [...testScenario.agenda, { title: 'Till', minutes: 2, ownerRole: 'cashier' }] },
      modules: [
        createMeetingModule({
          llm,
          speed: 20,
          notetakerIntervalMs: 50,
          replay: [
            { at: 0, speaker: 'Ada (Chef)', text: 'Prep is done, I think.' },
            { at: 2, speaker: 'Bao (Cashier)', text: 'On to the till then.', agendaIndex: 1 },
          ],
        }),
      ],
    });
    const screen = await connect('screen');

    const record = await waitForEvent(
      screen,
      (event) => isRecord(event) && event.payload.agendaIndex === 1,
      'record on the second item',
    );
    // Bao's line counts towards the item it opened.
    expect(record).toMatchObject({ payload: { speakerTalkSeconds: { cashier: 2 } } });

    const count = screen.messages.filter(isRecord).length;
    await settle(2_000);
    expect(screen.messages.filter(isRecord)).toHaveLength(count);
  });

  it('logs a failing record publish instead of crashing the server', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    app = await createTestApp({ modules: [createMeetingModule({ notetakerIntervalMs: 50 })] });
    const publish = app.hub.publish.bind(app.hub);
    app.hub.publish = (event, options) => {
      if (isRecord(event)) throw new Error('refused');
      publish(event, options);
    };

    say('Let us begin.');
    await waitFor(
      () => (error.mock.calls.some(([message]) => String(message).includes('kaki host:')) ? true : undefined),
      'logged failure',
      2_500,
    );
  });
});
