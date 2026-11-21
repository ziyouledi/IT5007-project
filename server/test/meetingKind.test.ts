import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { defaultMeetingSetup, joinSeatRoles, type Scenario } from '@kaki/shared';
import { createApp, type KakiApp } from '../src/app';
import { createAuth } from '../src/auth/module';
import { hashPassword } from '../src/auth/password';
import { createMemoryAuthStore } from '../src/auth/store';
import { loadScenario } from '../src/core/loadScenario';
import { createMeetingModule } from '../src/host/meeting';
import type { KakiModule } from '../src/core/modules';
import { createMeetingCodeSource } from '../src/meeting/meetingCode';
import { portOf, waitFor } from './helpers';

const CODE = 'K7M2Q9';
const TOKEN = 'local-test-runner-token';
const HOST_EMAIL = 'host@example.com';
const HOST_PASSWORD = 'host-password';
const pack: Scenario = await loadScenario('kopitiam');

const apps: KakiApp[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
});

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  if (value === undefined || value === '') throw new Error('Expected a cookie');
  return value;
}

async function request(
  port: number,
  path: string,
  method = 'GET',
  body?: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie !== undefined) headers.cookie = cookie;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface SocketResult {
  ok: boolean;
  ws: WebSocket;
  messages: Array<{ type: string; payload: { reason?: string } }>;
}

function connect(port: number, role: string, cookie?: string): Promise<SocketResult> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${encodeURIComponent(role)}`, { headers });
  const messages: SocketResult['messages'] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as SocketResult['messages'][number]));
  sockets.push(ws);
  return new Promise((resolve) => {
    ws.once('open', () => resolve({ ok: true, ws, messages }));
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve({ ok: false, ws, messages });
    });
    ws.once('error', () => resolve({ ok: false, ws, messages }));
  });
}

function waitForClose(ws: WebSocket): Promise<number | undefined> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve(1005);
      return;
    }
    ws.once('close', (code) => resolve(code));
  });
}

function tokenRoom(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
    video?: { room?: unknown };
  };
  if (typeof payload.video?.room !== 'string') throw new Error('The token names no room');
  return payload.video.room;
}

function practiceJoin(port: number, name: string, role = 'operations_director'): Promise<Response> {
  return request(port, '/api/livekit/token', 'POST', {
    participantName: name,
    participantRole: role,
    kind: 'practice',
  });
}

/** The AI runner the practice meeting needs before Start can commit. */
function connectService(port: number, authorization?: string): Promise<void> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/ws?role=service`,
    authorization === undefined ? undefined : { headers: { authorization } },
  );
  sockets.push(socket);
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as {
      kind?: string;
      request?: { requestId?: string; attempt?: string; meetingId?: string };
    };
    const { requestId, attempt, meetingId } = message.request ?? {};
    if (message.kind !== 'prepare' || requestId === undefined || attempt === undefined || meetingId === undefined) {
      return;
    }
    socket.send(JSON.stringify({ kind: 'ready', requestId, attempt, meetingId }));
  });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

async function openModeApp(options: {
  roomRoster?: () => Promise<Array<{ name: string }>>;
  rejoinGraceMs?: number;
  rejoinPollMs?: number;
  admissionReservationMs?: number;
  modules?: KakiModule[];
} = {}): Promise<{ app: KakiApp; port: number }> {
  const app = await createApp({
    speechRecognition: 'browser',
    scenario: pack,
    ...(options.modules === undefined ? {} : { modules: options.modules }),
    roomRoster: options.roomRoster ?? (async () => []),
    meetingCode: createMeetingCodeSource(CODE),
    rejoinGraceMs: options.rejoinGraceMs ?? 60_000,
    rejoinPollMs: options.rejoinPollMs ?? 20,
    ...(options.admissionReservationMs === undefined
      ? {}
      : { admissionReservationMs: options.admissionReservationMs }),
  });
  apps.push(app);
  return { app, port: portOf(app) };
}

async function authModeApp(options: {
  roomRoster?: () => Promise<Array<{ name: string }>>;
  rejoinGraceMs?: number;
  rejoinPollMs?: number;
  admissionReservationMs?: number;
} = {}): Promise<{ app: KakiApp; port: number }> {
  const store = createMemoryAuthStore();
  await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
  const meetingCode = createMeetingCodeSource(CODE);
  const auth = createAuth({
    store,
    offeredRoles: () => joinSeatRoles(pack).map((role) => role.id),
    meetingCode,
  });
  const app = await createApp({
    speechRecognition: 'browser',
    scenario: pack,
    auth,
    meetingCode,
    serviceToken: TOKEN,
    roomRoster: options.roomRoster ?? (async () => []),
    rejoinGraceMs: options.rejoinGraceMs ?? 60_000,
    rejoinPollMs: options.rejoinPollMs ?? 60_000,
    ...(options.admissionReservationMs === undefined
      ? {}
      : { admissionReservationMs: options.admissionReservationMs }),
    startAckTimeoutMs: 2_000,
  });
  apps.push(app);
  return { app, port: portOf(app) };
}

async function loginHost(port: number): Promise<string> {
  return cookieFrom(
    await request(port, '/api/auth/login', 'POST', { email: HOST_EMAIL, password: HOST_PASSWORD }),
  );
}

describe('meeting kind in auth mode', () => {
  it('lets a practice visitor join without a code and start, and keeps the owner out until it ends', async () => {
    const { app, port } = await authModeApp();
    await connectService(port, `Bearer ${TOKEN}`);

    const joined = await practiceJoin(port, 'Alice');
    expect(joined.status).toBe(200);
    const practiceCookie = cookieFrom(joined);
    expect(practiceCookie.startsWith('kaki_practice=')).toBe(true);
    expect(((await joined.json()) as { started: boolean }).started).toBe(false);
    expect(app.session.kind()).toBe('practice');

    // The practice meeting takes one person.
    const second = await practiceJoin(port, 'Ben', 'menu_store_lead');
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toMatch(/full/);

    const host = await loginHost(port);

    // The owner cannot open the team meeting over a practice meeting.
    const blockedOpen = await request(port, '/api/meeting/open', 'POST', undefined, host);
    expect(blockedOpen.status).toBe(409);
    expect(await blockedOpen.json()).toMatchObject({ practiceInProgress: true });

    // The practice capability opens nothing else: no setup read/write, no tools, no owner route.
    expect((await request(port, '/api/setup', 'GET', undefined, practiceCookie)).status).toBe(401);
    expect((await request(port, '/api/setup/tools', 'GET', undefined, practiceCookie)).status).toBe(403);
    expect((await request(port, '/api/setup', 'PUT', {}, practiceCookie)).status).toBe(403);
    expect((await request(port, '/api/meeting/open', 'POST', undefined, practiceCookie)).status).toBe(403);

    // It may start its own practice meeting.
    const started = await request(port, '/api/meeting/start', 'POST', undefined, practiceCookie);
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ started: true });
    expect(app.session.phase()).toBe('running');

    const state = await request(port, '/api/meeting/state');
    expect(await state.json()).toMatchObject({ started: true, kind: 'practice' });

    const stillBlocked = await request(port, '/api/meeting/open', 'POST', undefined, host);
    expect(stillBlocked.status).toBe(409);
    expect(await stillBlocked.json()).toMatchObject({ practiceInProgress: true });

    // End the practice meeting: it becomes a clean lobby with no kind.
    const ended = await request(port, '/api/meeting/end-practice', 'POST', undefined, host);
    expect(ended.status).toBe(200);
    expect(app.session.kind()).toBeUndefined();
    expect((await request(port, '/api/meeting/state').then((response) => response.json())) as {
      kind?: string;
    }).not.toHaveProperty('kind');

    // Now the owner opens the real meeting.
    const opened = await request(port, '/api/meeting/open', 'POST', undefined, host);
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ kind: 'real', phase: 'lobby' });

    // A participant needs the meeting code.
    const noCode = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Cara',
      participantRole: 'operations_director',
    });
    expect(noCode.status).toBe(403);
    expect(await noCode.json()).toMatchObject({ needsCode: true });
    const withCode = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Cara',
      participantRole: 'operations_director',
      meetingCode: CODE,
    });
    expect(withCode.status).toBe(200);
    expect(app.session.kind()).toBe('real');

    // The old practice cookie cannot start the real meeting.
    const stale = await request(port, '/api/meeting/start', 'POST', undefined, practiceCookie);
    expect(stale.status).toBe(401);
  });
});

describe('practice scenario projection', () => {
  it('offers the pack seats even when the owner draft names only custom roles', async () => {
    const { app, port } = await authModeApp();
    const base = defaultMeetingSetup(pack);
    app.session.setDraft({
      ...base,
      roles: [{ id: 'owner_only', label: 'Owner only', facilitator: false }],
      seats: [{ displayName: 'Only', roleId: 'owner_only', kind: 'person' }],
      agenda: [{ id: 'agenda-1', title: 'Only item', minutes: 5, ownerRoleId: 'owner_only' }],
    });

    const response = await request(port, '/api/scenario?kind=practice');
    expect(response.status).toBe(200);
    const offered = joinSeatRoles((await response.json()) as Scenario).map((role) => role.id);
    expect(offered).toEqual(joinSeatRoles(pack).map((role) => role.id));
    expect(offered).not.toContain('owner_only');
  });
});

describe('meeting kind in open mode', () => {
  it('refuses practice while a real meeting is open and leaves the real path unchanged', async () => {
    const { app, port } = await openModeApp();

    const opened = await request(port, '/api/meeting/open', 'POST');
    expect(opened.status).toBe(200);
    expect(app.session.kind()).toBe('real');

    const refused = await practiceJoin(port, 'Alice');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      realInProgress: true,
      error: 'A team meeting is in progress right now. Try practice again later.',
    });

    // A real participant still joins the open meeting exactly as before (first arrival, no code).
    const realJoin = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Alice',
      participantRole: 'operations_director',
      kind: 'real',
    });
    expect(realJoin.status).toBe(200);
    expect(app.session.kind()).toBe('real');
  });

  it('refuses a legacy plain join until the owner opens, then records the meeting as real', async () => {
    const { app, port } = await openModeApp();

    const refused = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Alice',
      participantRole: 'operations_director',
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(
      'No team meeting is open right now. Ask the meeting owner for the invite link.',
    );

    expect((await request(port, '/api/meeting/open', 'POST')).status).toBe(200);
    const legacy = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Alice',
      participantRole: 'operations_director',
    });
    expect(legacy.status).toBe(200);
    expect(((await legacy.json()) as { started: boolean }).started).toBe(false);
    expect(app.session.kind()).toBe('real');
  });

  it('protects an ended team meeting from practice until its owner leaves the room', async () => {
    let people: Array<{ name: string }> = [];
    const { app, port } = await authModeApp({
      roomRoster: async () => people,
      admissionReservationMs: 0,
    });
    await connectService(port, `Bearer ${TOKEN}`);
    const host = await loginHost(port);
    expect((await request(port, '/api/meeting/open', 'POST', undefined, host)).status).toBe(200);
    const joined = await request(
      port,
      '/api/livekit/token',
      'POST',
      { participantName: 'Owner', participantRole: 'operations_director' },
      host,
    );
    expect(joined.status).toBe(200);
    // Taking a seat replaces the host's session, so Start must use the cookie the join returned.
    const seatCookie = cookieFrom(joined);
    people = [{ name: 'Owner' }];
    expect((await request(port, '/api/meeting/start', 'POST', undefined, seatCookie)).status).toBe(200);
    app.session.end();
    expect(app.session.phase()).toBe('ended');
    expect(app.session.kind()).toBeUndefined();
    expect(app.session.reviewingEndedTeamMeeting()).toBe(true);

    // The owner is still in the old room. That seat belongs to the ended team meeting, so a
    // practice visitor must not reset the review under them.
    const refused = await practiceJoin(port, 'Ben');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ realInProgress: true });
    expect(app.session.holders().map((holder) => holder.name)).toEqual(['owner']);

    // Nobody is left in the room: the empty-room expiry drops the review and practice may start.
    app.session.pruneHolders();
    app.session.finishReview();
    const practice = await practiceJoin(port, 'Ben');
    expect(practice.status).toBe(200);
    expect(app.session.kind()).toBe('practice');
    expect(app.session.holders().map((holder) => holder.name)).toEqual(['ben']);
  });

  it('protects an ended team meeting until its unapproved minutes are published', async () => {
    let people: Array<{ name: string }> = [];
    const { app, port } = await authModeApp({
      roomRoster: async () => people,
      admissionReservationMs: 0,
    });
    await connectService(port, `Bearer ${TOKEN}`);
    const host = await loginHost(port);
    expect((await request(port, '/api/meeting/open', 'POST', undefined, host)).status).toBe(200);
    const joined = await request(
      port,
      '/api/livekit/token',
      'POST',
      { participantName: 'Owner', participantRole: 'operations_director' },
      host,
    );
    expect(joined.status).toBe(200);
    const seatCookie = cookieFrom(joined);
    people = [{ name: 'Owner' }];
    expect((await request(port, '/api/meeting/start', 'POST', undefined, seatCookie)).status).toBe(200);

    const minutes = app.tasks.suggestWithPurpose(
      {
        title: 'Publish meeting minutes to the team wiki',
        context: 'The full meeting summary.',
        suggestedAssignee: 'operations_director',
        actionKind: 'wiki_page',
      },
      'meeting_minutes',
    );
    app.tasks.transition(minutes.id, 'DISPATCHED', { assignee: 'operations_director' });
    app.tasks.transition(minutes.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    app.tasks.transition(minutes.id, 'DRAFT_READY', {
      draft: { target: 'Wiki: meeting notes', subject: 'Minutes', body: 'Unapproved draft' },
    });

    app.session.end();
    expect(app.session.reviewingEndedTeamMeeting()).toBe(true);
    const refused = await practiceJoin(port, 'Ben');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ realInProgress: true });

    // Published: the review is over, so practice may take the server.
    app.tasks.transition(minutes.id, 'RUNNING');
    app.tasks.transition(minutes.id, 'COMPLETED', { artifactUrl: 'https://wiki.example/minutes' });
    expect(app.session.reviewingEndedTeamMeeting()).toBe(false);
    const practice = await practiceJoin(port, 'Ben');
    expect(practice.status).toBe(200);
    expect(app.session.kind()).toBe('practice');
  });

  it('frees a practice meeting once its visitor leaves, and the next practice visitor gets a fresh one', async () => {
    let people: Array<{ name: string }> = [];
    const { app, port } = await openModeApp({
      roomRoster: async () => people,
      rejoinGraceMs: 40,
      admissionReservationMs: 0,
    });
    await connectService(port);

    const first = await practiceJoin(port, 'Alice');
    expect(first.status).toBe(200);
    people = [{ name: 'Alice' }];
    const started = await request(port, '/api/meeting/start', 'POST');
    expect(started.status).toBe(200);
    expect(app.session.phase()).toBe('running');

    // Alice leaves. The existing empty-room grace prunes her and abandons the meeting.
    people = [];
    await waitFor(() => (app.session.abandoned() ? true : undefined), 'the empty-room grace to end');
    expect(app.session.holders()).toHaveLength(0);

    const second = await practiceJoin(port, 'Ben');
    expect(second.status).toBe(200);
    expect(app.session.kind()).toBe('practice');
    expect(app.session.holders()).toHaveLength(1);
    expect(app.session.holders()[0]?.name).toBe('ben');
    expect(app.session.phase()).toBe('lobby');
  });

  it('mints a replacement practice token for the room identity it actually enters', async () => {
    let people: Array<{ name: string }> = [];
    const { app, port } = await openModeApp({
      roomRoster: async () => people,
      rejoinGraceMs: 40,
      rejoinPollMs: 20,
      admissionReservationMs: 0,
    });
    await connectService(port);

    const first = await practiceJoin(port, 'Alice');
    expect(first.status).toBe(200);
    const firstRoom = tokenRoom(((await first.json()) as { token: string }).token);
    const oldMeetingId = app.session.snapshot().meetingId;
    people = [{ name: 'Alice' }];
    expect((await request(port, '/api/meeting/start', 'POST')).status).toBe(200);

    // Alice leaves; the grace ends with nobody back, so the next visitor starts a new meeting.
    people = [];
    await waitFor(() => (app.session.abandoned() ? true : undefined), 'the empty-room grace to end');

    const second = await practiceJoin(port, 'Ben');
    expect(second.status).toBe(200);
    const secondRoom = tokenRoom(((await second.json()) as { token: string }).token);
    const newMeetingId = app.session.snapshot().meetingId;
    expect(newMeetingId).not.toBe(oldMeetingId);
    expect(secondRoom).not.toBe(firstRoom);
    expect(secondRoom).toContain(newMeetingId);
  });

  it('clears the kind when a practice meeting is ended', async () => {
    const { app, port } = await openModeApp();

    expect((await practiceJoin(port, 'Alice')).status).toBe(200);
    expect(app.session.kind()).toBe('practice');

    const ended = await request(port, '/api/meeting/end-practice', 'POST');
    expect(ended.status).toBe(200);
    expect(app.session.kind()).toBeUndefined();
    expect(app.session.phase()).toBe('lobby');
    expect(app.session.holders()).toHaveLength(0);

    // With no practice meeting left, there is nothing to end.
    expect((await request(port, '/api/meeting/end-practice', 'POST')).status).toBe(409);
  });
});

describe('meeting kind security regressions', () => {
  it('revokes practice screen, lifecycle and seat sockets when practice ends and a real meeting opens', async () => {
    const { app, port } = await authModeApp();
    const joined = await practiceJoin(port, 'Alice');
    expect(joined.status).toBe(200);
    const practiceCookie = cookieFrom(joined);

    const screen = await connect(port, 'screen', practiceCookie);
    const lifecycle = await connect(port, 'lifecycle', practiceCookie);
    const seat = await connect(port, 'operations_director', practiceCookie);
    expect(screen.ok && lifecycle.ok && seat.ok).toBe(true);
    const screenClosed = waitForClose(screen.ws);
    const lifecycleClosed = waitForClose(lifecycle.ws);
    const seatClosed = waitForClose(seat.ws);

    // The practice page may read the screen and move its own agenda, but the rest of the screen's
    // command authority (here: replacing the meeting) belongs to the owner.
    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    const rejection = await waitFor(
      () => screen.messages.find((message) => message.type === 'COMMAND_REJECTED'),
      'the practice screen command to be refused',
    );
    expect(rejection.payload.reason).toMatch(/read the screen but not control it/);
    expect(app.session.kind()).toBe('practice');

    const host = await loginHost(port);
    expect((await request(port, '/api/meeting/end-practice', 'POST', undefined, host)).status).toBe(200);
    expect((await request(port, '/api/meeting/open', 'POST', undefined, host)).status).toBe(200);

    expect(await Promise.all([screenClosed, lifecycleClosed, seatClosed])).toEqual([4001, 4001, 4001]);
    const stale = await connect(port, 'screen', practiceCookie);
    expect(stale.ok).toBe(false);
  });

  it('lets the practice visitor advance and end their own practice meeting', async () => {
    const { app, port } = await openModeApp({ modules: [createMeetingModule()] });
    await connectService(port);
    const joined = await practiceJoin(port, 'Alice');
    expect(joined.status).toBe(200);
    expect((await request(port, '/api/meeting/start', 'POST')).status).toBe(200);
    expect(app.session.phase()).toBe('running');

    const screen = await connect(port, 'screen');
    expect(screen.ok).toBe(true);
    screen.ws.send(JSON.stringify({ type: 'NEXT_AGENDA_ITEM' }));
    const advanced = await waitFor(
      () =>
        screen.messages.find(
          (message) =>
            message.type === 'MEETING_RECORD_UPDATED' &&
            (message as { payload: { agendaIndex?: number } }).payload.agendaIndex === 1,
        ),
      'the practice agenda to move to item 2',
    );
    expect(advanced).toBeTruthy();

    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitFor(() => (app.session.phase() === 'ended' ? true : undefined), 'the practice meeting to end');
    expect(app.session.phase()).toBe('ended');
  });

  it('never lets an old practice LiveKit token name the room of the real meeting that replaces it', async () => {
    const { app, port } = await authModeApp();
    const practice = await practiceJoin(port, 'Alice');
    expect(practice.status).toBe(200);
    const practiceBody = (await practice.json()) as { token: string };
    const practiceMeetingId = app.session.snapshot().meetingId;
    const oldRoom = tokenRoom(practiceBody.token);
    expect(oldRoom).toContain(practiceMeetingId);

    const host = await loginHost(port);
    expect((await request(port, '/api/meeting/end-practice', 'POST', undefined, host)).status).toBe(200);
    expect((await request(port, '/api/meeting/open', 'POST', undefined, host)).status).toBe(200);
    const real = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Cara',
      participantRole: 'operations_director',
      meetingCode: CODE,
    });
    expect(real.status).toBe(200);
    const realRoom = tokenRoom(((await real.json()) as { token: string }).token);
    expect(realRoom).not.toBe(oldRoom);
    expect(realRoom).toContain(app.session.snapshot().meetingId);
  });

  it('refuses /api/join escalation from practice, and hands out no code or session for another seat', async () => {
    const { port } = await authModeApp();
    const practice = await practiceJoin(port, 'Alice');
    expect(practice.status).toBe(200);
    const practiceCookie = cookieFrom(practice);
    expect(((await practice.json()) as { meetingCode?: unknown }).meetingCode).toBeUndefined();

    const otherSeat = await request(port, '/api/join', 'POST', { code: CODE, role: 'menu_store_lead' }, practiceCookie);
    expect(otherSeat.status).toBe(403);
    expect(((await otherSeat.json()) as { error: string }).error).toMatch(/only opens the seat its visitor took/);

    const noCapability = await request(port, '/api/join', 'POST', { code: CODE, role: 'operations_director' });
    expect(noCapability.status).toBe(403);

    const ownSeat = await request(port, '/api/join', 'POST', { code: CODE, role: 'operations_director' }, practiceCookie);
    expect(ownSeat.status).toBe(200);
    expect(ownSeat.headers.get('set-cookie')).toBeNull();
    expect(await ownSeat.json()).toEqual({ kind: 'practice', role: 'operations_director' });
  });

  it('never lets a name alone resume or replace a practice seat', async () => {
    const { app, port } = await authModeApp({ rejoinGraceMs: 60_000, admissionReservationMs: 0 });
    const first = await practiceJoin(port, 'Alice', 'operations_director');
    expect(first.status).toBe(200);
    const capability = cookieFrom(first);
    const meetingId = app.session.snapshot().meetingId;
    const generation = app.session.generation();

    // The capability opens exactly the seat it was granted for, never another role's media seat.
    const wrongSeat = await request(
      port,
      '/api/livekit/token',
      'POST',
      { participantName: 'Alice', participantRole: 'menu_store_lead', kind: 'practice' },
      capability,
    );
    expect(wrongSeat.status).toBe(403);

    // The same name without the capability is a different person: it starts a new practice
    // meeting, rotating the identity and generation and revoking the old visitor's authority.
    const takeover = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Alice',
      participantRole: 'menu_store_lead',
      kind: 'practice',
    });
    expect(takeover.status).toBe(200);
    expect(app.session.snapshot().meetingId).not.toBe(meetingId);
    expect(app.session.generation()).toBeGreaterThan(generation);
    expect(app.session.practiceSeat()).toBe('menu_store_lead');
    const stale = await request(port, '/api/meeting/start', 'POST', undefined, capability);
    expect([401, 403]).toContain(stale.status);
  });

  it('refuses a queued practice Start once the owner has opened a real meeting', async () => {
    let stall = false;
    let release: ((people: Array<{ name: string }>) => void) | undefined;
    const { app, port } = await authModeApp({
      roomRoster: async () => {
        if (stall) {
          stall = false;
          return new Promise<Array<{ name: string }>>((resolve) => {
            release = resolve;
          });
        }
        return [];
      },
      rejoinGraceMs: 30,
      rejoinPollMs: 10,
      admissionReservationMs: 0,
    });

    const joined = await practiceJoin(port, 'Alice');
    expect(joined.status).toBe(200);
    const practiceCookie = cookieFrom(joined);
    await waitFor(
      () =>
        app.session.kind() === 'practice' &&
        app.session.phase() === 'lobby' &&
        app.session.holders().length === 0
          ? true
          : undefined,
      'the abandoned practice lobby to expire',
    );

    // Stall one admission, then queue the owner's open and the practice Start behind it.
    stall = true;
    const stalled = practiceJoin(port, 'Ben', 'cosmonaut');
    await waitFor(() => (release === undefined ? undefined : true), 'the stalled roster read');
    const host = await loginHost(port);
    const opened = request(port, '/api/meeting/open', 'POST', undefined, host);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = request(port, '/api/meeting/start', 'POST', undefined, practiceCookie);
    await new Promise((resolve) => setTimeout(resolve, 30));
    release?.([]);

    expect((await stalled).status).toBe(400);
    expect((await opened).status).toBe(200);
    const startResponse = await started;
    // Whichever side of the queue the start lands on, it may never open the real meeting: the
    // access layer refuses a stale practice principal, and the queued path re-checks the kind.
    expect([401, 403]).toContain(startResponse.status);
    expect(((await startResponse.json()) as { error: string }).error).toMatch(
      /Practice access has ended|Only the meeting owner/,
    );
    expect(app.session.kind()).toBe('real');
    expect(app.session.phase()).toBe('lobby');
  });

  it('keeps who has joined off the public state and on the owner-only route', async () => {
    const { app, port } = await authModeApp();
    expect((await practiceJoin(port, 'Alice')).status).toBe(200);

    const publicState = (await (await request(port, '/api/meeting/state')).json()) as Record<string, unknown>;
    expect(publicState).not.toHaveProperty('participants');

    expect((await request(port, '/api/meeting/participants')).status).toBe(401);
    const host = await loginHost(port);
    const owner = await request(port, '/api/meeting/participants', 'GET', undefined, host);
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({ participants: [{ name: 'alice', seat: 'operations_director' }] });
    expect(app.session.holders()).toHaveLength(1);
  });

  it('joins, never resets, the meeting the owner just opened when a friend is first into the empty lobby', async () => {
    let people: Array<{ name: string }> = [];
    const { app, port } = await authModeApp({ roomRoster: async () => people });
    const host = await loginHost(port);
    expect((await request(port, '/api/meeting/open', 'POST', undefined, host)).status).toBe(200);
    const generation = app.session.generation();
    const meetingId = app.session.snapshot().meetingId;

    // The owner is still on /setup: nobody is seated yet, so the room reads empty. The first
    // friend with the code joins that meeting; a reset here would wipe the opened lobby.
    const friend = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Cara',
      participantRole: 'operations_director',
      meetingCode: CODE,
    });
    expect(friend.status).toBe(200);
    expect(app.session.kind()).toBe('real');
    expect(app.session.phase()).toBe('lobby');
    expect(app.session.generation()).toBe(generation);
    expect(app.session.snapshot().meetingId).toBe(meetingId);
    expect(app.session.holders().map((holder) => holder.name)).toEqual(['cara']);
  });

  it('releases practice when the owner closes a never-started room', async () => {
    const { app, port } = await openModeApp();
    expect((await request(port, '/api/meeting/open', 'POST')).status).toBe(200);
    expect(app.session.kind()).toBe('real');
    expect((await request(port, '/api/meeting/close', 'POST')).status).toBe(200);
    expect(app.session.kind()).toBeUndefined();
    expect(app.session.phase()).toBe('lobby');
    expect((await practiceJoin(port, 'Ben')).status).toBe(200);
  });

  it('releases practice when a verified empty real lobby expires', async () => {
    let people: Array<{ name: string }> = [];
    const { app, port } = await openModeApp({
      roomRoster: async () => people,
      rejoinGraceMs: 40,
      admissionReservationMs: 0,
    });
    expect((await request(port, '/api/meeting/open', 'POST')).status).toBe(200);
    const joined = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Alice',
      participantRole: 'operations_director',
    });
    expect(joined.status).toBe(200);
    people = [];
    await waitFor(
      () => (app.session.kind() === undefined && app.session.holders().length === 0 ? true : undefined),
      'the empty real lobby to be released',
    );
    expect((await practiceJoin(port, 'Ben')).status).toBe(200);
  });

  it('unlocks setup and reopens once everyone left a started team meeting and it was released', async () => {
    let people: Array<{ name: string }> = [];
    const { app, port } = await openModeApp({
      roomRoster: async () => people,
      rejoinGraceMs: 40,
      admissionReservationMs: 0,
    });
    await connectService(port);
    expect((await request(port, '/api/meeting/open', 'POST')).status).toBe(200);
    const joined = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Alice',
      participantRole: 'operations_director',
    });
    expect(joined.status).toBe(200);
    people = [{ name: 'Alice' }];
    expect((await request(port, '/api/meeting/start', 'POST')).status).toBe(200);
    expect(((await (await request(port, '/api/setup', 'GET')).json()) as { started: boolean }).started).toBe(true);

    // Alice leaves without ending; the empty-room grace abandons and releases the meeting.
    people = [];
    await waitFor(
      () => (app.session.abandoned() && app.session.kind() === undefined ? true : undefined),
      'the empty started meeting to be released',
    );
    expect(app.session.phase()).toBe('running');
    const setup = (await (await request(port, '/api/setup', 'GET')).json()) as { started: boolean; setup: unknown };
    expect(setup.started).toBe(false);
    expect((await request(port, '/api/setup', 'PUT', setup.setup)).status).toBe(200);

    expect((await request(port, '/api/meeting/open', 'POST')).status).toBe(200);
    expect(app.session.kind()).toBe('real');
    expect(app.session.phase()).toBe('lobby');
  });

  it('admits only one of two same-name practice joins without the capability', async () => {
    const { app, port } = await authModeApp();
    const [first, second] = await Promise.all([
      practiceJoin(port, 'Alice'),
      practiceJoin(port, 'Alice'),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(app.session.holders()).toHaveLength(1);
  });
});
