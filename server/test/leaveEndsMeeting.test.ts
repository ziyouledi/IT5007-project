import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DEFAULT_MEETING_PACE, defaultMeetingSetup, type MeetingSetup, type Scenario } from '@kaki/shared';
import { createApp, type KakiApp } from '../src/app';
import { loadScenario } from '../src/core/loadScenario';
import { createMeetingModule } from '../src/host/meeting';
import { createMeetingCodeSource } from '../src/meeting/meetingCode';
import { portOf, settle, waitFor } from './helpers';

const pack: Scenario = await loadScenario('kopitiam');
const apps: KakiApp[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
});

type Person = { name: string; role?: string };

/** The real pack with two human seats and no AI stand-ins, so two people can join. */
const twoPersonSetup: MeetingSetup = {
  ...defaultMeetingSetup(pack),
  title: 'Opening huddle',
  agenda: [{ id: 'agenda-1', title: 'Opening checklist', minutes: 5, ownerRoleId: 'operations_director' }],
  seats: [
    { displayName: 'Wei Ling', roleId: 'operations_director', kind: 'person' },
    { displayName: 'Arjun', roleId: 'tech_pos_lead', kind: 'person' },
  ],
  pace: { ...DEFAULT_MEETING_PACE },
};

async function startApp(): Promise<{ app: KakiApp; port: number; setPeople(people: Person[]): void }> {
  let people: Person[] = [];
  const app = await createApp({
    speechRecognition: 'browser',
    scenario: pack,
    modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
    roomRoster: async () => people,
    meetingCode: createMeetingCodeSource('K7M2Q9'),
    rejoinGraceMs: 60_000,
    rejoinPollMs: 20,
    admissionReservationMs: 0,
  });
  apps.push(app);
  return { app, port: portOf(app), setPeople: (next) => { people = next; } };
}

function request(port: number, path: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The AI runner the meeting needs before Start can commit. */
function connectService(port: number): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=service`);
  sockets.push(socket);
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as {
      kind?: string;
      request?: { requestId?: string; attempt?: string; meetingId?: string };
    };
    const { requestId, attempt, meetingId } = message.request ?? {};
    if (message.kind !== 'prepare' || requestId === undefined || attempt === undefined || meetingId === undefined) return;
    socket.send(JSON.stringify({ kind: 'ready', requestId, attempt, meetingId }));
  });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function seatSocket(port: number, role: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${encodeURIComponent(role)}`);
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('Leave ends the meeting for the last person out', () => {
  it('ends a practice meeting when its one visitor leaves', async () => {
    const { app, port, setPeople } = await startApp();
    await connectService(port);
    const seat = 'operations_director';
    const joined = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Alice',
      participantRole: seat,
      kind: 'practice',
    });
    expect(joined.status).toBe(200);
    setPeople([{ name: 'Alice', role: seat }]);
    expect((await request(port, '/api/meeting/start', 'POST')).status).toBe(200);
    expect(app.session.phase()).toBe('running');

    (await seatSocket(port, seat)).send(JSON.stringify({ type: 'LEAVE_MEETING' }));
    await waitFor(() => (app.session.phase() === 'ended' ? true : undefined), 'the practice meeting to end');
  });

  it('keeps a team meeting running until the last person leaves, then ends it', async () => {
    const { app, port, setPeople } = await startApp();
    await connectService(port);
    const [first, second] = ['operations_director', 'tech_pos_lead'];
    expect((await request(port, '/api/setup', 'PUT', twoPersonSetup)).status).toBe(200);
    expect((await request(port, '/api/meeting/open', 'POST')).status).toBe(200);
    const people: Person[] = [];
    for (const [name, role] of [['Alice', first], ['Ben', second]] as const) {
      const joined = await request(port, '/api/livekit/token', 'POST', { participantName: name, participantRole: role, meetingCode: 'K7M2Q9' });
      expect(joined.status).toBe(200);
      people.push({ name, role });
      setPeople([...people]);
    }
    expect((await request(port, '/api/meeting/start', 'POST')).status).toBe(200);
    const alice = await seatSocket(port, first);
    const ben = await seatSocket(port, second);

    // Ben leaves while Alice is still in the room: the meeting goes on.
    ben.send(JSON.stringify({ type: 'LEAVE_MEETING' }));
    await settle(100);
    expect(app.session.phase()).toBe('running');
    setPeople([{ name: 'Alice', role: first }]);

    alice.send(JSON.stringify({ type: 'LEAVE_MEETING' }));
    await waitFor(() => (app.session.phase() === 'ended' ? true : undefined), 'the team meeting to end');
  });

  it('refuses a leave from someone who holds no seat in this meeting', async () => {
    const { app, port, setPeople } = await startApp();
    await connectService(port);
    const [first, second] = ['operations_director', 'tech_pos_lead'];
    expect((await request(port, '/api/setup', 'PUT', twoPersonSetup)).status).toBe(200);
    expect((await request(port, '/api/meeting/open', 'POST')).status).toBe(200);
    expect(
      (await request(port, '/api/livekit/token', 'POST', { participantName: 'Alice', participantRole: first, meetingCode: 'K7M2Q9' })).status,
    ).toBe(200);
    setPeople([{ name: 'Alice', role: first }]);
    expect((await request(port, '/api/meeting/start', 'POST')).status).toBe(200);

    (await seatSocket(port, second)).send(JSON.stringify({ type: 'LEAVE_MEETING' }));
    await settle(100);
    expect(app.session.phase()).toBe('running');
  });
});
