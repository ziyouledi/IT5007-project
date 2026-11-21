import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  isKakiCommand,
  isKakiEvent,
  type KakiCommand,
  type KakiEvent,
  type Scenario,
} from '@kaki/shared';
import type { Principal } from '../http/access';
import { audienceFor, audienceLabel, roleAudience, type ClientAudience } from './audience';
import { PRACTICE_SCREEN_COMMANDS, rejectionFor, runnerMaySend } from './commandPermissions';
import { projectedEvent, wantsEvent, wantsProjectedEvent } from './eventProjection';
import {
  parseServiceMessage,
  rawDataToString,
  type RunnerStartRequest,
  type ServiceMessage,
} from './serviceMessages';

/** A command failure whose message is safe to show the sending client. */
export class CommandError extends Error {}

/** Mutation prepared by an asynchronous command handler, committed only while its caller is authorized. */
interface CommandEffect {
  /** The mutation itself; awaited so a queued lifecycle change finishes before the next command. */
  commit(): void | Promise<void>;
  cancel?(): void;
}

/** A server-owned handler for commands sent by clients. */
type CommandHandler = (command: KakiCommand, sender: ClientAudience) =>
  void | CommandEffect | Promise<void | CommandEffect>;

/** The result of checking whether a socket may connect; the principal is the same one HTTP uses. */
type UpgradeDecision =
  | {
      ok: true;
      participant?: boolean;
      principal?: Principal;
      sessionTokenHash?: string;
      runner?: boolean;
      /** The seat a participant projection or practice room is bound to. */
      seat?: string;
    }
  | { ok: false; message: string };

/** One socket message may not exceed this: the clients send small commands, not uploads. */
const MAX_PAYLOAD_BYTES = 1_000_000;

/** Options for the hub; auth plugs into the WebSocket upgrade through `authorize`. */
interface HubOptions {
  authorize?(request: IncomingMessage, audience: ClientAudience): Promise<UpgradeDecision>;
  /** Preserve the open demo's 1008 close frame for an invalid role. */
  closeUnknownRoleAfterUpgrade?: boolean;
  /** True when a person currently holds this role, so the runner's token may not act as it. */
  isHumanSeat?(role: string): boolean;
}

/** Options for publishing an event to the hub. */
interface PublishOptions {
  retainKey?: string;
}

/** Which AI runner service channels are connected; the runner always hears speech server-side. */
interface ServicePresence {
  connected: boolean;
  serverSpeech: boolean;
}

/** The meeting hub: routes events to their audience and collects client commands. */
export interface Hub {
  /** Validate an event, deliver it to its audience, and notify in-process subscribers. */
  publish(event: KakiEvent, options?: PublishOptions): void;
  /** Listen to every published event; returns an unsubscribe function. */
  subscribe(handler: (event: KakiEvent) => void): () => void;
  /** Add a handler for validated client commands; every handler sees every command and ignores the ones it does not own. */
  onCommand(handler: CommandHandler): void;
  /** Ask every connected AI runner to open the meeting; false when no runner is connected. */
  requestStart?(request: RunnerStartRequest): boolean;
  /** The AI runner service channels connected right now. */
  servicePresence?(): ServicePresence;
  /** Called whenever a runner service channel connects or disconnects. */
  onServicePresence?(handler: (presence: ServicePresence) => void): void;
  /** Listen for readiness and failure messages from the AI runner. */
  onServiceMessage?(handler: (message: ServiceMessage) => void): void;
  /** Forget retained events whose key starts with `prefix`, so clients that connect later do not get them. */
  clearRetained(prefix: string): void;
  /** Revoke a gone meeting's phone sessions: bump the authorization generation and close their feeds. */
  endRoleSessions?(reason: string): void;
  /**
   * Revoke every practice socket and pending practice upgrade, whatever audience it follows. A
   * meeting handoff means the practice capability no longer belongs to the meeting now on the server.
   */
  endPracticeSessions?(reason: string): void;
  /** Close every socket authorized by one session that has been replaced or signed out. */
  endSession?(sessionTokenHash: string): void;
  /** Close the WebSocket server and drop every client. */
  close(): void;
}

/** The real hub also owns the one publication path for a meeting reset. */
export interface MeetingHub extends Hub {
  /** The only way to publish a MEETING_RESET; `publish` refuses that event. */
  publishMeetingReset(event: KakiEvent): void;
  /** Run a command the server itself decided on, through every handler, with the shared screen's authority. */
  runServerCommand(command: KakiCommand): Promise<void>;
}

/** Create the `/ws` hub attached to an existing HTTP server; the scenario is read through a getter. */
export function createHub(httpServer: Server, activeScenario: () => Scenario, options: HubOptions = {}): MeetingHub {
  const authorize = options.authorize;
  const isHumanSeat = options.isHumanSeat ?? (() => false);
  /** The roles an AI profile currently voices; Start narrows this to the sealed AI seats. */
  const aiVoiceRoles = (): Set<string> => {
    const scenario = activeScenario();
    const profiles = new Set((scenario.npcs ?? []).map((npc) => npc.attendee));
    return new Set(
      scenario.attendees.filter((attendee) => profiles.has(attendee.name)).map((attendee) => attendee.role),
    );
  };
  /**
   * The runner may drive the screen command subset and the AI seats it voices, never a human
   * seat. A person currently in the seat wins over the profile, so a leaked token cannot approve
   * that person's outside actions.
   */
  const runnerMayUseAudience = (audience: ClientAudience): boolean => {
    if (audience.kind === 'screen' || audience.kind === 'service') return true;
    if (audience.kind !== 'role') return false;
    return aiVoiceRoles().has(audience.role) && !isHumanSeat(audience.role);
  };
  const verified = authorize === undefined;
  /** Bumped whenever a meeting's code rotates, so upgrades authorized under the old code cannot register. */
  let revocationGeneration = 0;
  /** Sessions retired while a socket was still authorizing, so its upgrade cannot register afterwards. */
  const revokedSessions = new Set<string>();
  /** How each pending upgrade was authorized, kept until its socket registers. */
  const pendingAuthorizations = new WeakMap<
    IncomingMessage,
    {
      generation: number;
      participant: boolean;
      sessionTokenHash?: string;
      runner: boolean;
      practice: boolean;
      seat?: string;
    }
  >();
  const wss = new WebSocketServer(
    verified
      ? { server: httpServer, path: '/ws', maxPayload: MAX_PAYLOAD_BYTES }
      : {
          server: httpServer,
          path: '/ws',
          maxPayload: MAX_PAYLOAD_BYTES,
          verifyClient: (info, done) => {
            const url = new URL(info.req.url ?? '/ws', 'http://localhost');
            const audience = audienceFor(activeScenario(), url);
            if (audience === undefined) {
              if (options.closeUnknownRoleAfterUpgrade === true) { done(true); return; }
              done(false, 401, 'Unknown role');
              return;
            }
            if (authorize === undefined) {
              done(true);
              return;
            }
            const generation = revocationGeneration;
            void authorize(info.req, audience)
              .then((decision) => {
                if (decision.ok) {
                  const principal = decision.principal;
                  const seat =
                    decision.seat ??
                    (principal?.kind === 'seat'
                      ? principal.role
                      : principal?.kind === 'host'
                        ? principal.seat
                        : undefined);
                  pendingAuthorizations.set(info.req, {
                    generation,
                    participant: decision.participant === true || principal?.kind === 'seat',
                    runner: decision.runner === true,
                    practice: principal?.kind === 'practice',
                    ...(seat === undefined ? {} : { seat }),
                    ...(decision.sessionTokenHash === undefined
                      ? {}
                      : { sessionTokenHash: decision.sessionTokenHash }),
                  });
                  done(true);
                } else {
                  done(false, 401, decision.message);
                }
              })
              .catch((error: unknown) => {
                console.error('kaki hub: WebSocket authorization failed', error);
                done(false, 500, 'Authorization failed');
              });
          },
        },
  );
  // ws re-emits the HTTP server's errors here; without a listener a port clash crashes the process
  // instead of letting listen() in createApp reject.
  wss.on('error', (error) => console.error('kaki hub: server error', error));
  const clients = new Map<WebSocket, ClientAudience>();
  const subscribers = new Set<(event: KakiEvent) => void>();
  const retained = new Map<string, KakiEvent>();
  const commandHandlers: CommandHandler[] = [];
  const serviceHandlers = new Set<(message: ServiceMessage) => void>();
  const serviceSockets = new Set<WebSocket>();
  const servicePresenceHandlers = new Set<(presence: ServicePresence) => void>();
  /** Command sockets opened with the AI runner's token instead of a person's session. */
  const runnerSockets = new Set<WebSocket>();
  /** Sockets behind a participant's phone session, whatever audience they follow. */
  const participantSockets = new Set<WebSocket>();
  /** Sockets authorized by a practice meeting's one capability. They die with that meeting. */
  const practiceSockets = new Set<WebSocket>();
  /** The session each person's socket was authorized by, so replacing it can close the socket. */
  const socketSessions = new Map<WebSocket, string>();
  /** The seat a participant projection or practice screen belongs to, for redacting private work. */
  const socketSeats = new Map<WebSocket, string>();

  function currentServicePresence(): ServicePresence {
    let connected = false;
    let serverSpeech = false;
    for (const socket of serviceSockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      connected = true;
      serverSpeech = true;
    }
    return { connected, serverSpeech };
  }

  function notifyServicePresence(): void {
    const presence = currentServicePresence();
    for (const handler of servicePresenceHandlers) {
      try {
        handler(presence);
      } catch (error) {
        console.error('kaki hub: a service-presence handler failed', error);
      }
    }
  }

  function forgetSocket(socket: WebSocket): void {
    const wasService = serviceSockets.delete(socket);
    clients.delete(socket);
    runnerSockets.delete(socket);
    participantSockets.delete(socket);
    practiceSockets.delete(socket);
    socketSessions.delete(socket);
    socketSeats.delete(socket);
    if (wasService) notifyServicePresence();
  }

  /** Drop every authority the socket had before starting the close handshake. */
  function revokeSocket(socket: WebSocket, code: number, reason: string): void {
    forgetSocket(socket);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
  }

  function sendTo(socket: WebSocket, audience: ClientAudience, message: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(message, (error) => {
        if (error) console.error(`kaki hub: failed to send to ${audienceLabel(audience)}`, error);
      });
    } catch (error) {
      console.error(`kaki hub: failed to send to ${audienceLabel(audience)}`, error);
    }
  }

  function sendRetained(socket: WebSocket, audience: ClientAudience): void {
    const seat = socketSeats.get(socket);
    const practiceScreen = practiceSockets.has(socket) && audience.kind === 'screen';
    for (const event of retained.values()) {
      let visible: KakiEvent | undefined;
      if (audience.kind === 'participant') {
        if (!wantsProjectedEvent(event, seat)) continue;
        visible = projectedEvent(event, seat, false);
      } else if (practiceScreen) {
        // A practice screen sees its meeting, never another seat's private facts or task drafts.
        if (!wantsEvent(event, audience)) continue;
        visible = projectedEvent(event, seat, true);
      } else {
        if (!wantsEvent(event, audience)) continue;
        visible = event;
      }
      if (visible === undefined) continue;
      // Retained events are history: mark them so a runner can tell an old cue from a live one.
      sendTo(socket, audience, JSON.stringify({ ...visible, replayed: true }));
    }
  }

  /** Check again after every await, before dispatch continues or a prepared mutation commits. */
  function callerStillAuthorized(socket: WebSocket, audience: ClientAudience): boolean {
    return clients.get(socket) === audience && socket.readyState === WebSocket.OPEN &&
      (!runnerSockets.has(socket) || runnerMayUseAudience(audience));
  }

  async function dispatchCommand(socket: WebSocket, audience: ClientAudience, command: KakiCommand): Promise<void> {
    // A participant projection is read-only as a screen, but the same person may still speak and
    // act on their own tasks: handlers see the seat behind the projection, never the projection.
    const seat = socketSeats.get(socket);
    const sender: ClientAudience =
      audience.kind === 'participant' && seat !== undefined ? roleAudience(seat) : audience;
    for (const handler of commandHandlers) {
      if (!callerStillAuthorized(socket, audience)) return;
      const effect = await handler(command, sender);
      if (!callerStillAuthorized(socket, audience)) {
        effect?.cancel?.();
        return;
      }
      await effect?.commit();
    }
  }

  async function handleClientMessage(
    socket: WebSocket,
    audience: ClientAudience,
    data: RawData,
  ): Promise<void> {
    // Revocation removes the socket from the client set synchronously, while the close handshake
    // may still allow frames to arrive; those frames must carry no authority.
    if (!clients.has(socket)) return;
    const seat = socketSeats.get(socket);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(data));
    } catch {
      if (audience.kind === 'service') {
        console.error('kaki hub: ignored a malformed message from the AI runner service channel');
        return;
      }
      sendTo(socket, audience, JSON.stringify(rejectionFor(audience, 'unknown', 'Invalid JSON', seat)));
      return;
    }

    if (audience.kind === 'service') {
      const message = parseServiceMessage(parsed);
      if (message === undefined) {
        console.error('kaki hub: ignored an invalid message from the AI runner service channel', parsed);
        return;
      }
      for (const handler of serviceHandlers) {
        try {
          handler(message);
        } catch (error) {
          console.error('kaki hub: a runner service handler failed', error);
        }
      }
      return;
    }

    // A lifecycle feed is read-only: it follows start/reset state and may never drive the meeting.
    if (audience.kind === 'lifecycle') {
      console.warn('kaki hub: ignored a command from the read-only lifecycle feed');
      return;
    }

    // A participant may read the shared screen to follow the meeting, but the screen's command
    // authority (dispatch, dismiss, end, reset) belongs to the owner.
    if (participantSockets.has(socket) && audience.kind === 'screen') {
      const rawType =
        typeof parsed === 'object' && parsed !== null && 'type' in parsed && typeof parsed.type === 'string'
          ? parsed.type
          : 'unknown';
      const reason = 'Meeting participants may read the screen but not control it';
      console.warn(`kaki hub: refused ${rawType} from ${audienceLabel(audience)}: ${reason}`);
      sendTo(socket, audience, JSON.stringify(rejectionFor(audience, rawType, reason, seat)));
      return;
    }

    // A practice visitor may read the shared screen to render their practice meeting and may move
    // or end that practice, but the rest of the screen's command authority (dispatch, dismiss,
    // reset) belongs to the owner.
    if (practiceSockets.has(socket) && audience.kind === 'screen') {
      const rawType =
        typeof parsed === 'object' && parsed !== null && 'type' in parsed && typeof parsed.type === 'string'
          ? parsed.type
          : 'unknown';
      if (!PRACTICE_SCREEN_COMMANDS.has(rawType)) {
        const reason = 'Practice access may read the screen but not control it';
        console.warn(`kaki hub: refused ${rawType} from ${audienceLabel(audience)}: ${reason}`);
        sendTo(socket, audience, JSON.stringify(rejectionFor(audience, rawType, reason, seat)));
        return;
      }
    }

    if (!isKakiCommand(parsed, activeScenario())) {
      const rawType =
        typeof parsed === 'object' && parsed !== null && 'type' in parsed && typeof parsed.type === 'string'
          ? parsed.type
          : 'unknown';
      const reason = 'Invalid command';
      console.warn(`kaki hub: refused ${rawType} from ${audienceLabel(audience)}: ${reason}`);
      sendTo(socket, audience, JSON.stringify(rejectionFor(audience, rawType, reason, seat)));
      return;
    }

    if (runnerSockets.has(socket)) {
      // The cast can change when Start seals the setup or a person takes the seat. Re-check the
      // runner's eligibility on every command and revoke the socket the moment it no longer holds.
      if (!runnerMayUseAudience(audience)) {
        console.warn(`kaki hub: closing the AI runner socket on ${audienceLabel(audience)}: it is no longer an AI-cast role`);
        socket.close(4008, 'The AI runner may not act as this role');
        return;
      }
      if (!runnerMaySend(audience, parsed.type)) {
        const reason = 'The AI runner may not send that command';
        console.warn(`kaki hub: refused ${parsed.type} from the AI runner on ${audienceLabel(audience)}: ${reason}`);
        sendTo(socket, audience, JSON.stringify(rejectionFor(audience, parsed.type, reason, seat)));
        return;
      }
    }

    if (commandHandlers.length === 0) {
      const reason = 'No command handler is registered';
      console.warn(`kaki hub: refused ${parsed.type} from ${audienceLabel(audience)}: ${reason}`);
      sendTo(socket, audience, JSON.stringify(rejectionFor(audience, parsed.type, reason, seat)));
      return;
    }

    try {
      await dispatchCommand(socket, audience, parsed);
    } catch (error) {
      if (error instanceof CommandError) {
        console.warn(`kaki hub: refused ${parsed.type} from ${audienceLabel(audience)}: ${error.message}`);
        sendTo(socket, audience, JSON.stringify(rejectionFor(audience, parsed.type, error.message, seat)));
        return;
      }
      console.error(`kaki hub: command ${parsed.type} from ${audienceLabel(audience)} failed`, error);
      sendTo(socket, audience, JSON.stringify(rejectionFor(audience, parsed.type, 'internal error', seat)));
    }
  }

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/ws', 'http://localhost');
    const audience = audienceFor(activeScenario(), url);

    if (audience === undefined) {
      const missing = url.searchParams.get('role') === null && url.searchParams.get('audience') === null;
      socket.close(1008, missing ? 'Missing role' : 'Unknown role');
      return;
    }

    const authorization = pendingAuthorizations.get(request);
    const seatAudience = audience.kind === 'role';
    if (
      authorization !== undefined &&
      authorization.generation !== revocationGeneration &&
      (authorization.practice === true ||
        authorization.participant === true ||
        (seatAudience && authorization.runner !== true))
    ) {
      // Authorized for the previous meeting's generation: the practice, phone or seat grant is gone.
      socket.close(4001);
      return;
    }
    if (
      authorization?.sessionTokenHash !== undefined &&
      revokedSessions.has(authorization.sessionTokenHash)
    ) {
      // The session was retired after this upgrade authorized, so it must not register now.
      socket.close(4001);
      return;
    }

    clients.set(socket, audience);
    if (authorization?.seat !== undefined) socketSeats.set(socket, authorization.seat);
    if (audience.kind === 'service') {
      serviceSockets.add(socket);
    } else if (authorization?.runner === true) runnerSockets.add(socket);
    else if (authorization?.practice === true) practiceSockets.add(socket);
    else if (authorization?.participant === true || audience.kind === 'participant') participantSockets.add(socket);
    if (authorization?.sessionTokenHash !== undefined) {
      socketSessions.set(socket, authorization.sessionTokenHash);
    }
    sendRetained(socket, audience);
    if (audience.kind === 'service') notifyServicePresence();
    socket.on('close', () => {
      forgetSocket(socket);
    });
    socket.on('error', (error) => {
      console.error(`kaki hub: socket error for ${audienceLabel(audience)}`, error);
      forgetSocket(socket);
    });
    socket.on('message', (data) => {
      void handleClientMessage(socket, audience, data);
    });
  });

  function deliver(event: KakiEvent, options: PublishOptions = {}): void {
    if (options.retainKey !== undefined) {
      retained.delete(options.retainKey);
      retained.set(options.retainKey, event);
    }

    const message = JSON.stringify(event);
    for (const [socket, audience] of clients) {
      const seat = socketSeats.get(socket);
      const practiceScreen = practiceSockets.has(socket) && audience.kind === 'screen';
      let visible: KakiEvent | undefined;
      if (audience.kind === 'participant') {
        // The participant projection is the only shared feed a non-owner may use.
        if (!wantsProjectedEvent(event, seat)) continue;
        visible = projectedEvent(event, seat, false);
      } else if (practiceScreen) {
        // A practice screen is a read-only projection: a role's private event is for that seat,
        // and another seat's task drafts stay private too.
        if (!wantsEvent(event, audience)) continue;
        visible = projectedEvent(event, seat, true);
      } else if (wantsEvent(event, audience)) {
        visible = event;
      }
      if (visible !== undefined) {
        sendTo(socket, audience, visible === event ? message : JSON.stringify(visible));
      }
    }

    for (const handler of subscribers) {
      try {
        handler(event);
      } catch (error) {
        console.error('kaki hub: a subscriber failed', error);
      }
    }
  }

  return {
    publish(event, options = {}) {
      if (!isKakiEvent(event, activeScenario())) {
        throw new Error(`kaki hub: refusing to publish an invalid event: ${JSON.stringify(event)}`);
      }
      if (event.type === 'MEETING_RESET') {
        const reason =
          'MEETING_RESET can only be published by the meeting session; call session.reset instead';
        console.error(`kaki hub: refused to publish a MEETING_RESET: ${reason}`);
        throw new Error(`kaki hub: ${reason}`);
      }
      deliver(event, options);
    },
    publishMeetingReset(event) {
      if (!isKakiEvent(event, activeScenario()) || event.type !== 'MEETING_RESET') {
        throw new Error(
          `kaki hub: refusing to publish an invalid meeting reset: ${JSON.stringify(event)}`,
        );
      }
      deliver(event);
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    onCommand(handler) {
      commandHandlers.push(handler);
    },
    async runServerCommand(command) {
      for (const handler of commandHandlers) {
        const effect = await handler(command, { kind: 'screen' });
        await effect?.commit();
      }
    },
    requestStart(request) {
      if (serviceSockets.size === 0) return false;
      const message = JSON.stringify({ kind: 'prepare', request });
      let sent = false;
      for (const socket of serviceSockets) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        sendTo(socket, { kind: 'service' }, message);
        sent = true;
      }
      return sent;
    },
    onServiceMessage(handler) {
      serviceHandlers.add(handler);
    },
    servicePresence() {
      return currentServicePresence();
    },
    onServicePresence(handler) {
      servicePresenceHandlers.add(handler);
    },
    clearRetained(prefix) {
      for (const key of [...retained.keys()]) if (key.startsWith(prefix)) retained.delete(key);
    },
    endRoleSessions(reason) {
      revocationGeneration += 1;
      for (const [socket, audience] of [...clients]) {
        // A practice socket belongs to the meeting that granted it, whatever audience it reads.
        if (practiceSockets.has(socket)) {
          revokeSocket(socket, 4001, reason);
          continue;
        }
        if (audience.kind === 'service') continue;
        // A host's read-only lifecycle feed and screen survive a handoff; a participant's must not
        // follow the new meeting.
        if (audience.kind === 'screen' && !participantSockets.has(socket)) continue;
        if (runnerSockets.has(socket)) continue;
        if (audience.kind === 'lifecycle' && !participantSockets.has(socket)) continue;
        const session = socketSessions.get(socket);
        if (session !== undefined) revokedSessions.add(session);
        revokeSocket(socket, 4001, reason);
      }
    },
    endPracticeSessions(reason) {
      // The bump also refuses a practice upgrade that authorized before this handoff but registers
      // its socket afterwards.
      revocationGeneration += 1;
      for (const socket of [...practiceSockets]) revokeSocket(socket, 4001, reason);
    },
    endSession(sessionTokenHash) {
      // Retired before the sockets close: a pending upgrade authorized by this session is refused.
      revokedSessions.add(sessionTokenHash);
      for (const [socket, session] of [...socketSessions]) {
        if (session === sessionTokenHash) revokeSocket(socket, 4001, 'Signed in again elsewhere');
      }
    },
    close() {
      for (const socket of clients.keys()) socket.terminate();
      clients.clear();
      serviceSockets.clear();
      runnerSockets.clear();
      participantSockets.clear();
      practiceSockets.clear();
      socketSessions.clear();
      socketSeats.clear();
      revokedSessions.clear();
      serviceHandlers.clear();
      servicePresenceHandlers.clear();
      retained.clear();
      subscribers.clear();
      wss.close();
    },
  };
}
