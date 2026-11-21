import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { defaultMeetingSetup, demoPackNpcProfileIds, demoRoomName, deriveMeetingScenario, hostIdentityOf, isHumanParticipant, isPackFreeMeeting, joinSeatRoles, KAKI_LISTENER_IDENTITY, MAX_TYPED_LENGTH, MEETING_ENDED_MESSAGE, meetingScenarioFromSetup, parseMeetingSetup, resolveAgendaPick, setMeetingAgenda, setupPersonSeatRoles, setupScenarioRoles, shuffleAgendaForRole, type MeetingMemoryEntry, type MeetingSetup, type RunnerMeetingSnapshot, type Scenario } from '@kaki/shared';
import {
  accessProblem,
  assertSafeBind,
  assertSafeMattermost,
  bearerToken,
  isLoopbackAddress,
  matchRoute,
  tokenMatches,
  type Principal,
  type Route,
} from './http/access';
import { cookieValue, sendJson } from './http/http';
import { assertReadableSavedMeeting, assertReadableSavedSetup } from './persist/state';
import type { CalendarSettings } from './action/calendar';
import type { ActionToolOptions } from './action/tools';
import type { Auth } from './auth/module';
import { createAttemptLimiter } from './http/attemptLimiter';
import { audienceRole, type ClientAudience } from './core/audience';
import { CommandError, createHub, type Hub } from './core/hub';
import type { KakiModule } from './core/modules';
import type { MeetingPersistence } from './persist/persistence';
import {
  createMeetingCodeSource,
  MEETING_CODE_FAILURE_LIMIT,
  MEETING_CODE_WINDOW_MS,
  type MeetingCodeSource,
} from './meeting/meetingCode';
import type { MeetingPauseControl } from './host';
import { createRejoinGuard, createRoomPoll, rejoinGraceMsFromEnv, roomPollIntervalMs, REJOIN_POLL_MS } from './meeting/rejoin';
import { buildRunnerMeetingSnapshot, hostIsHumanFromSession } from './meeting/runnerState';
import { createMeetingSession, type MeetingSession } from './meeting/session';
import { createTaskStore, type TaskStore } from './meeting/tasks';
import { ADMISSION_RESERVATION_MS, createAdmissionQueue, createSeatReservations, livekitRoster, removeRoomHumans, type RoomRoster } from './services/livekit';
import { PRACTICE_COOKIE, type RequestContext, type RoutedRoute, type StartOutcome } from './http/routeCall';
import { handleAuthRoutes } from './http/routes/auth';
import { handleHealth, handleLivekitToken, handleMeetingClose, handleMeetingCode, handleMeetingEndPractice, handleMeetingOpen, handleMeetingParticipants, handleMeetingStart, handleMeetingState } from './http/routes/meeting';
import { handleCalendarEvent, handleMattermostOpen, handleScenario, handleScenarioFull } from './http/routes/scenario';
import { handleEmit, handleHumanLine, handleMeetingMemory, handleSettleTopic, handleSuggestTask } from './http/routes/runner';
import { handleGetSetup, handleGetSetupTools, handleImportCalendar, handlePutSetup, handleSetupBlank, handleSetupToolTest } from './http/routes/setup';

/** Options for creating the Kaki server; port 0 picks a free port for tests. */
export interface CreateAppOptions {
  port?: number;
  /**
   * The bind address, 127.0.0.1 by default (the production entry point always passes one). A
   * loopback default keeps a test server's port its own: on macOS a wildcard bind can share its
   * port with another program's 127.0.0.1 listener, which then answers the test's requests.
   * An open (sign-in off) non-loopback bind needs KAKI_ALLOW_OPEN=1.
   */
  host?: string;
  scenario: Scenario;
  modules?: KakiModule[];
  devRoutes?: boolean;
  /** Optional sign-in, sessions and WebSocket gating; absent means auth is off. */
  auth?: Auth;
  /** The mock calendar server; when set, `/api/calendar/:id` shows an event a person can read. */
  calendar?: CalendarSettings;
  /** How the setup import reads the calendar; tests inject a fake, elsewhere global fetch is used. */
  calendarFetch?: typeof fetch;
  actionTools?: ActionToolOptions;
  /** Who is in a LiveKit room, to refuse a join when the meeting is full; defaults to asking LiveKit. */
  roomRoster?: RoomRoster;
  /** When true, modules may draft and review actions but must never send them to external services. */
  draftOnly?: boolean;
  /** Seconds since the meeting started, for stamping settled cards with their source time; omit when unknown. */
  meetingElapsedSeconds?: () => number | undefined;
  /** The live agenda item, for a reconnecting runner; omit when unknown. */
  meetingAgendaIndex?: () => number | undefined;
  /** Whether the server-owned agenda clock is paused, for the runner snapshot. */
  meetingPaused?: () => boolean | undefined;
  /**
   * The server's pause control. When present, the app pauses a running meeting for an empty room
   * and resumes it when someone returns; a person's explicit Stop stays paused.
   */
  meetingPause?: MeetingPauseControl;
  /** Keeps the meeting, notetaker and tasks across a restart; absent means memory only. */
  persistence?: MeetingPersistence;
  /** How long an empty meeting is kept for the same person to return; defaults to KAKI_REJOIN_GRACE_MS or 2 minutes. */
  rejoinGraceMs?: number;
  /** How often the app server checks who is in the room; defaults to 5 seconds. */
  rejoinPollMs?: number;
  /**
   * How long the room must read empty before a running meeting auto-pauses; defaults to
   * EMPTY_ROOM_PAUSE_MS. Tests set it low so a blip can be told from a real departure quickly.
   */
  emptyRoomPauseMs?: number;
  /** How long a seat stays reserved after a token is issued; defaults to 15 seconds. */
  admissionReservationMs?: number;
  /** How long Start waits for the AI runner to open the meeting; defaults to 6 seconds. */
  startAckTimeoutMs?: number;
  /** Shared secret the AI runner uses for its service channel; defaults to KAKI_SERVICE_TOKEN. */
  serviceToken?: string;
  /** The one code shared with phone sign-in; omitted creates one that rotates with the meeting. */
  meetingCode?: MeetingCodeSource;
  /**
   * Who hears a person's speech: the runner's server-side recogniser (the default) or the browser's.
   * A server-side meeting needs a connected runner even when every seat is a person.
   */
  speechRecognition?: 'server' | 'browser';
}

/** A listening Kaki server and its hub and task store. */
export interface KakiApp {
  server: Server;
  hub: Hub;
  tasks: TaskStore;
  session: MeetingSession;
  memory: readonly MeetingMemoryEntry[];
  /** Every HTTP route this server serves, each with its mandatory access level. */
  routes: readonly Route[];
  close(): Promise<void>;
}

/**
 * The one route table. Every HTTP path this server answers is declared here with its mandatory
 * access level; the access check runs once, before any handler, and an unlisted path is a 404.
 */
function buildRouteTable({ auth }: { auth: Auth | undefined }): RoutedRoute[] {
  const routes: RoutedRoute[] = [
    { method: 'GET', path: '/health', access: 'public', handle: handleHealth },
    { method: 'GET', path: '/api/meeting/state', access: 'public', handle: handleMeetingState },
    { method: 'GET', path: '/api/meeting/participants', access: 'host', handle: handleMeetingParticipants },
    { method: 'GET', path: '/api/meeting-code', access: 'host', handle: handleMeetingCode },
    { method: 'GET', path: '/api/runner/meeting-state', access: 'service', handle: handleMeetingState },
    { method: 'POST', path: '/api/livekit/token', access: 'public', handle: handleLivekitToken },
    { method: 'POST', path: '/api/meeting/start', access: 'host-or-practice', handle: handleMeetingStart },
    { method: 'POST', path: '/api/meeting/open', access: 'host', handle: handleMeetingOpen },
    { method: 'POST', path: '/api/meeting/close', access: 'host', handle: handleMeetingClose },
    { method: 'POST', path: '/api/meeting/end-practice', access: 'host', handle: handleMeetingEndPractice },
    { method: 'GET', path: '/api/mattermost/open', access: 'session', handle: handleMattermostOpen },
    { method: 'GET', path: '/api/calendar/:id', access: 'public', handle: handleCalendarEvent },
    { method: 'GET', path: '/api/scenario', access: 'public', handle: handleScenario },
    { method: 'GET', path: '/api/scenario/full', access: 'service', handle: handleScenarioFull },
    { method: 'GET', path: '/api/setup', access: 'session', handle: handleGetSetup },
    { method: 'GET', path: '/api/setup/tools', access: 'host', handle: handleGetSetupTools },
    { method: 'POST', path: '/api/setup/tools/:kind/test', access: 'host', handle: handleSetupToolTest },
    { method: 'PUT', path: '/api/setup', access: 'host', handle: handlePutSetup },
    { method: 'POST', path: '/api/setup/blank', access: 'host', handle: handleSetupBlank },
    { method: 'POST', path: '/api/setup/import-calendar', access: 'host', handle: handleImportCalendar },
    { method: 'POST', path: '/api/runner/emit', access: 'service', handle: handleEmit },
    { method: 'POST', path: '/api/runner/human-line', access: 'service', handle: handleHumanLine },
    { method: 'POST', path: '/api/runner/suggest-task', access: 'service', handle: handleSuggestTask },
    { method: 'POST', path: '/api/runner/meeting-memory', access: 'service', handle: handleMeetingMemory },
    { method: 'POST', path: '/api/runner/settle-topic', access: 'service', handle: handleSettleTopic },
    { method: 'POST', path: '/dev/emit', access: 'dev', handle: handleEmit },
    { method: 'POST', path: '/dev/suggest-task', access: 'dev', handle: handleSuggestTask },
    { method: 'POST', path: '/dev/meeting-memory', access: 'dev', handle: handleMeetingMemory },
    { method: 'POST', path: '/dev/settle-topic', access: 'dev', handle: handleSettleTopic },
  ];

  if (auth === undefined) {
    routes.push({ method: 'GET', path: '/api/auth/me', access: 'public', handle: handleAuthRoutes });
    return routes;
  }

  routes.push(
    { method: 'POST', path: '/api/auth/login', access: 'public', handle: handleAuthRoutes },
    { method: 'POST', path: '/api/auth/logout', access: 'public', handle: handleAuthRoutes },
    { method: 'GET', path: '/api/auth/me', access: 'public', handle: handleAuthRoutes },
    { method: 'POST', path: '/api/join', access: 'public', handle: handleAuthRoutes },
  );
  return routes;
}

/** Resolve who a request belongs to: a service token first, then this meeting's session. */
async function resolvePrincipal(
  request: IncomingMessage,
  context: {
    auth?: Auth;
    serviceToken?: string;
    practicePrincipal?(request: IncomingMessage): Principal | undefined;
  },
): Promise<Principal> {
  if (
    context.serviceToken !== undefined &&
    tokenMatches(bearerToken(request), context.serviceToken)
  ) {
    return { kind: 'service' };
  }
  if (context.auth !== undefined) {
    const principal = await context.auth.resolvePrincipal(request);
    // A signed-in owner or seat wins over any stale practice cookie.
    if (principal !== undefined) return principal;
  }
  const practice = context.practicePrincipal?.(request);
  if (practice !== undefined) return practice;
  return { kind: 'anonymous' };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = request.method ?? 'GET';
    const match = matchRoute(context.routes, method, path);
    if (match === undefined) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    const principal = await resolvePrincipal(request, context);
    const denied = accessProblem(match.route, principal, {
      authEnabled: context.auth !== undefined,
      devRoutes: context.devRoutes,
      serviceTokenConfigured: context.serviceToken !== undefined && context.serviceToken !== '',
      loopback: isLoopbackAddress(request.socket.remoteAddress),
      rawPath: request.url ?? '',
    });
    if (denied !== undefined) {
      sendJson(response, denied.status, { error: denied.error });
      return;
    }

    await match.route.handle({ request, response, context, url, path, method, principal });
  } catch (error) {
    if (error instanceof CommandError) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    console.error('kaki server: request failed', error);
    sendJson(response, 500, { error: 'Internal server error' });
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    const ready = () => {
      server.off('error', onError);
      resolve();
    };
    server.listen(port, host, ready);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Create the HTTP server, the `/ws` hub and the task store, then start every module. */
export async function createApp({
  port = 0,
  host = '127.0.0.1',
  scenario,
  modules = [],
  devRoutes = false,
  auth,
  calendar,
  calendarFetch,
  actionTools = {},
  roomRoster = livekitRoster(),
  draftOnly = false,
  meetingElapsedSeconds,
  meetingAgendaIndex,
  meetingPaused,
  meetingPause,
  persistence,
  rejoinGraceMs,
  rejoinPollMs,
  emptyRoomPauseMs,
  admissionReservationMs = ADMISSION_RESERVATION_MS,
  startAckTimeoutMs = 6_000,
  serviceToken = process.env.KAKI_SERVICE_TOKEN?.trim(),
  meetingCode: meetingCodeOption,
  speechRecognition = 'server',
}: CreateAppOptions): Promise<KakiApp> {
  assertSafeBind(host, auth !== undefined);
  assertSafeMattermost(auth !== undefined);
  if (devRoutes && auth !== undefined) {
    throw new Error(
      'kaki server: KAKI_DEV_ROUTES=1 cannot be combined with KAKI_AUTH=1; the dev routes are a local-only tool. Unset one of them.',
    );
  }
  const routes = buildRouteTable({ auth });
  const meetingCode = meetingCodeOption ?? createMeetingCodeSource();
  const meetingCodeAttempts =
    auth?.meetingCodeLimiter ??
    createAttemptLimiter({
      limit: MEETING_CODE_FAILURE_LIMIT,
      windowMs: MEETING_CODE_WINDOW_MS,
    });
  const agendaPick = process.env.KAKI_AGENDA_PICK?.trim();
  const fullScenario = {
    ...scenario,
    agenda: [...scenario.agenda],
    roles: [...scenario.roles],
    attendees: [...scenario.attendees],
    ...(scenario.npcs === undefined ? {} : { npcs: [...scenario.npcs] }),
  };
  const pickedAgenda = agendaPick ? resolveAgendaPick(fullScenario, agendaPick) : undefined;
  // The draft the setup screen starts from, rebuilt from the packaged scenario for every new meeting.
  const defaultSetup = defaultMeetingSetup(fullScenario);
  // Validate the whole saved meeting before any part of it is applied. A started meeting keeps the
  // sealed setup it ran with, even once it has ended, so its roles are the ones tasks may name.
  const savedMeeting = persistence?.saved;
  let restoredRoles: Scenario['roles'] | undefined;
  if (savedMeeting !== undefined) {
    // A malformed save must give the friendly message before its roles are derived from it.
    assertReadableSavedSetup(savedMeeting, fullScenario);
    const sealed =
      savedMeeting.phase === 'running' || savedMeeting.phase === 'ended' ? savedMeeting.sealed : undefined;
    restoredRoles = sealed === undefined ? undefined : setupScenarioRoles(fullScenario, sealed);
    // Tasks and talk time may name a role the owner added, so validate against both registries.
    const validationRoles =
      restoredRoles === undefined
        ? fullScenario.roles
        : [
            ...fullScenario.roles,
            ...restoredRoles.filter((role) => !fullScenario.roles.some((packRole) => packRole.id === role.id)),
          ];
    assertReadableSavedMeeting(savedMeeting, { ...fullScenario, roles: validationRoles });
    if (meetingCode.fixed) {
      if (savedMeeting.meetingCode !== meetingCode.value) {
        console.log('kaki persist: KAKI_MEETING_CODE replaced the saved meeting code');
      }
    } else {
      meetingCode.restore(savedMeeting.meetingCode);
    }
  }
  const restoredAgendaIndex =
    savedMeeting?.phase === 'running' ? savedMeeting.state.clock.agendaIndex : 0;
  const meeting = { id: savedMeeting?.meetingId ?? randomUUID() };
  /** A fresh copy of the pack; the active scenario is a value, never the pack object itself. */
  function packScenario(): Scenario {
    return {
      ...fullScenario,
      agenda: [...fullScenario.agenda],
      roles: [...fullScenario.roles],
      attendees: [...fullScenario.attendees],
      ...(fullScenario.npcs === undefined ? {} : { npcs: [...fullScenario.npcs] }),
    };
  }
  /** The agenda an untouched draft runs: the role's topics when there is an AI cast, else the pack order. */
  function shapedAgenda(seat: string | undefined): Scenario['agenda'] {
    const hasAi = (fullScenario.npcs ?? []).length > 0;
    if (seat !== undefined && hasAi && fullScenario.agenda.length > 1) {
      const maxAgendaItems = Number(process.env.KAKI_AGENDA_ITEMS) || 2;
      return pickedAgenda ?? shuffleAgendaForRole(fullScenario, seat, Math.random, maxAgendaItems);
    }
    return fullScenario.agenda;
  }
  interface MeetingScenarioOptions {
    agenda: readonly Scenario['agenda'][number][];
    /** Allow a title the pack does not have (a setup topic with no briefing). */
    allowPlain?: boolean;
    meetingTitle?: string;
    roles?: Scenario['roles'];
    npcs?: Scenario['npcs'];
    joinSeats?: string[];
  }

  /**
   * The one way a meeting Scenario is built: a fresh copy of the pack, shaped by the picked agenda
   * through the old normalization (minutes and owner applied, links pruned to surviving titles,
   * excludedPairs pruned). Every other meeting field is applied over that base.
   */
  function meetingScenario({
    agenda,
    allowPlain = false,
    meetingTitle,
    roles,
    npcs,
    joinSeats,
  }: MeetingScenarioOptions): Scenario {
    const next = packScenario();
    if (meetingTitle !== undefined) next.meetingTitle = meetingTitle;
    if (roles !== undefined) next.roles = roles;
    if (npcs !== undefined) next.npcs = npcs;
    if (joinSeats !== undefined) next.joinSeats = joinSeats;
    setMeetingAgenda(next, fullScenario, agenda, { allowPlain });
    return next;
  }

  /** The scenario a reset installs: pack title, roles and cast, with the agenda the next meeting runs. */
  function resetScenario({ seat, draftTouched: touched }: { seat?: string; draftTouched: boolean }): Scenario {
    return meetingScenario({ agenda: touched ? fullScenario.agenda : shapedAgenda(seat) });
  }
  // A lobby's untouched draft runs the shaped pick admission already chose; keep it across a restart.
  const savedLobbyAgenda =
    savedMeeting?.phase === 'lobby' && savedMeeting.lobbyAgenda !== undefined
      ? savedMeeting.lobbyAgenda.map((title) => {
          const item = fullScenario.agenda.find((candidate) => candidate.title === title);
          if (item === undefined) {
            throw new Error(
              `kaki session: the saved lobby agenda names "${title}", which this scenario no longer has`,
            );
          }
          return item;
        })
      : undefined;
  /** The scenario the server boots with: the restored meeting's sealed setup, else the pack's. */
  function bootScenario(): Scenario {
    const sealed =
      savedMeeting !== undefined && (savedMeeting.phase === 'running' || savedMeeting.phase === 'ended')
        ? savedMeeting.sealed
        : undefined;
    if (sealed === undefined) {
      return meetingScenario({ agenda: savedLobbyAgenda ?? fullScenario.agenda });
    }
    // A running meeting and an ended one still under review both keep exactly the plan they ran:
    // its own title, roles, attendees, agenda and cast. The pack only supplies content attached to
    // a matching topic or character, never a second set of roles, seats or people.
    return meetingScenarioFromSetup(fullScenario, sealed, {
      agendaOrder: sealed.agenda.map((item) => item.title),
    });
  }
  const initialScenario = bootScenario();
  const memory: MeetingMemoryEntry[] = [];
  const rejoin = createRejoinGuard({ graceMs: rejoinGraceMs ?? rejoinGraceMsFromEnv() });
  const reservations = createSeatReservations(admissionReservationMs);
  const admit = createAdmissionQueue();
  // The pack owns the reserved names for the whole meeting, whatever cast is active right now.
  const packNpcNames = (fullScenario.npcs ?? []).map((npc) => npc.attendee.toLowerCase());
  // The runner's listener is left in the room like the AI attendees when people are removed.
  const runnerOwnedNames = [...packNpcNames, KAKI_LISTENER_IDENTITY];
  let watchedRoom: string | undefined;
  // The plan the owner opened, frozen for non-owners so later draft edits never leak into it.
  let lobbySnapshot: Scenario | undefined;
  // The server owns the empty-room pause: a running meeting pauses once the room has read empty
  // across the poll debounce (EMPTY_ROOM_PAUSE_MS), and resumes the moment someone returns, but
  // only when the pause was the empty-room kind. A person's explicit Stop stays paused, and the
  // kind is saved so a restart keeps that distinction.
  function autoPauseForEmptyRoom(): void {
    if (meetingPause === undefined || session.phase() !== 'running') return;
    if (meetingPause.paused() !== false) return;
    meetingPause.pause('empty-room');
    console.log('kaki meeting: the room is empty; pausing until someone returns');
    publishRunnerState();
    persistence?.scheduleSave();
  }
  function autoResumeForReturn(): void {
    if (meetingPause === undefined || session.phase() !== 'running') return;
    if (meetingPause.kind() !== 'empty-room') return;
    meetingPause.resume();
    console.log('kaki meeting: someone returned; the meeting resumes');
    publishRunnerState();
    persistence?.scheduleSave();
  }
  const roomPoll = createRoomPoll({
    guard: rejoin,
    // Someone joined (even before Start), or the meeting is running: keep watching the room.
    hasMeeting: () =>
      session.reviewingEndedTeamMeeting() ||
      (!session.abandoned() && (session.holders().length > 0 || session.phase() === 'running')),
    roster: roomRoster,
    roomName: () => watchedRoom,
    isHuman: (name) => isHumanParticipant(name, packNpcNames),
    // Quick while a meeting runs so an empty room pauses and a returning person resumes promptly;
    // the slower interval is only for the grace window around a meeting that has not started.
    intervalMs: () =>
      roomPollIntervalMs(session.phase() === 'running', rejoinPollMs ?? REJOIN_POLL_MS),
    ...(emptyRoomPauseMs === undefined ? {} : { emptyPauseAfterMs: emptyRoomPauseMs }),
    onEmpty: autoPauseForEmptyRoom,
    onOccupied: autoResumeForReturn,
  });
  const watchRoom = (roomName: string): void => {
    watchedRoom = roomName;
    roomPoll.start();
  };
  const closeRejoin = (): void => {
    roomPoll.reset();
    roomPoll.close();
    rejoin.close();
  };
  /** The practice visitor's Start capability, read from the cookie the practice join issued. */
  function practicePrincipal(request: IncomingMessage): Principal | undefined {
    if (session.kind() !== 'practice') return undefined;
    const token = session.practiceStartToken();
    if (token === undefined) return undefined;
    if (session.practiceGeneration() !== session.generation()) return undefined;
    const given = cookieValue(request, PRACTICE_COOKIE);
    return given !== undefined && tokenMatches(given, token) ? { kind: 'practice' } : undefined;
  }
  let roomCleanupWarned = false;
  /**
   * A meeting handoff: close every practice authority and remove the people from the room that no
   * longer exists. Room identity alone already refuses an old token; this makes it immediate.
   */
  function onCredentialChange(ended: boolean, kind?: 'real' | 'practice'): void {
    // A practice END is the end of its agenda, not a handoff: the visitor must stay connected to
    // receive the closing cue, the frozen record and the minutes card, exactly as in open mode.
    // Its people are removed and its sockets revoked on the next reset or owner handoff.
    if (ended && kind === 'practice') return;
    hub.endPracticeSessions?.(MEETING_ENDED_MESSAGE);
    // Ending a real meeting keeps its room: the owner and participants stay to review and publish
    // the minutes. Everything else here is a handoff that replaces the room, so its people and
    // practice authority go with it.
    if (ended && kind === 'real') return;
    const roomName = watchedRoom ?? demoRoomName(session.active(), meeting.id);
    void removeRoomHumans(roomName, runnerOwnedNames).catch((error: unknown) => {
      if (roomCleanupWarned) return;
      roomCleanupWarned = true;
      console.warn(`kaki livekit: could not remove people from the old room ${roomName}`, error);
    });
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response, { hub, tasks, memory, fullScenario, pickedAgenda, devRoutes, auth, serviceToken, routes, calendar, calendarFetch, actionTools, roomRoster, meetingCode, meetingCodeAttempts, rejoin, meeting, session, startMeeting, reservations, admit, watchRoom, practicePrincipal, meetingElapsedSeconds, meetingAgendaIndex, meetingPaused,     runnerStateChanged: () => publishRunnerState(), seating, visibleScenario, publicScenario, captureLobbySnapshot, shapeLobbyFor, setupLocked, scheduleSave: () => persistence?.scheduleSave(), writeHumanLine: (input) => writeHumanLine(input) });
  });
  const serviceTokenConfigured = serviceToken !== undefined && serviceToken !== '';
  /** The roles an AI profile currently voices; Start narrows this to the sealed AI seats. */
  const aiVoiceRoles = (): Set<string> => {
    const active = session.active();
    const profiles = new Set((active.npcs ?? []).map((npc) => npc.attendee));
    return new Set(
      active.attendees.filter((attendee) => profiles.has(attendee.name)).map((attendee) => attendee.role),
    );
  };
  const isHumanSeat = (role: string): boolean =>
    session.holders().some((holder) => holder.seat === role);
  const runnerMayUseAudience = (audience: ClientAudience): boolean => {
    const role = audienceRole(audience);
    return role !== undefined && aiVoiceRoles().has(role) && !isHumanSeat(role);
  };
  /** One WebSocket authorization path: the runner token first, then the same session principal as HTTP. */
  const authorizeUpgrade = async (
    request: IncomingMessage,
    audience: ClientAudience,
  ): Promise<Awaited<ReturnType<Auth['authorize']>>> => {
    const runnerRequest =
      serviceTokenConfigured && tokenMatches(bearerToken(request), serviceToken ?? '');
    // A configured service token always gates the service channel, even when user sign-in is off.
    if (audience.kind === 'service') {
      if (serviceTokenConfigured) {
        return runnerRequest
          ? { ok: true, runner: true, principal: { kind: 'service' } }
          : { ok: false, message: 'Service sign-in required' };
      }
      // No credential configured: only a direct local peer may use the service channel.
      if (auth === undefined) return isLoopbackAddress(request.socket.remoteAddress)
        ? { ok: true, principal: { kind: 'service' } }
        : { ok: false, message: 'Service sign-in required' };
      return auth.authorize(request, audience);
    }
    if (runnerRequest) {
      if (audience.kind === 'screen') {
        return { ok: true, runner: true, principal: { kind: 'service' } };
      }
      if (audience.kind === 'lifecycle') {
        return { ok: false, message: 'The AI runner does not follow the lifecycle feed' };
      }
      if (runnerMayUseAudience(audience)) {
        return { ok: true, runner: true, principal: { kind: 'service' } };
      }
      return { ok: false, message: 'The AI runner may not act as a human seat' };
    }
    if (auth === undefined) {
      // With sign-in off there is no owner to tell apart from the one practice visitor. Tag every
      // socket of a practice meeting as practice, so it is read-only on the screen and dies with
      // the meeting instead of carrying into the real one that replaces it.
      if (session.kind() === 'practice') {
        const seat = session.practiceSeat();
        return {
          ok: true,
          principal: { kind: 'practice' },
          ...(seat === undefined ? {} : { seat }),
        };
      }
      return { ok: true };
    }
    // A practice visitor follows only their own practice meeting: its lifecycle, its screen and
    // the seat they took. The capability dies with the meeting, so it can never reach another one.
    const practice = practicePrincipal(request);
    if (practice !== undefined) {
      const seat = session.practiceSeat();
      const role = audienceRole(audience);
      if (audience.kind === 'lifecycle' || audience.kind === 'screen' || (seat !== undefined && role === seat)) {
        return {
          ok: true,
          principal: practice,
          ...(seat === undefined ? {} : { seat }),
        };
      }
      return { ok: false, message: 'Practice access belongs to its practice meeting only' };
    }
    return auth.authorize(request, audience);
  };
  const hub = createHub(server, () => session.active(), {
    authorize: authorizeUpgrade,
    closeUnknownRoleAfterUpgrade: auth === undefined && !serviceTokenConfigured,
    isHumanSeat,
  });
  auth?.bindMeetingIdentity(() => meeting.id);
  auth?.bindOfferedSeats(() => joinSeatRoles(visibleScenario()).map((role) => role.id));
  auth?.bindJoinGuard({
    meetingKind: () => session.kind(),
    practiceSeat: () => session.practiceSeat(),
    hasPracticeCapability: (request) => practicePrincipal(request) !== undefined,
    admit,
  });
  auth?.onSessionEnded((sessionTokenHash) => hub.endSession?.(sessionTokenHash));
  const tasks = createTaskStore({ hub, scenario: () => session.active() });
  hub.onCommand(tasks.handleCommand);
  // The ended team meeting is the owner's until the minutes are published or dismissed. Any other
  // task moving says nothing about that review, so leave the protection alone.
  tasks.onChange((task) => {
    if (task.purpose !== 'meeting_minutes') return;
    if (
      task.status === 'COMPLETED' ||
      task.status === 'SYNCED' ||
      task.status === 'DISMISSED' ||
      task.status === 'SUPERSEDED'
    ) {
      session.finishReview();
    }
  });

  // The AI runner must confirm it prepared the meeting before Start succeeds. Without that
  // acknowledgement a guest would sit on "Starting..." forever while nobody speaks.
  interface RunnerWaiter {
    meetingId: string;
    resolve(): void;
    reject(error: Error): void;
  }
  const runnerWaiters = new Map<string, RunnerWaiter>();
  /** A Start attempt whose acknowledgement must still match this exact meeting. */
  interface ActiveStart {
    attempt: string;
    meetingId: string;
    promise: Promise<StartOutcome>;
  }
  let starting: ActiveStart | undefined;
  /** Acknowledgements already refused, so a late one is logged once rather than on every retry. */
  const ignoredAcks = new Set<string>();

  function logIgnoredAck(key: string, reason: string): void {
    if (ignoredAcks.has(key)) return;
    ignoredAcks.add(key);
    if (ignoredAcks.size > 100) ignoredAcks.clear();
    console.warn(`kaki server: ignored a runner acknowledgement (${reason})`);
  }

  hub.onServiceMessage?.((message) => {
    if (message.attempt !== message.requestId) {
      logIgnoredAck(message.requestId, `attempt ${message.attempt} does not match request ${message.requestId}`);
      return;
    }
    const waiter = runnerWaiters.get(message.requestId);
    if (waiter === undefined) {
      logIgnoredAck(message.requestId, `no Start is waiting for ${message.requestId}`);
      return;
    }
    if (waiter.meetingId !== message.meetingId || message.meetingId !== meeting.id) {
      runnerWaiters.delete(message.requestId);
      logIgnoredAck(message.requestId, `it names meeting ${message.meetingId}, not the current ${meeting.id}`);
      waiter.reject(new Error('the meeting changed while it was starting'));
      return;
    }
    runnerWaiters.delete(message.requestId);
    if (message.kind === 'ready') waiter.resolve();
    else waiter.reject(new Error(message.reason ?? 'the AI attendees could not prepare the meeting'));
  });

  function waitForRunner(attempt: string, meetingId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        runnerWaiters.delete(attempt);
        reject(new Error('no acknowledgement from the AI attendees'));
      }, Math.max(1, startAckTimeoutMs));
      timer.unref?.();
      runnerWaiters.set(attempt, {
        meetingId,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /** Abandon every Start in flight because its meeting is gone; a late acknowledgement cannot revive it. */
  function cancelPendingStart(reason: string): void {
    for (const [attempt, waiter] of [...runnerWaiters]) {
      runnerWaiters.delete(attempt);
      waiter.reject(new Error(reason));
    }
    starting = undefined;
  }

  /** Move to a new meeting identity; a reset carries the id every client and runner must adopt. */
  function rotateIdentity({ rotateCode = true }: { rotateCode?: boolean } = {}): string {
    const previousMeetingId = meeting.id;
    if (rotateCode) meetingCode.rotate();
    // A phone session belongs to one meeting generation: close its sockets and free its seats.
    // Host screen and lifecycle feeds stay; the runner's own sockets stay.
    if (auth !== undefined || !meetingCode.fixed) hub.endRoleSessions?.(MEETING_ENDED_MESSAGE);
    void auth?.releaseMeeting(previousMeetingId);
    cancelPendingStart('the meeting was reset while it was starting');
    // A new meeting identity means the opened room is gone; its public lobby snapshot must not
    // carry into the next one. The first arrival's reset keeps the identity, so it keeps the plan.
    lobbySnapshot = undefined;
    meeting.id = randomUUID();
    return meeting.id;
  }

  /** The holder whose seat is a person seat, taking the first person seat in setup order. */
  function holderPersonSeat(): string | undefined {
    const setup = session.sealed() ?? session.draft();
    const holders = session.holders();
    for (const roleId of setupPersonSeatRoles(setup)) {
      const key = roleId.trim().toLowerCase();
      if (holders.some((holder) => holder.seat.trim().toLowerCase() === key)) return roleId;
    }
    // An admitted holder can sit in a seat the untouched draft still marks AI; that person is the
    // human the next meeting is shaped for.
    return holders[0]?.seat;
  }

  const session = createMeetingSession({
    hub,
    memory,
    defaultSetup,
    resetScenario,
    restoreActive: () => bootScenario(),
    saved: savedMeeting,
    initialScenario,
    meetingId: () => meeting.id,
    meetingCode: () => meetingCode.value,
    rotateIdentity,
    defaultSeat: holderPersonSeat,
    clearGrace: () => rejoin.reset(),
    onCredentialChange,
    persistence,
  });
  // The task store belongs to the meeting, so a reset forgets its cards too. The session clears
  // every retained key (including 'task:') after these hooks run.
  session.onReset(() => {
    tasks.reset();
    roomPoll.reset();
    reservations.clear();
  });

  /** Speech lines are bounded separately: a long recognised turn is still one line. */
  const HUMAN_LINE_MAX_SPEECH_CHARS = 2_000;
  /** Per seat, at most this many lines in the window; a retry is deduped before it is counted. */
  const HUMAN_LINE_RATE_LIMIT = 5;
  const HUMAN_LINE_RATE_WINDOW_MS = 1_000;
  /** How many recent line ids one seat is remembered by, so a retry cannot write twice. */
  const HUMAN_LINE_MEMORY_PER_SEAT = 200;

  /**
   * The one writer for a person's finalized speech or typed line. The speaker is always resolved
   * from the socket's current seat holder and the setup, never from the client payload. The line
   * is published as an ordinary transcript chunk, so the screen, notetaker and minutes all see it.
   */
  interface HumanLineMemory {
    ids: Set<string>;
    order: string[];
  }
  const humanLineIds = new Map<string, HumanLineMemory>();
  const humanLineTimes = new Map<string, number[]>();
  hub.subscribe((event) => {
    if (event.type !== 'MEETING_RESET') return;
    humanLineIds.clear();
    humanLineTimes.clear();
  });

  function seatKey(seat: string): string {
    return seat.trim().toLowerCase();
  }

  function writeHumanLine({
    seat,
    text,
    source,
    clientLineId,
    meetingId,
    participantIdentity,
    speechStartedAt,
    speechEndedAt,
    overlap,
  }: {
    seat: string;
    text: string;
    source: 'speech' | 'typed';
    clientLineId: string;
    meetingId?: string;
    participantIdentity?: string;
    speechStartedAt?: string;
    speechEndedAt?: string;
    overlap?: boolean;
  }): void {
    if (meetingId !== undefined && meetingId !== meeting.id) {
      throw new CommandError('That line belongs to a different meeting');
    }
    const phase = session.phase();
    if (phase !== 'running' && phase !== 'starting') {
      throw new CommandError('The meeting is not running');
    }
    const holders = session.holders();
    const wantedSeat = seatKey(seat);
    const holder =
      participantIdentity === undefined
        ? holders.find((candidate) => seatKey(candidate.seat) === wantedSeat)
        : holders.find(
            (candidate) => candidate.name.trim().toLowerCase() === participantIdentity.trim().toLowerCase(),
          );
    if (holder === undefined) {
      throw new CommandError(
        participantIdentity === undefined
          ? 'Only a person seated in this meeting can add a line'
          : 'That person is no longer seated in this meeting',
      );
    }
    if (seatKey(holder.seat) !== wantedSeat) {
      throw new CommandError('That person no longer holds that seat');
    }
    const cleaned = text.trim();
    if (cleaned === '') throw new CommandError('A line needs some words');
    const cap = source === 'typed' ? MAX_TYPED_LENGTH : HUMAN_LINE_MAX_SPEECH_CHARS;
    if (cleaned.length > cap) {
      throw new CommandError(`That line is too long; keep it under ${cap} characters`);
    }
    const key = seatKey(holder.seat);
    const seen = humanLineIds.get(key);
    if (seen?.ids.has(clientLineId)) return;
    const now = Date.now();
    const times = (humanLineTimes.get(key) ?? []).filter((at) => now - at < HUMAN_LINE_RATE_WINDOW_MS);
    if (times.length >= HUMAN_LINE_RATE_LIMIT) {
      throw new CommandError('Too many lines at once; wait a moment and try again');
    }
    // The admitted person is the speaker; the setup seat is only the role they took.
    const speaker = holder.displayName?.trim() || holder.name;
    if (speaker.trim() === '') {
      throw new CommandError('That person has no name in this meeting');
    }
    times.push(now);
    humanLineTimes.set(key, times);
    const memory = seen ?? { ids: new Set<string>(), order: [] };
    memory.ids.add(clientLineId);
    memory.order.push(clientLineId);
    if (memory.order.length > HUMAN_LINE_MEMORY_PER_SEAT) {
      const oldest = memory.order.shift();
      if (oldest !== undefined) memory.ids.delete(oldest);
    }
    humanLineIds.set(key, memory);
    hub.publish({
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'all' },
      payload: {
        speaker,
        text: cleaned,
        timestamp: speechStartedAt ?? new Date().toISOString(),
        speakerRole: holder.seat,
        ...(speechStartedAt === undefined ? {} : { speechStartedAt }),
        ...(speechEndedAt === undefined ? {} : { speechEndedAt }),
        ...(overlap === true ? { overlap: true } : {}),
      },
    });
  }

  /** The seat a socket writes as: its own role, or the host's chair when a person hosts the screen. */
  function seatForSender(sender: ClientAudience): string | undefined {
    const role = audienceRole(sender);
    if (role !== undefined) return role;
    if (sender.kind !== 'screen') return undefined;
    if (!hostIsHumanFromSession(session, session.active())) return undefined;
    return hostIdentityOf(session.active()).seat;
  }

  // Leave ends the meeting for the last person out: a practice visitor alone with the AI, or the
  // last person of a team meeting. Anyone else still in the room (or just admitted and on the way
  // in) keeps it running. A roster outage ends nothing: the empty-room grace still applies.
  hub.onCommand(async (command, sender) => {
    if (command.type !== 'LEAVE_MEETING') return;
    const seat = audienceRole(sender);
    if (seat === undefined) throw new CommandError('Only a person seated in this meeting can leave it');
    const key = seatKey(seat);
    if (!session.holders().some((holder) => seatKey(holder.seat) === key)) {
      throw new CommandError('Only a person seated in this meeting can leave it');
    }
    if (session.phase() !== 'running') return;
    const forMeetingId = meeting.id;
    const forGeneration = session.generation();
    const roster = await roomRoster(watchedRoom ?? demoRoomName(session.active(), meeting.id));
    if (roster === undefined) return;
    if (meeting.id !== forMeetingId || session.generation() !== forGeneration || session.phase() !== 'running') return;
    const others = roster.filter(
      (person) =>
        isHumanParticipant(person.name, packNpcNames) && (person.role === undefined || seatKey(person.role) !== key),
    );
    if (others.length > 0) return;
    const arriving = reservations
      .active(roster.map((person) => person.name))
      .filter((reservation) => seatKey(reservation.seatId) !== key);
    if (arriving.length > 0) return;
    console.log(`kaki meeting: ${seat} left and nobody else is in the room; ending the meeting`);
    // Not awaited: ending runs through the same handlers, and this command is still being handled.
    void hub.runServerCommand({ type: 'END_MEETING' }).catch((error: unknown) => {
      console.error('kaki meeting: could not end the meeting after the last person left', error);
    });
  });

  hub.onCommand((command, sender) => {
    if (command.type !== 'HUMAN_LINE') return;
    const seat = seatForSender(sender);
    if (seat === undefined) throw new CommandError('Only a person seated in this meeting can add a line');
    // A held line names the seat it was typed in. A socket that now writes as another seat must not
    // deliver it as that other person.
    if (command.seat !== undefined && seatKey(command.seat) !== seatKey(seat)) {
      throw new CommandError('That line belongs to a different seat');
    }
    writeHumanLine({
      seat,
      text: command.text,
      source: command.source,
      clientLineId: command.clientLineId,
      ...(command.meetingId === undefined ? {} : { meetingId: command.meetingId }),
    });
  });

  // The AI runner reads exactly this snapshot, through the service-only endpoint and RUNNER_STATE.
  // Its version moves only when a field a runner can see changes, so a reconnect can fence old reads.
  // The version is a server-incarnation fence: `epoch` is made once for this process, ordered by the
  // boot time and identified by a random id, and `seq` only increases across every meeting. A
  // restarted server therefore starts a newer epoch instead of having to continue a persisted
  // revision it may never have managed to save.
  const runnerEpoch = { startedAt: Date.now(), id: randomUUID() };
  let runnerStateSeq = 0;
  let runnerStateSignature: string | undefined;
  function publishRunnerState(): RunnerMeetingSnapshot {
    const state = buildRunnerMeetingSnapshot({
      meetingId: meeting.id,
      session,
      fullScenario,
      agendaIndex: meetingAgendaIndex?.(),
      paused: meetingPaused?.(),
      pauseKind: meetingPause?.kind(),
    });
    const signature = JSON.stringify(state);
    let version = { epoch: runnerEpoch, seq: runnerStateSeq };
    if (signature !== runnerStateSignature) {
      runnerStateSignature = signature;
      runnerStateSeq += 1;
      version = { epoch: runnerEpoch, seq: runnerStateSeq };
      hub.publish(
        { type: 'RUNNER_STATE', audience: { kind: 'service' }, payload: { ...state, version } },
        { retainKey: 'runner:state' },
      );
    }
    return { ...state, version };
  }
  // Start, agenda moves and pause/resume all surface as these events; a seat change is published
  // by whoever changes the roster, because it has no event of its own.
  hub.subscribe((event) => {
    if (event.type === 'MEETING_RESET') {
      // A reset always yields a newer snapshot, even when it keeps the meeting id and every visible
      // field (the runner cleared its copy and must be able to adopt the republished version).
      runnerStateSignature = undefined;
      publishRunnerState();
      return;
    }
    if (event.type === 'MEETING_STARTED' || event.type === 'MEETING_RECORD_UPDATED') {
      publishRunnerState();
    }
  });
  // Server-side recognition lives in the runner, so the screen must know when that service is gone.
  // Browser recognition needs no runner, and then this is always on.
  const servicePresence = (): { connected: boolean; serverSpeech: boolean } =>
    hub.servicePresence?.() ?? { connected: false, serverSpeech: false };
  function publishSpeechRecording(): void {
    if (session.phase() !== 'running') return;
    const recording = speechRecognition === 'browser' || servicePresence().serverSpeech;
    hub.publish(
      { type: 'SPEECH_RECORDING', audience: { kind: 'all' }, payload: { recording } },
      { retainKey: 'speech:recording' },
    );
  }
  hub.onServicePresence?.(() => publishSpeechRecording());
  hub.subscribe((event) => {
    if (event.type === 'MEETING_STARTED') publishSpeechRecording();
  });
  // The grace ending is not proof the room is empty: a still-connected holder must survive. Only a
  // roster read that succeeds, shows no person and no live reservation may prune and abandon.
  let rosterOutageLogged = false;
  function checkRoomBeforePruning(): void {
    // The read can arrive after the owner reset and started a replacement meeting. It only applies
    // to the grace window it was asked for, never to the next meeting's holders.
    const forMeetingId = meeting.id;
    const forGeneration = session.generation();
    const forGraceEpoch = rejoin.epoch();
    const roomName = watchedRoom ?? demoRoomName(session.active(), meeting.id);
    void roomRoster(roomName)
      .then((roster) => {
        if (
          meeting.id !== forMeetingId ||
          session.generation() !== forGeneration ||
          rejoin.epoch() !== forGraceEpoch
        ) {
          return;
        }
        if (roster === undefined) {
          if (!rosterOutageLogged) {
            console.warn(
              'kaki rejoin: could not check who is in the room; keeping the meeting and its holders',
            );
            rosterOutageLogged = true;
          }
          return;
        }
        rosterOutageLogged = false;
        const humans = roster.filter((person) => isHumanParticipant(person.name, packNpcNames));
        if (humans.length > 0) {
          // The poll lagged: someone is still there, so keep the meeting open.
          rejoin.occupied();
          return;
        }
        // A token was just issued but LiveKit has not shown the person yet: keep their seat.
        if (reservations.active(roster.map((person) => person.name)).length > 0) return;
        session.pruneHolders();
        publishRunnerState();
        // An ended meeting that is verified empty has nobody left to review the minutes.
        if (session.phase() === 'ended') session.finishReview();
        if (session.phase() === 'running') session.abandon();
        // A verified empty real meeting is released, so it can never block practice forever. A
        // running one keeps its abandonment mark for the restart path; a lobby is rotated clean.
        if (session.kind() === 'real') {
          if (session.phase() === 'running') session.releaseRealMeeting();
          else session.reset();
        }
        persistence?.scheduleSave();
      })
      .catch((error: unknown) => {
        if (
          meeting.id !== forMeetingId ||
          session.generation() !== forGeneration ||
          rejoin.epoch() !== forGraceEpoch
        ) {
          return;
        }
        if (rosterOutageLogged) return;
        rosterOutageLogged = true;
        console.warn(
          'kaki rejoin: could not check who is in the room; keeping the meeting and its holders',
          error,
        );
      });
  }
  rejoin.onGraceExpired(checkRoomBeforePruning);
  // A restored running meeting starts its grace now and watches its own room immediately, so a
  // connected holder is never pruned merely because no new token request arrived.
  if (savedMeeting?.phase === 'running' && !session.abandoned()) {
    watchedRoom = demoRoomName(session.active(), meeting.id);
    rejoin.beginGrace();
    roomPoll.start();
  }
  // A restored ended team meeting is still under review: watch its room now so a verified empty
  // room expires the review and releases the server for practice, exactly as a live END would.
  if (session.reviewingEndedTeamMeeting()) {
    watchedRoom = demoRoomName(session.active(), meeting.id);
    rejoin.beginGrace();
    roomPoll.start();
  }

  /** Setup writes are refused from the moment Start begins until it commits or fails. */
  function setupLocked(): 'starting' | 'started' | undefined {
    const phase = session.phase();
    // A running meeting everyone left, which the empty-room grace released, is over: the owner
    // edits the next plan and opens a fresh room (the open consumes it), instead of being locked out.
    if (phase === 'running') return session.abandoned() && session.kind() === undefined ? undefined : 'started';
    if (phase === 'starting') return 'starting';
    return undefined;
  }

  /** The roles the setup offers as person seats, including a role the owner added in setup. */
  function personSeatRoles(setup: MeetingSetup): string[] {
    return setupPersonSeatRoles(setup);
  }

  /** How many real people the setup can seat: one per offered person seat. */
  function personSeatCapacity(setup: MeetingSetup): number {
    return personSeatRoles(setup).length;
  }

  /** The scenario an owner-edited setup describes, with its AI seats treated as AI-only. */
  function scenarioFromSetup(setup: MeetingSetup): Scenario {
    return meetingScenarioFromSetup(fullScenario, setup);
  }

  /**
   * The scenario people see, plus the one admission resolves seats against. A returning seat holder
   * inside the grace of a running meeting is judged against its sealed setup. Every other arrival
   * starts the next meeting: an untouched draft stays open, an owner-edited one admits its person
   * seats, and a setup a Start consumed is already done with.
   */
  function seating(
    returning = false,
    roomEmpty?: boolean,
  ): { scenario: Scenario; admissionScenario: Scenario; setup?: MeetingSetup; admissionCap?: number } {
    // A practice meeting always follows the demo pack; the owner's draft is not its plan.
    if (session.kind() === 'practice') {
      return { scenario: session.active(), admissionScenario: fullScenario };
    }
    const sealed = session.sealed();
    const active = session.active();
    const phase = session.phase();
    // The sealed setup governs only a running meeting this arrival joins: while people are still
    // there, or when the person coming back is one of its seat holders.
    const empty = roomEmpty ?? rejoin.isEmpty();
    const joiningSealed =
      sealed !== undefined && phase === 'running' && (returning || !empty);
    if (joiningSealed) {
      const joinSeats = personSeatRoles(sealed);
      return {
        scenario: { ...active, joinSeats },
        admissionScenario: { ...active, joinSeats },
        setup: sealed,
        admissionCap: personSeatCapacity(sealed),
      };
    }
    // A setup a Start consumed is discarded when that meeting resets; until then it must not narrow
    // the next arrival's seats. The next meeting follows the pack, not the sealed cast still live —
    // unless the owner has edited the draft since that seal, which is exactly the next meeting's setup.
    // A seal kept at boot from an already-ended meeting is history, not a live meeting's cast.
    const consumed = sealed !== undefined && phase !== 'lobby' && !session.draftEditedSinceSeal();
    const nextTouched = consumed ? false : session.draftTouched();
    if (!nextTouched) {
      return consumed
        ? { scenario: fullScenario, admissionScenario: fullScenario }
        : { scenario: active, admissionScenario: active };
    }
    const setup = session.draft();
    const joinSeats = personSeatRoles(setup);
    // The lobby must show exactly the meeting Start will seal, so build it with the same builder
    // admission uses. This keeps a pack-free draft's own organisation, people and story instead
    // of the demo pack's.
    const derived = scenarioFromSetup(setup);
    // A kept seal (an ended meeting) and a draft with no agenda yet still own the live view: its
    // cast, story and agenda stay while the next draft supplies the title, roles and seats
    // admission will use. Without an agenda the draft cannot stand alone.
    const scenario: Scenario =
      sealed !== undefined || setup.agenda.length === 0
        ? {
            ...active,
            meetingTitle: setup.title.trim() === '' ? active.meetingTitle : setup.title,
            roles: derived.roles,
            agenda: active.agenda,
            joinSeats,
          }
        : {
            ...derived,
            // A blank draft has not named the meeting yet: keep the live title.
            ...(setup.title.trim() === '' ? { meetingTitle: active.meetingTitle } : {}),
          };
    return {
      scenario,
      admissionScenario: derived,
      setup,
      admissionCap: personSeatCapacity(setup),
    };
  }

  /**
   * The scenario the join form is shown right now: the sealed meeting once Start runs, the draft
   * setup in the lobby. Phone joins offer exactly these seats.
   */
  function visibleScenario(service = false): Scenario {
    const phase = session.phase();
    if (phase === 'starting') {
      return service ? session.candidate() ?? session.active() : session.active();
    }
    return phase === 'running' ? session.active() : seating().scenario;
  }

  /** What the public may see of the plan: the pack until the owner opens a room, then that snapshot. */
  function publicScenario(): Scenario {
    return lobbySnapshot ?? fullScenario;
  }

  /** The owner opened the room: freeze exactly the plan they opened as the public lobby view. */
  function captureLobbySnapshot(): void {
    lobbySnapshot = seating().scenario;
  }

  /**
   * The first person into an opened lobby picks the agenda for their seat, what the reset they
   * replaced used to shape. An owner-edited draft is never overwritten: the pick is for the
   * untouched pack plan only.
   */
  function shapeLobbyFor(seat: string): void {
    if (session.draftTouched()) return;
    session.shapeLobby(resetScenario({ seat, draftTouched: false }));
  }

  /** True when the sealed meeting carries no demo-pack content, so its facts must stay out of it. */
  function packFree(): boolean {
    const setup = session.sealed();
    return setup !== undefined && isPackFreeMeeting(setup, fullScenario);
  }

  /**
   * The setup an untouched draft seals: the meeting admission already shaped (its active agenda and
   * the admitted person's seat), not the full pack. The owner's pack title, roles and pace still apply.
   */
  function untouchedSetup(humanSeatOverride?: string): MeetingSetup {
    const agenda: MeetingSetup['agenda'] = session.active().agenda.map((item, index) => ({
      id: `agenda-${index + 1}`,
      title: item.title,
      minutes: item.minutes,
      ownerRoleId: item.ownerRole,
    }));
    const humanSeat = humanSeatOverride ?? holderPersonSeat();
    if (humanSeat === undefined || (fullScenario.npcs ?? []).length === 0) {
      return { ...defaultSetup, agenda };
    }
    const npcByAttendee = new Map((fullScenario.npcs ?? []).map((npc) => [npc.attendee, npc]));
    const seats = defaultSetup.seats.map((seat) => {
      const attendee = fullScenario.attendees.find((candidate) => candidate.name === seat.displayName);
      if (attendee?.role === humanSeat) {
        return { displayName: seat.displayName, roleId: seat.roleId, kind: 'person' as const };
      }
      const npc = npcByAttendee.get(seat.displayName);
      return npc === undefined
        ? seat
        : { displayName: seat.displayName, roleId: seat.roleId, kind: 'ai' as const, npcProfileId: npc.attendee };
    });
    return { ...defaultSetup, agenda, seats };
  }

  /** Run the runner acknowledgement and commit, after the admission queue has released. */
  function runStart({
    attempt,
    meetingId,
    generation,
    activeAi,
  }: {
    attempt: string;
    meetingId: string;
    generation: number;
    activeAi: boolean;
  }): Promise<StartOutcome> {
    /** Drop the candidate and leave the active scenario untouched; a reset has already replaced it. */
    const failed = (outcome: StartOutcome, reason: string): StartOutcome => {
      if (session.phase() === 'starting' && session.generation() === generation) {
        session.abortStart(reason);
      }
      persistence?.scheduleSave();
      return outcome;
    };
    const resetDuringStart = (): StartOutcome => ({
      status: 503,
      body: {
        error: 'The meeting was reset while it was starting. Press Start again for the new meeting.',
        retryable: true,
      },
    });
    const outcome = (async (): Promise<StartOutcome> => {
      const startedAt = new Date().toISOString();
      try {
        // A reset can land between beginStart and this continuation; never ask the runner for a dead meeting.
        if (meeting.id !== meetingId || session.generation() !== generation || session.phase() !== 'starting') {
          return resetDuringStart();
        }
        if (activeAi) {
          if (
            hub.requestStart?.({
              requestId: attempt,
              attempt,
              meetingId,
              startedAt,
              agendaIndex: 0,
              resumed: false,
            }) !== true
          ) {
            return failed(
              {
                status: 503,
                body: {
                  error:
                    'The AI attendees are not connected, so the meeting cannot open yet. Start the runner with npm run npc, then try again.',
                  retryable: true,
                },
              },
              'the AI runner is not connected',
            );
          }
          try {
            await waitForRunner(attempt, meetingId);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            // A reset cancels the waiter on purpose: say that, instead of blaming the runner.
            if (meeting.id !== meetingId || session.generation() !== generation || session.phase() !== 'starting') {
              console.warn(`[start] meeting ${meetingId} was reset while it was starting: ${reason}`);
              return resetDuringStart();
            }
            console.warn(`[start] the AI attendees did not prepare the meeting: ${reason}`);
            return failed(
              {
                status: 503,
                body: {
                  error: 'The AI attendees did not open the meeting. Check that npm run npc is running, then try again.',
                  retryable: true,
                },
              },
              reason,
            );
          }
        }
        // A reset during preparation must never let this old attempt start the replacement meeting.
        if (meeting.id !== meetingId || session.generation() !== generation || session.phase() !== 'starting') {
          console.warn(`[start] refused to start meeting ${meetingId}: the meeting changed while it was starting`);
          return resetDuringStart();
        }
        // Start commits here: the candidate becomes the active scenario and the draft becomes the seal.
        session.commitStart(startedAt);
        hub.publish(
          {
            type: 'MEETING_STARTED',
            audience: { kind: 'all' },
            payload: { meetingId, startedAt, agendaIndex: 0, resumed: false },
          },
          { retainKey: 'meeting:started' },
        );
        console.log(`[start] meeting ${meetingId} has started`);
        return { status: 200, body: { started: true, meetingId } };
      } catch (error) {
        console.error('[start] the meeting could not be started', error);
        if (meeting.id === meetingId && session.generation() === generation && session.phase() === 'starting') {
          session.abortStart('the meeting could not be started');
          persistence?.scheduleSave();
          return {
            status: 500,
            body: { error: 'The meeting could not be started. Try again.', retryable: true },
          };
        }
        throw error;
      }
    })();
    const pending: ActiveStart = { attempt, meetingId, promise: undefined! };
    pending.promise = outcome.finally(() => {
      if (starting === pending) starting = undefined;
    });
    starting = pending;
    return pending.promise;
  }

  function startTimeoutOutcome(): StartOutcome {
    return {
      status: 503,
      body: {
        error: 'The AI attendees did not open the meeting. Check that npm run npc is running, then try again.',
        retryable: true,
      },
    };
  }

  function startMeeting(practiceRequest = false): Promise<StartOutcome> {
    // The meeting this Start was requested for: a reset while it waits for the admission queue must
    // refuse it rather than let it start the replacement meeting.
    const requestedMeetingId = meeting.id;
    const requestedGeneration = session.generation();
    // The one Start timeout covers the queue wait as well as the runner acknowledgement. A Start
    // still waiting when it expires never runs later.
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<StartOutcome>((resolve) => {
      timeout = setTimeout(() => {
        cancelled = true;
        if (
          meeting.id === requestedMeetingId &&
          session.generation() === requestedGeneration &&
          session.phase() === 'starting'
        ) {
          session.abortStart('the meeting did not start in time');
          persistence?.scheduleSave();
          cancelPendingStart('the meeting did not start in time');
        }
        resolve(startTimeoutOutcome());
      }, Math.max(1, startAckTimeoutMs));
      timeout.unref?.();
    });
    // The phase flip shares the admission queue with joins: a Start waits for an admission already in
    // flight, and an admission waits for beginStart. Only that atomic step is serialized; the runner
    // acknowledgement runs after the queue is released so joins are not held for its whole window.
    const queued = admit(
      async (): Promise<StartOutcome | (() => Promise<StartOutcome>)> => {
        if (cancelled) return startTimeoutOutcome();
        // A practice Start is valid only for the exact practice meeting it was granted for. The
        // capability may have been revoked, or the owner may have opened a real meeting, while it
        // waited for the queue.
        if (
          practiceRequest &&
          (session.kind() !== 'practice' || session.practiceGeneration() !== requestedGeneration)
        ) {
          return {
            status: 403,
            body: { error: 'Practice access has ended with its practice meeting.' },
          };
        }
        if (meeting.id !== requestedMeetingId || session.generation() !== requestedGeneration) {
          return {
            status: 409,
            body: { error: 'The meeting was reset before it could start; press Start again.' },
          };
        }
        const phase = session.phase();
        if (phase === 'running') {
          return { status: 200, body: { started: true, alreadyStarted: true } };
        }
        if (phase === 'starting') {
          return {
            status: 409,
            body: { error: 'This meeting is already starting; give it a moment.', retryable: true },
          };
        }
        if (phase === 'ended') {
          return {
            status: 409,
            body: { error: 'This meeting has ended; press New meeting to start the next one.' },
          };
        }
        // Re-validate the whole draft before anything is applied or the runner is asked, so a bad edit
        // made outside the setup screen fails Start loudly and leaves the meeting untouched. A
        // practice meeting never reads the owner's draft: it always runs the demo pack.
        let sealed: MeetingSetup | undefined;
        if (session.kind() !== 'practice') {
          const parsed = parseMeetingSetup(session.draft(), {
            npcProfileIds: demoPackNpcProfileIds(fullScenario),
          });
          if (!parsed.ok) {
            return {
              status: 422,
              body: {
                error: 'The meeting setup is not valid, so the meeting was not started. Fix the setup and try again.',
                errors: parsed.errors,
              },
            };
          }
          // An untouched draft follows the live meeting; an owner-edited one is applied exactly as written.
          if (session.draftTouched()) sealed = parsed.value;
        }
        // Start needs someone in the meeting: an owner cannot open an empty room.
        if (session.holders().length === 0) {
          return { status: 409, body: { error: 'Join the meeting before pressing Start.' } };
        }
        if (sealed === undefined) {
          sealed = untouchedSetup(
            session.kind() === 'practice' ? session.holders()[0]?.seat : undefined,
          );
        }
        // Everyone already seated must have a person seat in the setup about to become the meeting.
        const personRoles = new Set(personSeatRoles(sealed));
        const stranded = session.holders().find((holder) => !personRoles.has(holder.seat));
        if (stranded !== undefined) {
          const role = sealed.roles.find((candidate) => candidate.id === stranded.seat);
          const packRole = fullScenario.roles.find((candidate) => candidate.id === stranded.seat);
          // The room is empty and the grace is over: that seat holder has left for good, so say what
          // really happened instead of naming them as if they were still in the meeting.
          const left = rejoin.isEmpty() && !rejoin.wouldHold();
          if (left) {
            return {
              status: 409,
              body: {
                error: `${stranded.name} has left the meeting, so their seat is not in this setup. Ask them to rejoin, or reset the meeting.`,
              },
            };
          }
          return {
            status: 409,
            body: {
              error: `This meeting's setup has no place for ${role?.label ?? packRole?.label ?? stranded.seat}; the owner set the seats.`,
            },
          };
        }
        // A setup that passes field validation can still describe a meeting the scenario rules refuse.
        const derived = deriveMeetingScenario(fullScenario, sealed);
        if (!derived.ok) {
          return {
            status: 422,
            body: {
              error: 'This setup describes a meeting that cannot run, so the meeting was not started. Fix the setup and try again.',
              errors: derived.errors,
            },
          };
        }
        // Seal the meeting as a new value; the live scenario keeps serving everyone until this commits.
        const candidate = derived.scenario;
        const activeAi = (candidate.npcs ?? []).length > 0;
        // Server-side recognition is the runner's job, so even a meeting with no AI cast needs it
        // to hear anyone at all. Without it, refuse loudly instead of opening a silent meeting.
        if (!activeAi && speechRecognition === 'server' && !servicePresence().serverSpeech) {
          return {
            status: 503,
            body: {
              error:
                "Speech recording isn't ready, the AI service is not connected. Start it with npm run npc, then try again.",
              retryable: true,
            },
          };
        }
        const attempt = `start-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const meetingId = requestedMeetingId;
        const generation = requestedGeneration;
        session.beginStart(candidate, sealed);
        return () => runStart({ attempt, meetingId, generation, activeAi });
      },
    ).then((result) => (typeof result === 'function' ? result() : result));
    return Promise.race([queued, timedOut]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
  }
  if (persistence !== undefined) {
    hub.subscribe((event) => {
      if (
        event.type === 'TRANSCRIPT_CHUNK' ||
        event.type === 'MEETING_STARTED' ||
        event.type === 'MEETING_RECORD_UPDATED' ||
        event.type === 'HOST_SPEECH_TRIGGERED' ||
        event.type === 'TASK_UPDATED'
      ) {
        persistence.scheduleSave();
      }
    });
    if (persistence.saved !== undefined) {
      try {
        tasks.restore(persistence.saved.state.tasks);
        // Restored tasks do not fire a change: an ended meeting whose minutes were already
        // published before the restart is not under review any more.
        if (
          tasks
            .list()
            .some(
              (task) =>
                task.purpose === 'meeting_minutes' &&
                (task.status === 'COMPLETED' ||
                  task.status === 'SYNCED' ||
                  task.status === 'DISMISSED' ||
                  task.status === 'SUPERSEDED'),
            )
        ) {
          session.finishReview();
        }
      } catch (error) {
        closeRejoin();
        hub.close();
        await closeAuth();
        await closePersistence();
        throw error;
      }
    }
  }
  async function closeAuth(): Promise<void> {
    if (auth === undefined) return;
    await auth.close().catch((error: unknown) =>
      console.error('kaki server: the auth feature failed to stop', error),
    );
  }

  async function closePersistence(): Promise<void> {
    if (persistence === undefined) return;
    await persistence.close().catch((error: unknown) =>
      console.error('kaki server: the meeting persistence failed to stop', error),
    );
  }

  try {
    await listen(server, port, host);
  } catch (error) {
    closeRejoin();
    hub.close();
    await closeServer(server).catch(() => undefined);
    await closeAuth();
    await closePersistence();
    throw error;
  }

  const cleanups: Array<() => void> = [];

  for (const feature of modules) {
    try {
      const stop = feature.start({
        hub,
        tasks,
        activeScenario: () => session.active(),
        memory,
        draftOnly,
        persistence,
        meetingId: () => meeting.id,
        resetMeeting: (options) => admit(async () => session.reset(options)),
        serializeChange: (task) => admit(async () => task()),
        onReset: session.onReset,
        session,
        packFree,
        meetingDetails: () => session.snapshot(),
      });
      if (typeof stop === 'function') cleanups.push(stop);
    } catch (error) {
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch (cleanupError) {
          console.error('kaki server: a module failed to stop after startup failed', cleanupError);
        }
      }
      closeRejoin();
      hub.close();
      await closeServer(server);
      await closeAuth();
      await closePersistence();
      throw new Error(
        `kaki server: module "${feature.name}" failed to start: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  // The module has registered how to read its state; save once so an interrupted task already shows FAILED.
  persistence?.scheduleSave();

  // A restored meeting is already started: keep the start event available to late clients and the NPC,
  // carrying the saved agenda item so a fresh runner resumes it instead of reopening item zero.
  const savedStartAt = session.startedAt();
  if (session.phase() === 'running' && savedStartAt !== undefined) {
    hub.publish(
      {
        type: 'MEETING_STARTED',
        audience: { kind: 'all' },
        payload: {
          meetingId: meeting.id,
          startedAt: savedStartAt,
          agendaIndex: restoredAgendaIndex,
          resumed: true,
        },
      },
      { retainKey: 'meeting:started' },
    );
  }
  // Keep the runner snapshot available to a runner that starts after the server (and before Start).
  publishRunnerState();

  let closed = false;

  return {
    server,
    hub,
    tasks,
    session,
    memory,
    routes,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch (error) {
          console.error('kaki server: a module failed to stop', error);
        }
      }
      closeRejoin();
      hub.close();
      await closeServer(server);
      await closeAuth();
      await closePersistence();
    },
  };
}
