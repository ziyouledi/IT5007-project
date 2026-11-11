import {
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
} from '@livekit/rtc-node';
import {
  aiCast,
  demoRoomName,
  humanAttendeeForRole,
  CONTROL_TOPIC,
  NPC_STATE_TOPIC,
  parseControlMessage,
  STT_TOPIC,
  type NpcProfile,
  type NpcStateMessage,
  type Scenario,
} from '@kaki/shared';
import { OPENING_PREFIX, liveNextItemLine, liveOpeningLine, openingLine, spokenTopicLead } from '../host/opening';
import type { ChatMessage } from '../llm';
import { createRoomToken } from '../livekit';
import { NpcConversation } from './conversation';
import type { Utterance } from './director';
import { playPcm } from './playback';
import { PlaybackReference } from './reference';
import { UtteranceRecorder, type Recognizer } from './utterance';
import { EnergyVad, type VadOptions } from './vad';

/** Sample rate of everything published to and read from LiveKit. */
export const SAMPLE_RATE = 16000;

/**
 * After the AI stops, its sound keeps arriving at the person's microphone for as long as the
 * round trip takes (speakers, room, two network hops). The voice detector stays strict that long,
 * or the tail of the echo would be taken for the person talking.
 */
const GUARD_TAIL_MS = 1400;

export interface RunnerOptions {
  scenario: Scenario;
  livekitUrl: string;
  /** Defaults to the scenario's demo room. */
  roomName?: string;
  /** How long the person must keep talking over the AI before it stops (default 900 ms). */
  bargeInMs?: number;
  /** The Director's reply as it is written. */
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  /** A sentence as 16 kHz mono samples. */
  synthesize(utterance: Utterance, signal: AbortSignal): Promise<Int16Array>;
  /** A line spoken in the meeting, under the name Kaki's transcript uses. */
  postTranscript(speaker: string, text: string): void;
  responseDelayMs?: number;
  /** Called when the last person has left the room (not when the room was empty to begin with). */
  onRoomEmpty?: () => void;
  /** Called when a person takes the host's seat or leaves it (also false when the room empties). */
  onHostChange?: (human: boolean) => void;
  /** Called when an observe-only agenda item has been talked through and the meeting should move on. */
  onAdvanceAgenda?: () => void;
  /** Called when the final agenda item has wrapped up and the meeting should conclude. */
  onEndMeeting?: () => void;
  /** Called when the visitor pauses or resumes the meeting via the TypeBar button or Escape. */
  onPauseChange?: (paused: boolean) => void;
  /** Pause between one character and the next. */
  speakerGapMs?: number;
  /** Pause between two sentences of the same speaker. */
  sentenceGapMs?: number;
  /** Recognise the person's speech on the server, from their echo-cancelled microphone track; without it, the browser's recognition is used. */
  recognizer?: Recognizer;
  /** Receives each stretch of audio sent to the recogniser, to save it for listening. */
  debugAudio?(samples: Int16Array): void;
  vad?: Partial<VadOptions>;
  log?(message: string): void;
  /** Log the voice detector's levels twice a second while the AI talks, for tuning. */
  traceVad?: boolean;
  /** The connection to LiveKit was lost; the runner is no longer usable. */
  onDisconnected?(): void;
  /** Fetch the latest scenario agenda order from the Kaki server when a new visitor session starts. */
  fetchScenario?(): Promise<Scenario | undefined>;
  /** Emit a live 1-sentence Wingman coaching brief when the visitor's turn updates the discussion state. */
  onWingmanTip?(tip: string, title: string): void;
}

export interface NpcRunner {
  /**
   * The host character says `text` aloud when the person is in the room and it is quiet (dropped if nobody is there).
   * `onDone` runs when it has been said (`true`) or given up on (`false`); it is not called when the cue is ignored outright.
   */
  announce(text: string, onDone?: (spoken: boolean) => void, shouldStillSpeak?: () => boolean): void;
  /** The meeting moved to the next agenda item: the AI host will ask the person for the decision they own. */
  agendaMoved(title?: string): void;
  /** A follow-up task on the current agenda item was accepted: if the person already weighed in, move the meeting on. */
  taskAccepted(originAgendaTitle?: string | null): void;
  /** The visitor clicked "Let Kaki do it" on a task assigned to them: hold the advance timer so they can review the draft. */
  holdForHumanTask(holdMs?: number, originAgendaTitle?: string | null): void;
  /** Cancel a queued or running task-dispatch announcement when the visitor already clicked Accept or Decline. */
  cancelPendingDispatch(originAgendaTitle?: string | null): void;
  /** Advance to the next agenda item (or end the meeting) once the visitor's task has been synced/declined. */
  completeHumanTask(originAgendaTitle?: string | null): void;
  /** True when `title` names the item the meeting is on now. */
  onCurrentAgenda(title: string | undefined): boolean;
  /** The current human visitor's display name, if someone is in the room. */
  visitorName(): string | undefined;
  /** True when `attendee` is voiced by the AI right now (not when a person took that seat). */
  plays(attendee: string): boolean;
  /** True when the visitor has already spoken on the current agenda item (or the item is observe-only). */
  canDispatchTask(): boolean;
  /** True while a person sits in the host's seat: the AI host stays silent and the host's cues are only suggestions. */
  hostIsHuman(): boolean;
  /** `attendee` says `text` aloud once it is quiet; `onDone` runs when they finish or the line is dropped. */
  say(attendee: string, text: string, onDone?: () => void): void;
  /** Pause the current conversation (for example when the meeting ends). */
  pause(): void;
  /** Interrupt any running AI turn, speak the closing line from the host, and then keep the conversation stopped. */
  announceClosing(text: string): void;
  /** Leave the room and stop everything. */
  stop(): Promise<void>;
}

interface Character {
  room: Room;
  source: AudioSource;
}

/**
 * Runs the AI attendees of the live demo meeting: joins the LiveKit room once per character,
 * listens to the person, and answers in the characters' voices. The decisions live in
 * `NpcConversation`; this connects it to LiveKit and to whatever speech and model it is given.
 */
export async function startNpcRunner(options: RunnerOptions): Promise<NpcRunner> {
  const { scenario, livekitUrl } = options;
  const log = options.log ?? (() => undefined);
  const npcs = scenario.npcs ?? [];
  if (npcs.length === 0) throw new Error(`Scenario "${scenario.id}" defines no npcs, so there is nobody to run`);
  const npcNames = new Set(npcs.map((npc) => npc.attendee));
  // Characters nobody can play stay in the room and listen; the rest join for the person who arrives,
  // as everyone except the seat that person took.
  // When every character is playable (the host's seat too), the host stays connected as a silent listener
  // while a person plays their seat: the AI Sam steps out of the conversation, not out of the room.
  const hostProfile = npcs.find((npc) => npc.role === 'host');
  const hostName = hostProfile?.attendee;
  const alwaysAi = aiCast(scenario);
  const listenerProfile = alwaysAi[0] ?? hostProfile ?? npcs[0]!;
  const permanent = alwaysAi.length > 0 ? alwaysAi : [listenerProfile];
  const roomName = options.roomName ?? demoRoomName(scenario);

  // --- Characters join the room one by one, each publishing its own microphone track. ---
  const characters = new Map<string, Character>();
  const leaveAll = (): Promise<unknown> =>
    Promise.all([...characters.values()].map(({ room }) => room.disconnect().catch(() => undefined)));

  async function joinCharacter(npc: NpcProfile): Promise<void> {
    if (characters.has(npc.attendee)) return;
    const token = await createRoomToken({ roomName, participantName: npc.attendee, participantRole: 'AI attendee' });
    const room = new Room();
    try {
      await room.connect(livekitUrl, token);
    } catch (error) {
      throw new Error(
        `Could not connect ${npc.attendee} to LiveKit at ${livekitUrl} (${String(error) || 'no reason given'}). ` +
          'Is it running? Start it with "npm run stack:up", or set LIVEKIT_URL.',
        { cause: error },
      );
    }
    const source = new AudioSource(SAMPLE_RATE, 1, 400);
    const track = LocalAudioTrack.createAudioTrack('microphone', source);
    await room.localParticipant?.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
    characters.set(npc.attendee, { room, source });
    log(`${npc.attendee} joined ${roomName}`);
  }

  try {
    for (const npc of permanent) await joinCharacter(npc);
  } catch (error) {
    await leaveAll();
    throw error;
  }
  const listener = characters.get(listenerProfile.attendee) as Character;

  // --- What the AI attendees send out: state to the browser, transcript lines to Kaki. ---
  let lastConversationState: NpcStateMessage = { kind: 'idle' };
  let sustainedHumanSpeaking = false;
  let humanTranscribing = false;
  let humanSpeakingTimer: ReturnType<typeof setTimeout> | undefined;
  const HUMAN_SPEAKING_BADGE_MS = 350;

  function publishState(state: NpcStateMessage): void {
    const decorated: NpcStateMessage =
      state.kind === 'idle' || state.kind === 'thinking' || state.kind === 'speaking'
        ? {
            ...state,
            ...(sustainedHumanSpeaking ? { humanSpeaking: true } : {}),
            ...(humanTranscribing ? { transcribing: true } : {}),
          }
        : state;
    const data = new TextEncoder().encode(JSON.stringify(decorated));
    listener.room.localParticipant?.publishData(data, { reliable: true, topic: NPC_STATE_TOPIC }).catch(() => undefined);
  }

  function syncHumanMicState(anyTalking: boolean): void {
    if (anyTalking) {
      if (!sustainedHumanSpeaking && humanSpeakingTimer === undefined) {
        humanSpeakingTimer = setTimeout(() => {
          humanSpeakingTimer = undefined;
          if (talking.size > 0 && !sustainedHumanSpeaking) {
            sustainedHumanSpeaking = true;
            publishState(lastConversationState);
          }
        }, HUMAN_SPEAKING_BADGE_MS);
      }
    } else {
      if (humanSpeakingTimer !== undefined) {
        clearTimeout(humanSpeakingTimer);
        humanSpeakingTimer = undefined;
      }
      if (sustainedHumanSpeaking) {
        sustainedHumanSpeaking = false;
        publishState(lastConversationState);
      }
    }
  }

  // What the AI plays, so the voice detectors can tell how much of it their microphone hears.
  const reference = new PlaybackReference();
  const vads = new Map<string, EnergyVad>();
  const talking = new Set<string>();
  let guardTimer: ReturnType<typeof setTimeout> | undefined;

  /** While the AI is audible, and while its echo can still be arriving, the detector is stricter. */
  function setGuard(on: boolean): void {
    if (guardTimer !== undefined) clearTimeout(guardTimer);
    const apply = (): void => {
      for (const vad of vads.values()) vad.guarded = on;
    };
    if (on) apply();
    else guardTimer = setTimeout(apply, GUARD_TAIL_MS);
  }

  function makeConversation(cast: NpcProfile[]): NpcConversation<Int16Array> {
    return new NpcConversation<Int16Array>(
      {
        stream: options.stream,
        synthesize: options.synthesize,
        play: (speaker, clip, signal) => {
          const character = characters.get(speaker);
          if (character === undefined) return Promise.reject(new Error(`${speaker} is not in the room`));
          return playPcm(character.source, clip, SAMPLE_RATE, signal, reference);
        },
        emitTranscript: (speaker, text) => {
          const attendee = scenario.attendees.find((candidate) => candidate.name === speaker);
          options.postTranscript(attendee?.zoomDisplayName ?? speaker, text);
        },
        emitState: (state) => {
          lastConversationState = state;
          setGuard(state.kind === 'speaking');
          publishState(state);
        },
        log,
        describeMic: () => {
          const vad = vads.values().next().value as EnergyVad | undefined;
          if (vad === undefined) return undefined;
          return `mic peak ${vad.peak(3000).toFixed(3)} in the last 3 s, bar to count as talking ${vad.threshold.toFixed(3)}`;
        },
        advanceAgenda: options.onAdvanceAgenda,
        endMeeting: options.onEndMeeting,
        onWingmanTip: options.onWingmanTip,
      },
      { scenario: { ...scenario, npcs: cast }, responseDelayMs: options.responseDelayMs, speakerGapMs: options.speakerGapMs, sentenceGapMs: options.sentenceGapMs, bargeInMs: options.bargeInMs },
    );
  }

  // --- The person: their voice activity, and the words the browser recognised. ---
  let conversation: NpcConversation<Int16Array> | undefined;
  let castNames = '';
  interface Person {
    name: string;
    role: string;
    seat: string | undefined;
  }
  const humans = new Map<string, Person>();
  let closing = false;
  /** While keys are being pressed, a short sound in the microphone is more likely the keyboard than speech. */
  const TYPING_QUIET_MS = 500;
  let typingUntil = 0;
  const suppressed = new Set<string>();

  /** Make the room match the people in it: everyone but their seats, and a conversation for exactly that cast. */
  let castQueue: Promise<void> = Promise.resolve();
  /** The welcome is spoken once per visit: when the person arrives, not when they first speak. */
  let welcomed = false;
  /** How many task dispatches have been voiced to the visitor so Sam can orient them on the first one and be brief after. */
  let visitorTaskDispatches = 0;
  /**
   * The person has read their briefing and pressed Start. Until then the AI attendees are in the room but silent, and
   * nothing the person says or types reaches them. A person in the host's seat opens the meeting themselves, so they skip this.
   */
  let started = false;
  let paused = false;
  const meetingOpen = (): boolean => (started || hostIsHuman()) && !paused;
  function syncCast(): void {
    castQueue = castQueue
      .then(async () => {
        if (closing) return;
        const seats = new Set([...humans.values()].flatMap((person) => (person.seat === undefined ? [] : [person.seat])));
        const wanted =
          humans.size === 0 ? permanent : npcs.filter((npc) => npc.playable !== true || !seats.has(npc.attendee));
        for (const npc of wanted) await joinCharacter(npc);
        for (const [name, character] of [...characters]) {
          if (name === listenerProfile.attendee || wanted.some((npc) => npc.attendee === name)) continue;
          characters.delete(name);
          await character.room.disconnect().catch(() => undefined);
          log(`${name} left ${roomName}`);
        }

        const names = wanted.map((npc) => npc.attendee).join(',');
        if (humans.size === 0) {
          conversation?.close();
          conversation = undefined;
          castNames = '';
          welcomed = false;
          visitorTaskDispatches = 0;
          started = false;
          paused = false;
        } else if (conversation === undefined || names !== castNames || !started) {
          if (options.fetchScenario !== undefined) {
            const latest = await options.fetchScenario().catch(() => undefined);
            if (latest !== undefined && Array.isArray(latest.agenda) && latest.agenda.length > 0) {
              scenario.agenda.splice(0, scenario.agenda.length, ...latest.agenda);
            }
          }
          if (conversation === undefined || names !== castNames) {
            conversation?.close();
            conversation = makeConversation(wanted);
            castNames = names;
          }
          const person = [...humans.values()].at(-1)!;
          const role = scenario.roles.find(
            (candidate) => candidate.id.toLowerCase() === person.role.trim().toLowerCase() || candidate.label.toLowerCase() === person.role.trim().toLowerCase(),
          );
          conversation.setHuman({
            name: person.name,
            role: person.role,
            transcriptName: role === undefined ? person.name : `${person.name} (${role.label})`,
          });
        }
        // Sam welcomes the person once they press Start, before anyone else speaks (when a person hosts, the NPC co-host kicks off item 1's briefing).
        if (humans.size > 0 && started && !welcomed) {
          if (!hostIsHuman()) {
            announce(openingLine(scenario));
          } else {
            welcomed = true;
            conversation?.agendaMoved(scenario.agenda[0]?.title);
          }
        }
      })
      .catch((error: unknown) => log(`could not change who is in the meeting: ${String(error)}`));
  }

  let lastHostHuman = false;
  function reportHost(): void {
    const now = hostIsHuman();
    if (now === lastHostHuman) return;
    lastHostHuman = now;
    options.onHostChange?.(now);
  }

  function registerHuman(participant: RemoteParticipant): void {
    if (npcNames.has(participant.identity)) return;
    const role = participant.metadata?.trim() || 'participant';
    const name = participant.name || participant.identity;
    const seat = humanAttendeeForRole(scenario, role)?.name;
    const known = humans.get(participant.identity);
    if (known !== undefined && known.role === role && known.name === name) return;
    humans.set(participant.identity, { name, role, seat });
    reportHost();
    if (known === undefined) log(`${name} joined as ${role}`);
    syncCast();
  }

  async function listenTo(track: RemoteTrack, identity: string): Promise<void> {
    const recorder =
      options.recognizer === undefined
        ? undefined
        : new UtteranceRecorder(options.recognizer, {
            sampleRate: SAMPLE_RATE,
            log,
            onAudio: options.debugAudio,
            onRecognizing: (active) => {
              conversation?.humanRecognizing(active);
              if (humanTranscribing !== active) {
                humanTranscribing = active;
                publishState(lastConversationState);
              }
            },
            onNothing: () => conversation?.humanNothing(),
            onText: (text) => {
              if (!meetingOpen()) {
                log(`ignored "${text}": the meeting has not started`);
                return;
              }
              log(`recognised "${text}"`);
              conversation?.humanText(text);
            },
          });
    const vad: EnergyVad = new EnergyVad(
      (speaking) => {
        if (!meetingOpen()) return;
        if (speaking && Date.now() < typingUntil) {
          // Typing: the sound is probably a key press. Not speech, not a cut-in; its end is ignored too.
          suppressed.add(identity);
          log(`ignored a sound from ${identity} while they were typing`);
          return;
        }
        if (!speaking && suppressed.delete(identity)) return;
        if (speaking) talking.add(identity);
        else talking.delete(identity);
        log(
          speaking
            ? `${identity} started talking (mic peak ${vad.peak(300).toFixed(3)}, bar ${vad.threshold.toFixed(3)}${vad.guarded ? `, AI was talking: its level ${vad.referenceLevel.toFixed(3)}, its echo in the mic ${vad.leakLevel.toFixed(3)}` : ''})`
            : `${identity} stopped talking`,
        );
        conversation?.humanSpeech(talking.size > 0);
        syncHumanMicState(talking.size > 0);
        // Last, and guarded: a failure in speech recognition must never stop the conversation hearing the person.
        try {
          recorder?.speaking(speaking);
        } catch (error) {
          log(`speech recognition could not ${speaking ? 'start' : 'finish'}: ${String(error)}`);
        }
      },
      options.vad,
      { reference },
    );
    vads.set(identity, vad);
    let lastTrace = 0;
    try {
      for await (const frame of new AudioStream(track, SAMPLE_RATE, 1)) {
        if (!meetingOpen()) continue;
        vad.push(frame.data, frame.sampleRate);
        if (suppressed.has(identity) && vad.isSpeaking && Date.now() >= typingUntil) {
          suppressed.delete(identity);
          talking.add(identity);
          log(`${identity} kept speaking past keystroke window; unsuppressing mic`);
          conversation?.humanSpeech(talking.size > 0);
          syncHumanMicState(talking.size > 0);
          try {
            recorder?.speaking(true);
          } catch (error) {
            log(`speech recognition could not start: ${String(error)}`);
          }
        }
        try {
          recorder?.push(frame.data);
        } catch (error) {
          log(`speech recognition could not take audio: ${String(error)}`);
        }
        if (options.traceVad === true && vad.guarded && Date.now() - lastTrace > 500) {
          lastTrace = Date.now();
          log(
            `[vad] mic ${vad.peak(500).toFixed(3)} | AI ${vad.referenceLevel.toFixed(3)} | echo ${vad.leakLevel.toFixed(3)} | bar ${vad.threshold.toFixed(3)}${vad.isSpeaking ? ' | TALKING' : ''}`,
          );
        }
      }
    } catch (error) {
      log(`audio from ${identity} ended: ${String(error)}`);
    } finally {
      recorder?.close();
      vad.close();
      vads.delete(identity);
    }
  }

  const room = listener.room;
  room.on(RoomEvent.ParticipantConnected, registerHuman);
  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    if (!humans.delete(participant.identity)) return;
    talking.delete(participant.identity);
    syncHumanMicState(talking.size > 0);
    if (humans.size === 0 && humanTranscribing) {
      humanTranscribing = false;
      publishState(lastConversationState);
    }
    log(`${participant.identity} left`);
    reportHost();
    // With nobody left the conversation is closed, so the next person starts a fresh one.
    syncCast();
    if (humans.size === 0) options.onRoomEmpty?.();
  });
  room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (npcNames.has(participant.identity) || track.kind !== TrackKind.KIND_AUDIO) return;
    registerHuman(participant);
    void listenTo(track, participant.identity);
  });
  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (topic === CONTROL_TOPIC && participant !== undefined && !npcNames.has(participant.identity)) {
      let message: ReturnType<typeof parseControlMessage>;
      try {
        message = parseControlMessage(JSON.parse(new TextDecoder().decode(payload)));
      } catch {
        message = undefined;
      }
      if (message === undefined) {
        log('ignored a malformed control message');
      } else if (message.kind === 'typing') {
        typingUntil = Date.now() + TYPING_QUIET_MS;
        conversation?.humanTyping();
      } else if (message.kind === 'start') {
        const session = message.session ?? participant.identity;
        if (session !== participant.identity) {
          log(`ignored a Start for another session (${session})`);
          return;
        }
        if (!started) {
          started = true;
          log(`${participant.identity} started the meeting`);
          syncCast();
        }
        if (message.requestId !== undefined) {
          publishState({ kind: 'started', requestId: message.requestId, session });
        }
      } else if (message.kind === 'stop') {
        if (!started && !hostIsHuman()) {
          log('ignored stop: the meeting has not started');
          return;
        }
        paused = true;
        options.onPauseChange?.(true);
        talking.clear();
        for (const vad of vads.values()) vad.close();
        log(`${participant.identity} pressed stop`);
        conversation?.stop();
      } else if (message.kind === 'resume') {
        if (!started && !hostIsHuman()) {
          log('ignored resume: the meeting has not started');
          return;
        }
        paused = false;
        options.onPauseChange?.(false);
        log(`${participant.identity} pressed resume`);
        conversation?.resumeFromPause();
      } else if (!started && !hostIsHuman()) {
        log('ignored typed text: the meeting has not started');
      } else {
        if (paused) {
          paused = false;
          options.onPauseChange?.(false);
        }
        typingUntil = Date.now() + TYPING_QUIET_MS;
        conversation?.humanTyped(message.text);
      }
      return;
    }
    if (topic !== STT_TOPIC || participant === undefined || npcNames.has(participant.identity)) return;
    // With server-side recognition the browser's text is not used: it hears the speakers, not the echo-cancelled track.
    if (options.recognizer !== undefined) return;
    try {
      const message = JSON.parse(new TextDecoder().decode(payload)) as { text?: unknown };
      if (typeof message.text === 'string' && meetingOpen()) conversation?.humanText(message.text);
    } catch {
      log('ignored a malformed speech message');
    }
  });
  room.on(RoomEvent.Disconnected, () => {
    if (closing) return;
    log('lost the connection to LiveKit');
    options.onDisconnected?.();
  });
  for (const participant of room.remoteParticipants.values()) registerHuman(participant);

  function announce(text: string, onDone?: (spoken: boolean) => void, shouldStillSpeak?: () => boolean): void {
    if (hostName === undefined || conversation === undefined) return;
    const isWelcome = text.startsWith(OPENING_PREFIX);
    // The welcome was already spoken when the person arrived; the host cue that follows the first line is not said again.
    if (isWelcome && welcomed) return;
    // The welcome waits for Start: a host cue that arrives earlier (for example from words said before it) must not open the meeting.
    if (isWelcome && !meetingOpen()) return;
    // The welcome is rebuilt for the person in the room: their own name and role, not the seat's scripted name.
    const person = [...humans.values()].at(-1);
    const visitor = person?.seat !== undefined ? { name: person.name, seat: person.seat } : undefined;
    const isNextUp = text.startsWith('Next up:');
    const nextTitle = isNextUp ? text.replace(/^Next up:\s*/, '').replace(/\.$/, '') : undefined;
    let spoken =
      isWelcome && visitor !== undefined
        ? liveOpeningLine(scenario, visitor)
        : isNextUp && nextTitle !== undefined
          ? liveNextItemLine(scenario, nextTitle, visitor)
          : text;
    if (!isWelcome && !isNextUp && visitor !== undefined && visitor.seat !== visitor.name) {
      const escapedSeat = visitor.seat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      spoken = spoken.replace(new RegExp(`\\b${escapedSeat}\\b`, 'g'), visitor.name);
    }
    const isTaskDispatch = /\b(?:Accept or decline it on your phone|Have a look on your phone and accept or decline|It's on your phone)\./i.test(spoken);
    if (isTaskDispatch) {
      const personName = person?.name;
      visitorTaskDispatches += 1;
      if (personName !== undefined) {
        spoken =
          visitorTaskDispatches === 1
            ? `${personName}, I've put that follow-up on your screen on the right — take a look, you can have Kaki draft it for you or adjust it.`
            : `${personName}, I've queued that next follow-up on your screen on the right to review and confirm.`;
      } else {
        const guidance =
          visitorTaskDispatches === 1
            ? "I've put that follow-up on your screen on the right — take a look, you can have Kaki draft it for you or adjust it."
            : "Have a look on your screen on the right to review and confirm.";
        spoken = spoken
          .replace(/\bAccept or decline it on your phone\./gi, guidance)
          .replace(/\bHave a look on your phone and accept or decline\./gi, guidance)
          .replace(/\bIt's on your phone\./gi, guidance);
      }
    }
    const timeoutMatch =
      /^Time is up on (.+?)\. Keep going, or move on to (.+?)\?$/i.exec(spoken.trim()) ??
      /^(.+?) is at (\d+) minutes, please wrap up\.$/i.exec(spoken.trim()) ??
      /^Hey team, we're a bit past time on (.+?) — let's wrap this one up so we can move on\.$/i.exec(spoken.trim());
    if (timeoutMatch !== null) {
      const personName = person?.name;
      const itemTitle = spokenTopicLead(timeoutMatch[1] ?? 'this item');
      spoken =
        personName !== undefined
          ? `${personName}, we're a bit past time on ${itemTitle} — do you want another minute on this, or should we make a decision and keep moving?`
          : `We're a bit past time on ${itemTitle} — should we take another minute on this, or make a decision and keep moving?`;
    }
    if (isWelcome) welcomed = true;
    // After the welcome, the first agenda item begins: the person is asked, or the characters start talking it through.
    conversation.announce(
      hostName,
      spoken,
      undefined,
      isWelcome
        ? (wasSpoken) => {
            conversation?.agendaMoved(scenario.agenda[0]?.title);
            onDone?.(wasSpoken);
          }
        : onDone,
      shouldStillSpeak,
    );
  }
  function hostIsHuman(): boolean {
    return hostProfile !== undefined && [...humans.values()].some((person) => person.seat === hostProfile.attendee);
  }

  return {
    announce,
    plays(attendee) {
      return conversation?.plays(attendee) ?? false;
    },
    canDispatchTask() {
      return conversation?.canDispatchTask() ?? true;
    },
    hostIsHuman,
    agendaMoved(title) {
      conversation?.agendaMoved(title);
    },
    taskAccepted(originAgendaTitle) {
      conversation?.taskAccepted(originAgendaTitle);
    },
    holdForHumanTask(holdMs, originAgendaTitle) {
      conversation?.holdForHumanTask(holdMs, originAgendaTitle);
    },
    cancelPendingDispatch(originAgendaTitle) {
      conversation?.cancelPendingDispatch(originAgendaTitle);
    },
    completeHumanTask(originAgendaTitle) {
      conversation?.completeHumanTask(originAgendaTitle);
    },
    onCurrentAgenda(title) {
      return conversation?.onCurrentAgenda(title) ?? false;
    },
    visitorName() {
      return [...humans.values()].at(-1)?.name;
    },
    say(attendee, text, onDone) {
      if (conversation === undefined) {
        onDone?.();
        return;
      }
      conversation.announce(attendee, text, undefined, () => onDone?.());
    },
    pause() {
      paused = true;
      talking.clear();
      for (const vad of vads.values()) vad.close();
      conversation?.stop();
    },
    announceClosing(text) {
      if (hostName === undefined || conversation === undefined) return;
      paused = true;
      talking.clear();
      for (const vad of vads.values()) vad.close();
      conversation.announceClosing(hostName, text);
    },
    async stop() {
      closing = true;
      if (guardTimer !== undefined) clearTimeout(guardTimer);
      if (humanSpeakingTimer !== undefined) clearTimeout(humanSpeakingTimer);
      await castQueue;
      conversation?.close();
      for (const vad of vads.values()) vad.close();
      await leaveAll();
    },
  };
}
