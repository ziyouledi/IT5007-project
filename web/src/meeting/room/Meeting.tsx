import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LiveKitRoom, useRoomContext } from '@livekit/components-react';
import '@livekit/components-styles';
import { ConnectionState, RoomEvent, type RoomOptions } from 'livekit-client';
import { joinSeatRoles } from '@kaki/shared';
import { useKaki, useRefreshScenario, useScenario } from '../../kaki';
import { fetchWithTimeout } from '../../net/withTimeout';
import { ErrorBoundary } from './ErrorBoundary';
import { JoinForm } from './JoinForm';
import type { MediaChoice } from './MediaPreview';
import { MeetingGrid } from './MeetingGrid';
import { Dock } from './Dock';
import { ConnectedStartPrompt } from './StartPrompt';
import { OwnerLobby, WaitingOverlay } from '../MeetingOverlays';
import { TeamJoinForm } from '../TeamJoinForm';
import { AudioUnlockPrompt } from './AudioUnlock';
import {
  clearStoredJoin,
  disconnectOutcome,
  formatGraceRemaining,
  readStoredJoin,
  REJOIN_GRACE_MS,
  storeJoin,
  type StoredJoin,
} from './rejoinSession';
import './demo.css';

/** Echo cancellation is what lets the server tell a person talking over the AI from the AI's own playback. */
const ROOM_OPTIONS: RoomOptions = {
  audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

/** Which journey this page is: the practice demo, a team participant, or the meeting owner. */
type MeetingVariant = 'practice' | 'participant' | 'owner';

interface Session {
  token: string;
  serverUrl: string;
  /** The Kaki role id of the attendee this person plays, for their private feed. */
  role: string;
  /** The name they typed to join. */
  name: string;
  /** The devices they joined with. Without the microphone they type to the AI attendees. */
  media: MediaChoice;
  /** The code others need to join this meeting. */
  meetingCode?: string;
}

/** Disconnects from LiveKit immediately when the browser tab refreshes or closes so the seat frees up right away. */
function CleanDisconnectOnUnload() {
  const room = useRoomContext();
  useEffect(() => {
    const onUnload = (): void => {
      void room.disconnect().catch(() => undefined);
    };
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [room]);
  return null;
}

/** Follow the server's explicit lifecycle state: every tab sees the same start, and a reset undoes it. */
function MeetingLifecycleWatcher({
  onStarted,
  onReset,
}: {
  onStarted(): void;
  onReset(): void;
}) {
  const { started } = useKaki({ kind: 'lifecycle' });
  useEffect(() => {
    if (started === true) onStarted();
    else if (started === false) onReset();
  }, [started, onStarted, onReset]);
  return null;
}

interface HotMeetingData {
  session?: Session;
  pane?: 'meeting' | 'kaki';
  started?: boolean;
}
const hotData = (import.meta as unknown as { hot?: { data: HotMeetingData } }).hot?.data;

/** The join this tab should return to after a reload or a dropped connection. */
function storedFromSession(session: Session): StoredJoin {
  return {
    name: session.name,
    role: session.role,
    media: session.media,
    ...(session.meetingCode === undefined ? {} : { meetingCode: session.meetingCode }),
  };
}

/**
 * The meeting page. Practice keeps the Kopitiam story and its own Start prompt; a team participant
 * waits for the owner; the owner gets the invite lobby. All three share the stage and the Dock.
 */
export default function Meeting({
  variant = 'practice',
  initialCode,
}: {
  variant?: MeetingVariant;
  initialCode?: string;
}) {
  const scenario = useScenario();
  const refreshScenario = useRefreshScenario();
  // The same seats the server offers: the setup's person seats when it names them, else every
  // human seat and the host's chair when a person can take it.
  const roles = useMemo(() => joinSeatRoles(scenario), [scenario]);
  const practice = variant === 'practice';
  const [session, setSession] = useState<Session | undefined>(() => hotData?.session);
  // A reload must not throw the person back to the name/seat form: remember the join this tab used
  // and ask the server for a fresh token for the same name and seat.
  const initialStored = useRef<StoredJoin | undefined>(
    hotData?.session === undefined ? readStoredJoin(variant) : undefined,
  );
  const [restore, setRestore] = useState<StoredJoin | undefined>(initialStored.current);
  const [rejoinState, setRejoinState] = useState<'idle' | 'reconnecting' | 'failed'>(
    initialStored.current === undefined ? 'idle' : 'reconnecting',
  );
  const [rejoinProblem, setRejoinProblem] = useState<string | undefined>();
  const [rejoinDeadline, setRejoinDeadline] = useState<number | undefined>(
    initialStored.current === undefined ? undefined : Date.now() + REJOIN_GRACE_MS,
  );
  const autoRejoinAttempted = useRef(false);
  // Cleared as soon as a drop starts a rejoin, so an unmount cannot start a second join for the same room.
  const activeSession = useRef<Session | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [realInProgress, setRealInProgress] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);
  const [pane, setPane] = useState<'meeting' | 'kaki'>(() => hotData?.pane ?? 'meeting');
  const [kakiBadgeCount, setKakiBadgeCount] = useState(0);
  // The AI attendees stay silent until the person has read their briefing and pressed Start.
  const [started, setStarted] = useState<boolean>(() => hotData?.started ?? false);
  useEffect(() => {
    if (hotData !== undefined) {
      hotData.session = session;
      hotData.pane = pane;
      hotData.started = started;
    }
  }, [session, pane, started]);

  useEffect(() => {
    activeSession.current = session;
  }, [session]);
  const linkCode = useMemo(
    () => initialCode ?? new URLSearchParams(window.location.search).get('code') ?? '',
    [initialCode],
  );
  const markMeetingStarted = useCallback(() => setStarted(true), []);
  const markMeetingReset = useCallback(() => setStarted(false), []);

  const hasAi = (scenario.npcs ?? []).length > 0;
  // A human-only setup names its person seats; those are the seats to offer even with no AI cast.
  const offersSeats = practice ? hasAi || scenario.joinSeats !== undefined : roles.length > 0;
  const seatsError = practice
    ? `${scenario.id} has no AI attendees: add "npcs" to its scenario.json.`
    : 'The meeting owner has not opened any seats yet.';

  async function join(
    name: string,
    roleId: string,
    media: MediaChoice,
    meetingCode?: string,
    options: { reconnecting?: boolean } = {},
  ): Promise<void> {
    const reconnecting = options.reconnecting === true;
    if (reconnecting) {
      setRejoinState('reconnecting');
      setRejoinProblem(undefined);
    } else {
      setBusy(true);
      setError(undefined);
      setRealInProgress(false);
    }
    try {
      const response = await fetchWithTimeout(
        '/api/livekit/token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            participantName: name,
            participantRole: roleId,
            ...(practice ? { kind: 'practice' } : {}),
            ...(meetingCode === undefined || meetingCode === '' ? {} : { meetingCode }),
          }),
        },
        12_000,
      );
      const body = (await response.json().catch(() => ({}))) as {
        token?: unknown;
        url?: unknown;
        error?: unknown;
        needsCode?: unknown;
        meetingCode?: unknown;
        resumed?: unknown;
        started?: unknown;
        realInProgress?: unknown;
      };
      if (body.needsCode === true) setNeedsCode(true);
      if (body.realInProgress === true) setRealInProgress(true);
      if (!response.ok || typeof body.token !== 'string') {
        throw new Error(typeof body.error === 'string' ? body.error : `Could not join (HTTP ${response.status}).`);
      }
      try {
        await refreshScenario();
      } catch {
        // Ignore refresh error if scenario already loaded
      }
      setPane('meeting');
      // The server owns whether the meeting has started: a started (or resumed) meeting goes straight in.
      setStarted(body.started === true || body.resumed === true);
      const effectiveCode =
        meetingCode ?? (typeof body.meetingCode === 'string' ? body.meetingCode : undefined);
      setSession({
        token: body.token,
        serverUrl: typeof body.url === 'string' ? body.url : `ws://${window.location.hostname}:7880`,
        role: roleId,
        name,
        media,
        ...(effectiveCode === undefined ? {} : { meetingCode: effectiveCode }),
      });
      setRestore(undefined);
      setRejoinState('idle');
      setRejoinProblem(undefined);
      setRejoinDeadline(undefined);
      storeJoin(variant, {
        name,
        role: roleId,
        media,
        ...(effectiveCode === undefined ? {} : { meetingCode: effectiveCode }),
      });
    } catch (joinError) {
      const message = joinError instanceof Error ? joinError.message : String(joinError);
      if (reconnecting) {
        setRejoinState('failed');
        setRejoinProblem(message);
      } else {
        setError(message);
      }
    } finally {
      if (!reconnecting) setBusy(false);
    }
  }

  /** Keep the meeting's recoverable state and ask for a fresh token for the same seat. */
  function beginReconnect(target: StoredJoin): void {
    setRestore(target);
    setRejoinState('reconnecting');
    setRejoinProblem(undefined);
    setRejoinDeadline(Date.now() + REJOIN_GRACE_MS);
    setSession(undefined);
    void join(target.name, target.role, target.media, target.meetingCode, { reconnecting: true });
  }

  useEffect(() => {
    if (autoRejoinAttempted.current || restore === undefined) return;
    autoRejoinAttempted.current = true;
    void join(restore.name, restore.role, restore.media, restore.meetingCode, { reconnecting: true });
  }, [restore]);

  if (session === undefined && restore !== undefined) {
    return (
      <RejoinScreen
        meetingTitle={scenario.meetingTitle}
        state={rejoinState}
        problem={rejoinProblem}
        deadline={rejoinDeadline}
        onRejoin={() =>
          void join(restore.name, restore.role, restore.media, restore.meetingCode, { reconnecting: true })
        }
        onLeave={() => {
          clearStoredJoin(variant);
          setRestore(undefined);
          setRejoinState('idle');
          setRejoinProblem(undefined);
          setRejoinDeadline(undefined);
        }}
      />
    );
  }

  if (session === undefined) {
    if (practice) {
      return (
        <JoinForm
          meetingTitle={scenario.meetingTitle}
          roles={offersSeats ? roles : []}
          agenda={scenario.agenda}
          busy={busy}
          error={offersSeats ? error : seatsError}
          askCode={needsCode}
          initialCode={linkCode}
          errorAction={
            realInProgress ? (
              <p className="kd-hint">
                <Link to="/">Back to Kaki</Link>
              </p>
            ) : undefined
          }
          onJoin={(name, roleId, media, code) => void join(name, roleId, media, code)}
        />
      );
    }
    return (
      <TeamJoinForm
        meetingTitle={scenario.meetingTitle}
        roles={offersSeats ? roles : []}
        busy={busy}
        error={offersSeats ? error : seatsError}
        initialCode={linkCode}
        owner={variant === 'owner'}
        onJoin={(name, roleId, media, code) => void join(name, roleId, media, code)}
      />
    );
  }

  const seatRole = scenario.roles.find((candidate) => candidate.id === session.role);
  // The meeting is opened by Start, wherever the person sits; a meeting already started goes straight in.
  const needsStart = !started;

  return (
    <div className="kd-meeting" data-pane={pane} data-needs-start={needsStart} data-variant={variant}>
      <div className="kd-stage">
        <LiveKitRoom
          video={session.media.camera}
          audio={session.media.microphone}
          connect
          token={session.token}
          serverUrl={session.serverUrl}
          options={ROOM_OPTIONS}
          onDisconnected={(reason) => {
            const target = activeSession.current;
            if (target === undefined) return;
            const outcome = disconnectOutcome(reason);
            if (outcome.kind === 'none') return;
            activeSession.current = undefined;
            if (outcome.kind === 'rejoin') {
              beginReconnect(storedFromSession(target));
              return;
            }
            clearStoredJoin(variant);
            setSession(undefined);
            setError(outcome.message);
          }}
          onError={(roomError) => {
            const target = activeSession.current;
            if (target === undefined) return;
            activeSession.current = undefined;
            setRestore(storedFromSession(target));
            setRejoinState('failed');
            setRejoinProblem(
              `Could not reach the meeting server at ${target.serverUrl}: ${roomError.message}. Is LiveKit running (npm run stack:up)?`,
            );
            setRejoinDeadline(Date.now() + REJOIN_GRACE_MS);
            setSession(undefined);
          }}
          data-lk-theme="default"
          style={{ height: '100%' }}
        >
          <ErrorBoundary>
            <MeetingGrid
              role={session.role}
              sharedAudience={variant === 'participant' ? 'participant' : 'screen'}
              onOpenKaki={() => setPane('kaki')}
              onKakiBadgeChange={setKakiBadgeCount}
              onLeave={() => {
                // Cleared first, so the disconnect this causes is not read as a dropped connection.
                activeSession.current = undefined;
                clearStoredJoin(variant);
                setSession(undefined);
              }}
            />
          </ErrorBoundary>
          <CleanDisconnectOnUnload />
          <LiveConnectionNotice />
          <AudioUnlockPrompt />
          <MeetingLifecycleWatcher onStarted={markMeetingStarted} onReset={markMeetingReset} />
          {needsStart && practice && (
            <ConnectedStartPrompt
              role={seatRole}
              viewerName={session.name}
              seatName={scenario.attendees.find((attendee) => attendee.role === session.role)?.displayName}
              onStarted={() => setStarted(true)}
            />
          )}
          {needsStart && variant === 'participant' && (
            <WaitingOverlay meetingTitle={scenario.meetingTitle} />
          )}
          {needsStart && variant === 'owner' && (
            <OwnerLobby initialCode={session.meetingCode} onStarted={markMeetingStarted} />
          )}
        </LiveKitRoom>
      </div>
      <Dock
        meetingCode={session.meetingCode}
        role={seatRole}
        sharedAudience={variant === 'participant' ? 'participant' : 'screen'}
        started={!needsStart}
        practice={practice}
        viewer={{
          name: session.name,
          seatName: scenario.attendees.find((attendee) => attendee.role === session.role)?.displayName,
        }}
      />
      <nav className="kd-panes" aria-label="Meeting or Kaki">
        <button type="button" aria-pressed={pane === 'meeting'} onClick={() => setPane('meeting')}>
          Meeting
        </button>
        <button type="button" aria-pressed={pane === 'kaki'} onClick={() => setPane('kaki')}>
          Kaki
          {kakiBadgeCount > 0 && pane !== 'kaki' && (
            <span className="kd-pane-badge" aria-label={`${kakiBadgeCount} action item waiting`}>
              {kakiBadgeCount}
            </span>
          )}
        </button>
      </nav>
    </div>
  );
}


/** Shown while LiveKit itself is trying to recover from a network switch or a short screen lock. */
function LiveConnectionNotice() {
  const room = useRoomContext();
  const [state, setState] = useState<ConnectionState | undefined>(room.state);
  useEffect(() => {
    const update = (next: ConnectionState): void => setState(next);
    room.on(RoomEvent.ConnectionStateChanged, update);
    return () => {
      room.off(RoomEvent.ConnectionStateChanged, update);
    };
  }, [room]);
  if (state !== ConnectionState.Reconnecting && state !== ConnectionState.SignalReconnecting) {
    return null;
  }
  return (
    <div className="kd-reconnect-banner" role="status">
      Reconnecting…
    </div>
  );
}

/** The way back into a meeting whose connection dropped, instead of the blank join form. */
function RejoinScreen({
  meetingTitle,
  state,
  problem,
  deadline,
  onRejoin,
  onLeave,
}: {
  meetingTitle: string;
  state: 'idle' | 'reconnecting' | 'failed';
  problem: string | undefined;
  deadline: number | undefined;
  onRejoin(): void;
  onLeave(): void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = deadline === undefined ? undefined : Math.max(0, deadline - now);
  return (
    <div className="kd-join" role="region" aria-label="Reconnecting to the meeting">
      <div className="kd-card">
        <div className="kd-live">
          <span className="kd-dot" />
          {state === 'failed' ? 'Rejoin needed' : 'Reconnecting'}
        </div>
        <h1 className="kd-title">
          {state === 'failed' ? 'Could not get back into the meeting yet' : 'Reconnecting to your meeting…'}
        </h1>
        <p className="kd-sub">{meetingTitle}</p>
        <p className="kd-hint">Same seat and name.</p>
        {remaining === undefined ? null : (
          <p className="kd-hint">
            Your seat is held for about {formatGraceRemaining(remaining)}.
            {remaining === 0 ? ' Rejoining may start a fresh meeting if the hold has ended.' : ''}
          </p>
        )}
        {problem === undefined ? null : (
          <p role="alert" className="kd-alert">
            {problem}
          </p>
        )}
        <button type="button" className="kd-go" onClick={onRejoin} disabled={state === 'reconnecting'}>
          {state === 'reconnecting' ? 'Rejoining…' : 'Rejoin'}
        </button>
        <button type="button" className="kd-chip" onClick={onLeave}>
          Leave and join as someone else
        </button>
      </div>
    </div>
  );
}
