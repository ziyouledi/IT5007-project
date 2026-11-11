import { itemMode, type NpcStateMessage, type Scenario } from '@kaki/shared';
import type { ChatMessage } from '../llm';
import { cleanSpokenTopic } from '../host/opening';
import { addressedCharacter, buildSystemPrompt, findHandover, HandoverGuard, responsibilityFor, TurnParser, type HumanInfo, type Utterance } from './director';
import { assessProposal, GREETING_OR_FILLER, isSideRequest, isSubstantiveProposal, type ProposalAssessment, type ResolvedTradeOff } from './proposal';
import { SpeechGate } from './speechGate';

/** What the people in the meeting should see the AI attendees doing. */
export type NpcUiState = NpcStateMessage;

/** Everything the conversation needs from the outside world; tests replace all of it. */
export interface NpcPorts<Clip> {
  /** Stream the Director's reply; must stop promptly when `signal` aborts. */
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  /** Turn a sentence into audio. */
  synthesize(utterance: Utterance, signal: AbortSignal): Promise<Clip>;
  /** Play a clip as `speaker`. Resolves when it finished, or straight after `signal` aborts and the sound has stopped. */
  play(speaker: string, clip: Clip, signal: AbortSignal): Promise<void>;
  /** A line spoken in the meeting, for Kaki's transcript. */
  emitTranscript(speaker: string, text: string): void;
  /** What the AI attendees are doing, for the screen. */
  emitState(state: NpcUiState): void;
  log?(message: string): void;
  /** What the person's microphone has been hearing, to explain a refused phrase. */
  describeMic?(): string | undefined;
  /** Move the meeting to the next agenda item once an observe-only item has been talked through. */
  advanceAgenda?(): void;
  /** Wrap up the meeting once the final agenda item is complete. */
  endMeeting?(): void;
  /** Emit a live 1-sentence Wingman coaching brief when the visitor's turn updates the discussion state. */
  onWingmanTip?(tip: string, title: string): void;
}

/** Quiet needed after the person stops talking before the AI answers; on top of the voice detector's own hangover. */
export const DEFAULT_RESPONSE_DELAY_MS = 300;

/** Pause when one character finishes and a different one starts, so it sounds like people taking turns. */
export const DEFAULT_SPEAKER_GAP_MS = 900;
/** Pause between two sentences of the same speaker, so they do not run together. */
export const DEFAULT_SENTENCE_GAP_MS = 400;

/** The person cut an AI attendee off but said nothing recognisable; they carry on after this long. */
export const DEFAULT_RESUME_MS = 1800;

/** When speech recognition reports that a cut-in held no words, the AI carries on after this long. */
export const DEFAULT_NOTHING_MS = 400;

/** An answer cancelled before anything was said, with nothing new from the person, is retried after this long. */
export const DEFAULT_RETRY_MS = 1500;

/** How many times in a row the AI may pass the turn to another character without the person saying anything. */
export const MAX_FOLLOW_UPS = 2;

/** How long a Host cue waits for a quiet moment before it is dropped as out of date. */
export const DEFAULT_ANNOUNCE_GIVE_UP_MS = 40_000;


/** The host asks when the agenda moves on; if that never happens, after this many lines from the person. */
export const ASK_BACKSTOP_LINES = 8;
/** How long after the host announces the next item before the question (the announcement is spoken first). */
export const DEFAULT_ASK_DELAY_MS = 3000;
/** How long after an item opens, with the person silent, before the characters start talking it through. */
export const DEFAULT_OBSERVE_DELAY_MS = 1500;
/** How long after the characters finish talking through an observe-only item before moving to the next item. */
export const DEFAULT_OBSERVE_ADVANCE_MS = 8500;
/** How long the room waits in silence on the person's item before the host gently checks in by name. */
export const DEFAULT_SILENCE_PROMPT_MS = 28_000;
/** The question waits for a quiet moment; it is dropped if the room stays busy this long. */
const ASK_GIVE_UP_MS = 45_000;

/** How long the person must keep talking over the room before it stops; a shorter burst is probably noise or an echo. */
export const DEFAULT_BARGE_IN_MS = 1400;

/** Short listener backchannels ("Oh.", "So.", "Cool.") spoken while an AI colleague is mid-turn should not abort the colleague's turn. */
const LISTENER_BACKCHANNEL_WHILE_SPEAKING_RE =
  /^(?:oh|ah|uh-huh|mm-hmm|mhm|mm|hmm|so|cool|nice|wow|i see|gotcha)[,.!?\s]*$/i;

function splitSentences(text: string): string[] {
  return (
    text
      .split(/(?<=(?:(?<!\b(?:Prof|Dr|Mr|Mrs|Ms|St|Jr|Sr))[.!?…])["')\]]*)\s+/i)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  );
}

export interface ConversationOptions {
  observeDelayMs?: number;
  observeAdvanceMs?: number;
  silencePromptMs?: number;
  bargeInMs?: number;
  /** Pause after an agenda announcement before the host asks the person for their decision. */
  askDelayMs?: number;
  scenario: Scenario;
  /** Quiet needed after the person's last words before the AI answers. */
  responseDelayMs?: number;
  /** Pause between one character and the next (see {@link DEFAULT_SPEAKER_GAP_MS}). */
  speakerGapMs?: number;
  /** Pause between two sentences of the same speaker (see {@link DEFAULT_SENTENCE_GAP_MS}). */
  sentenceGapMs?: number;
  /** See {@link DEFAULT_RETRY_MS}. */
  retryMs?: number;
  /** See {@link DEFAULT_RESUME_MS}. */
  resumeMs?: number;
  /** How many past messages the Director sees. */
  maxHistory?: number;
  gate?: SpeechGate;
}

interface Turn {
  abort: AbortController;
  spoken: Array<{ utterance: Utterance; complete: boolean }>;
  enqueued: Utterance[];
  streamFinished: boolean;
  aborted: boolean;
  finalized: boolean;
  done: Promise<void>;
  startedAt: number;
  firstSentenceAt?: number;
  /** A line the Host was told to say (an opening, a time-out, a closing), not an answer to the person. */
  scripted?: boolean;
  scriptedUtterance?: Utterance;
  onScriptedDone?: (spoken: boolean) => void;
  /** A follow-up after a hand-over: this character answers first. */
  forced?: { target: string; from: string };
  /** This turn is the single retry after the model failed before saying anything. */
  recoveryRetry?: boolean;
}

/** Minimal async queue so playback can start on the first sentence while the rest is written. */
class SentenceQueue<Item> implements AsyncIterable<Item> {
  private items: Item[] = [];
  private waiting: Array<() => void> = [];
  private closed = false;

  push(item: Item): void {
    if (this.closed) return;
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Item> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
      } else if (this.closed) {
        return;
      } else {
        await new Promise<void>((resolve) => this.waiting.push(resolve));
      }
    }
  }
}

/**
 * The AI attendees' conversation with one person, as a small state machine:
 *
 *   idle -> (person finishes speaking) -> thinking -> speaking -> idle
 *
 * and from thinking or speaking, the person starting to talk drops straight back to listening.
 * One turn exists at a time; each has its own abort controller, which stops the model, the
 * synthesis and the sound together. The history records only what the person actually heard.
 */
export class NpcConversation<Clip> {
  private readonly gate: SpeechGate;
  private readonly names: string[];
  private readonly responseDelayMs: number;
  private readonly speakerGapMs: number;
  private readonly sentenceGapMs: number;
  private readonly retryMs: number;
  private readonly resumeMs: number;
  /** The person cut something off that was being said aloud, and nothing recognisable has followed. */
  private cutOff = false;
  /** The last thing the person said was cut off before any answer was spoken. */
  private unanswered = false;
  private lastText = '';
  private readonly maxHistory: number;
  private history: ChatMessage[] = [];
  private human: (HumanInfo & { transcriptName: string }) | undefined;
  private pending: string[] = [];
  /**Lines the person has said (heard or typed) since they joined; the host asks them for their decision after a few. */
  private humanLines = 0;
  /** The current item is settled: the visitor made a complete proposal the readiness check accepted. */
  private humanSettledOnCurrentItem = false;
  /** The readiness check for the latest visitor proposal, if it ran. */
  private proposalAssessment: ProposalAssessment | undefined;
  /** The exact visitor line the current assessment belongs to, so a retry does not assess twice. */
  private assessedText: string | undefined;
  /** Substantive proposal lines the visitor has spoken on the current item, oldest first. */
  private proposalLines: string[] = [];
  /** Trade-offs already settled by those proposal lines on the current item. */
  private resolvedTradeOffs: ResolvedTradeOff[] = [];
  private hadDecisionBeforeMove = false;
  private movedAt = 0;
  /** People the host has already asked, by name. */
  private readonly asked = new Set<string>();
  /** The agenda has moved on and the host has not asked this person yet. */
  private askDue = false;
    /** Speakers who have already spoken at least once in this meeting, so newcomers introduce themselves on their very first turn. */
  private readonly introduced = new Set<string>();
  /** Items where the AI colleagues have already briefed the room before asking the human for a decision. */
  private readonly briefed = new Set<string>();
  /** Items the characters have already talked through on their own, and how many lines the person had said when this item began. */
  private readonly observed = new Set<string>();
  /** Items whose observe turn already requested an agenda advance. */
  private readonly advanced = new Set<string>();
  private linesAtMove = 0;
  /** The agenda item the meeting is on now (the first until the host announces another). */
  private agendaItem: string | undefined;
  private humanTalking = false;
  private recognizingSpeech = false;
  private recognizingTimer: ReturnType<typeof setTimeout> | undefined;
  private respondTimer: ReturnType<typeof setTimeout> | undefined;
  private turn: Turn | undefined;
  private closed = false;
  private concluded = false;
  private paused = false;
  private pausedCutOff = false;
  private cutOffSpeaker: string | undefined;
  private pausedUtterances: Utterance[] | undefined;
  private pausedScripted: { utterance: Utterance; onDone?: (spoken: boolean) => void } | undefined;
  /** Host cues waiting for a quiet moment to play. */
  private pendingAnnouncements = 0;
  /** Consecutive follow-up turns the AI started by itself after a hand-over; the person speaking again resets it. */
  private chain = 0;
  private forcedSpeaker: { target: string; from: string } | undefined;
  private decisionWrappedUpOnItem = false;
  private refusalCount = 0;
  /** Integrations already recommended on earlier agenda items in this session so Topic 2 showcases fresh platforms. */
  private readonly usedActionKinds = new Set<string>();

  constructor(
    private readonly ports: NpcPorts<Clip>,
    private readonly options: ConversationOptions,
  ) {
    this.gate = options.gate ?? new SpeechGate();
    this.names = (options.scenario.npcs ?? []).map((npc) => npc.attendee);
    this.responseDelayMs = options.responseDelayMs ?? DEFAULT_RESPONSE_DELAY_MS;
    this.speakerGapMs = options.speakerGapMs ?? DEFAULT_SPEAKER_GAP_MS;
    this.sentenceGapMs = options.sentenceGapMs ?? DEFAULT_SENTENCE_GAP_MS;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.resumeMs = options.resumeMs ?? DEFAULT_RESUME_MS;
    this.maxHistory = options.maxHistory ?? 30;
    if (this.names.length === 0) throw new Error(`Scenario "${options.scenario.id}" has no npcs`);
    const hostName = (options.scenario.npcs ?? []).find((npc) => npc.role === 'host')?.attendee;
    if (hostName !== undefined) {
      this.introduced.add(hostName);
    }
  }

  /** Who the AI attendees are talking to; `transcriptName` is how Kaki's transcript labels them. */
  setHuman(human: HumanInfo & { transcriptName?: string }): void {
    if (this.human?.name !== human.name) this.humanLines = 0;
    this.human = { ...human, transcriptName: human.transcriptName ?? human.name };
  }

  /** The last sentence the room said, if it was a question: then it is the person's turn, and the screen says so. */
  private lastSpoken = '';
  private lastTranscriptEmit = '';
  private wingmanHintActive = false;

  private idleState(): NpcUiState {
    const line = this.lastSpoken.trim();
    const hint = this.wingmanHintActive ? { wingmanHint: true } : {};
    return line.endsWith('?') ? { kind: 'idle', yourTurn: line, ...hint } : { kind: 'idle', ...hint };
  }

  /** True while the AI is thinking or speaking. */
  get busy(): boolean {
    return this.turn !== undefined;
  }

  /** The person typed something: it goes straight in, with no check that it is a voice and not an echo. */
  humanTyped(text: string): void {
    const typed = text.trim();
    if (this.closed || this.concluded || typed.length === 0) return;
    this.paused = false;
    this.pausedCutOff = false;
    this.pausedUtterances = undefined;
    const abandonedScripted = this.pausedScripted;
    this.pausedScripted = undefined;
    abandonedScripted?.onDone?.(false);
    this.ports.log?.(`typed "${typed}"`);
    this.chain = 0;
    this.bridgedStatementOnTurn = false;
    this.lastSpoken = '';
    this.lastTranscriptEmit = '';
    this.ports.emitTranscript(this.human?.transcriptName ?? 'Guest', typed);
    this.pending.push(typed);
    this.noteHumanLine(typed);
    this.interrupt('the person typed something');
    this.unanswered = false;
    this.cutOff = false;
    this.scheduleRespond();
  }

  /** The person pressed Stop/Pause: everyone goes quiet and timers are held until they press Resume (or type). */
  stop(): void {
    if (this.closed || this.concluded || this.paused) return;
    if (this.turn !== undefined) {
      if (this.turn.scripted === true && this.turn.scriptedUtterance !== undefined) {
        const allSentences = splitSentences(this.turn.scriptedUtterance.text);
        const completedCount = this.turn.spoken.filter((entry) => entry.complete).length;
        const remaining = allSentences.slice(completedCount).join(' ').trim();
        if (remaining.length > 0) {
          this.pausedScripted = {
            utterance: { speaker: this.turn.scriptedUtterance.speaker, text: remaining },
            onDone: this.turn.onScriptedDone,
          };
          this.turn.onScriptedDone = undefined;
        }
      } else {
        const completedCount = this.turn.spoken.filter((entry) => entry.complete).length;
        const remaining = this.turn.enqueued.slice(completedCount);
        if (this.turn.streamFinished && remaining.length > 0) {
          this.pausedUtterances = remaining;
        } else {
          this.pausedCutOff = true;
          this.cutOffSpeaker = remaining[0]?.speaker ?? this.turn.spoken.at(-1)?.utterance.speaker;
        }
      }
    }
    this.paused = true;
    this.humanTalking = false;
    this.humanRecognizing(false);
    this.gate.setHumanTalking(false);
    this.clearBargeTimer();
    this.clearRespondTimer();
    this.clearAdvanceTimer();
    this.clearSilenceTimer();
    this.clearBriefTimer();
    this.clearObserveTimer();
    this.clearDeferredFollowUpTimer();
    this.pending = [];
    this.interrupt('the person pressed stop');
    this.unanswered = false;
    this.cutOff = false;
  }

  /** The person pressed Resume after pausing: pick back up where the room left off. */
  resumeFromPause(): void {
    if (this.closed || this.concluded || !this.paused) return;
    this.paused = false;
    const scripted = this.pausedScripted;
    this.pausedScripted = undefined;
    const utterances = this.pausedUtterances;
    this.pausedUtterances = undefined;
    const wasCutOff = this.pausedCutOff;
    this.pausedCutOff = false;
    const speaker = this.cutOffSpeaker;
    this.cutOffSpeaker = undefined;
    if (scripted !== undefined) {
      this.startScripted(scripted.utterance, scripted.onDone);
      return;
    }
    if (utterances !== undefined && utterances.length > 0) {
      this.startReplayTurn(utterances);
      return;
    }
    const item = this.currentItem();
    if (wasCutOff) {
      const who = this.human?.name ?? 'The person';
      const speakerHint =
        speaker !== undefined ? ` Begin your reply with "${speaker}:" so ${speaker} finishes their thought first.` : '';
      if (speaker !== undefined) this.forcedSpeaker = { target: speaker, from: speaker };
      this.lastText = `[${who} unpaused the meeting. Carry on from where you left off, briefly, without mentioning the pause.${speakerHint}]`;
      this.history.push({ role: 'user', content: this.lastText });
      this.startTurn(true);
      return;
    }
    if (this.mode() === 'observe' && item !== undefined) {
      if (!this.observed.has(item.title)) this.observeLater(item.title, 0);
      else this.scheduleObserveAdvance();
      return;
    }
    if (item !== undefined && this.names.length > 2 && !this.briefed.has(item.title)) {
      this.briefLater(item.title, 0);
      return;
    }
    if (this.askDue) {
      this.ask();
      return;
    }
    this.scheduleSilencePrompt();
  }

  /** The person is pressing keys in the chat input: push back any active silence timer so nobody cuts in while they type. */
  humanTyping(): void {
    if (this.closed || this.concluded || this.paused) return;
    if (this.silenceTimer !== undefined) {
      this.scheduleSilencePrompt();
    }
  }

  /** Speech-to-text is currently transcribing a finished stretch of the person's microphone audio. */
  humanRecognizing(active: boolean): void {
    if (this.recognizingTimer !== undefined) {
      clearTimeout(this.recognizingTimer);
      this.recognizingTimer = undefined;
    }
    this.recognizingSpeech = active && !this.closed && !this.concluded;
    if (this.recognizingSpeech) {
      this.clearSilenceTimer();
      this.recognizingTimer = setTimeout(() => {
        this.recognizingTimer = undefined;
        this.recognizingSpeech = false;
      }, 4_500);
      this.recognizingTimer.unref?.();
    }
  }

  /** Speech recognition heard nothing in the last stretch of the person's microphone: it was not words. */
  humanNothing(): void {
    this.humanRecognizing(false);
    if (this.closed || this.concluded || this.paused || this.humanTalking || this.pending.length > 0) return;
    if (!(this.cutOff || this.unanswered)) {
      if (this.turn === undefined && this.respondTimer === undefined && this.advanceTimer === undefined && !this.decisionWrappedUpOnItem) {
        this.scheduleSilencePrompt();
      }
      return;
    }
    this.clearRespondTimer();
    this.respondTimer = setTimeout(() => {
      this.respondTimer = undefined;
      if (this.closed || this.concluded || this.paused || this.humanTalking || this.pending.length > 0) return;
      if (this.cutOff) this.resume();
      else if (this.unanswered) this.startTurn(true);
    }, DEFAULT_NOTHING_MS);
  }

  /** The person's microphone started or stopped carrying speech. */
  humanSpeech(talking: boolean): void {
    if (this.closed || this.concluded || this.paused) return;
    if (talking === this.humanTalking) {
      // Should not happen: a start while already marked talking, with an answer running, means a stop was missed.
      if (talking && this.turn !== undefined) this.ports.log?.('ignored the person starting to talk: already marked as talking, a stop was missed');
      return;
    }
    this.humanTalking = talking;
    this.gate.setHumanTalking(talking);
    if (talking) {
      this.clearRespondTimer();
      this.clearSilenceTimer();
      if (this.turn === undefined) return;
      // The microphone can pick up the room's own voice or a noise for a moment. Stopping the speaker for that makes it
      // stutter and start again, so it is only cut off once the person has kept talking a while; a shorter burst waits for
      // recognised words (`humanText` interrupts then), and carries on if there were none.
      this.clearBargeTimer();
      const baseWaitMs = this.options.bargeInMs ?? DEFAULT_BARGE_IN_MS;
      const waitMs = baseWaitMs;
      if (waitMs <= 0) {
        this.interrupt('the person started talking');
        return;
      }
      this.bargeTimer = setTimeout(() => {
        this.bargeTimer = undefined;
        if (this.humanTalking && !this.closed) this.interrupt('the person kept talking');
      }, waitMs);
    } else {
      this.clearBargeTimer();
      this.scheduleRespond();
    }
  }

  /** The browser recognised some of the person's words. */
  humanText(text: string): void {
    this.humanRecognizing(false);
    const heard = text.trim();
    if (this.closed || this.concluded || heard.length === 0) return;
    if (this.paused) {
      this.ports.log?.(`ignored "${heard}": the meeting is paused`);
      return;
    }

    const decision = this.gate.check(heard);
    if (!decision.ok) {
      const mic = this.ports.describeMic?.();
      this.ports.log?.(`ignored "${heard}" (${decision.reason}${mic === undefined ? '' : `; ${mic}`})`);
      return;
    }

    const accepted = decision.text ?? heard;
    if (this.turn !== undefined && LISTENER_BACKCHANNEL_WHILE_SPEAKING_RE.test(accepted)) {
      this.ports.log?.(`ignored listener backchannel "${accepted}" while an AI colleague is speaking`);
      return;
    }
    this.paused = false;
    this.pausedCutOff = false;
    this.pausedUtterances = undefined;
    const abandonedScripted = this.pausedScripted;
    this.pausedScripted = undefined;
    abandonedScripted?.onDone?.(false);
    if (decision.text !== undefined) {
      this.ports.log?.(`heard "${accepted}" (cut the AI's own words "${decision.removed ?? ''}" out of "${heard}")`);
    } else {
      this.ports.log?.(`heard "${accepted}"`);
    }
    this.lastSpoken = '';
    this.lastTranscriptEmit = '';
    this.ports.emitTranscript(this.human?.transcriptName ?? 'Guest', accepted);
    this.chain = 0;
    this.bridgedStatementOnTurn = false;
    this.clearSilenceTimer();
    this.pending.push(accepted);
    this.noteHumanLine(accepted);
    // The voice detector normally got here first; this covers a quiet person it missed.
    this.interrupt('the person said something');
    this.unanswered = false;
    this.cutOff = false;
    this.scheduleRespond();
  }

  /**
   * The Host's spoken cue (opening, time-out, closing): `speaker` says `text` aloud, with no model call.
   * It waits for a quiet moment, so it never talks over the person or an answer, and is dropped if the
   * room stays busy for `giveUpMs`. It becomes a transcript line when it starts to play, like anything else a character says,
   * so the feed shows it in the order it is heard.
   * The person talking over it stops it, as with any other speech.
   */
  announce(
    speaker: string,
    text: string,
    giveUpMs = DEFAULT_ANNOUNCE_GIVE_UP_MS,
    onDone?: (spoken: boolean) => void,
    shouldStillSpeak?: () => boolean,
  ): void {
    const line = text.trim();
    if (this.closed || line.length === 0 || !this.names.includes(speaker)) return;
    if (shouldStillSpeak !== undefined && !shouldStillSpeak()) {
      this.ports.log?.(`skipped ${speaker}'s cue "${line}": already handled`);
      onDone?.(false);
      return;
    }
    this.pendingAnnouncements += 1;
    let deadline = Date.now() + giveUpMs;
    const attempt = (): void => {
      if (this.closed) {
        this.pendingAnnouncements = Math.max(0, this.pendingAnnouncements - 1);
        return;
      }
      if (shouldStillSpeak !== undefined && !shouldStillSpeak()) {
        this.pendingAnnouncements = Math.max(0, this.pendingAnnouncements - 1);
        this.ports.log?.(`skipped ${speaker}'s cue "${line}": already handled`);
        onDone?.(false);
        return;
      }
      if (this.paused) {
        deadline += 500;
        setTimeout(attempt, 500);
        return;
      }
      const busy =
        this.cutOff ||
        this.unanswered ||
        this.humanTalking ||
        this.recognizingSpeech ||
        this.turn !== undefined ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined;
      if (!busy) {
        this.pendingAnnouncements = Math.max(0, this.pendingAnnouncements - 1);
        this.startScripted({ speaker, text: line }, onDone);
      } else if (Date.now() >= deadline) {
        this.pendingAnnouncements = Math.max(0, this.pendingAnnouncements - 1);
        this.ports.log?.(`dropped ${speaker}'s cue "${line}": the room stayed busy`);
        onDone?.(false);
      } else {
        setTimeout(attempt, 500);
      }
    };
    attempt();
  }

  /**
   * Whether an origin token refers to the item the meeting is on. `undefined` means the conversation itself
   * is speaking for the current topic; `null` means an external task with no recorded origin, which must
   * never move or hold the current topic.
   */
  private originIsCurrent(origin: string | null | undefined): boolean {
    if (origin === undefined) return true;
    if (origin === null) return false;
    const current = this.currentItem()?.title;
    if (current === undefined) return false;
    return origin === current || cleanSpokenTopic(origin).toLowerCase() === cleanSpokenTopic(current).toLowerCase();
  }

  /** True when `title` names the item the meeting is on now; external task events use this to stay on their own topic. */
  onCurrentAgenda(title: string | undefined): boolean {
    if (title === undefined) return false;
    const current = this.currentItem()?.title;
    if (current === undefined) return false;
    return title === current || cleanSpokenTopic(title).toLowerCase() === cleanSpokenTopic(current).toLowerCase();
  }

  /** If the host is currently speaking a task-dispatch prompt and the visitor just clicked Accept/Decline, stop that prompt immediately. */
  cancelPendingDispatch(origin?: string | null): void {
    if (!this.originIsCurrent(origin)) return;
    if (
      this.turn?.scripted === true &&
      /\b(?:sent you a task|this one is yours|can you take on|Kaki panel on the right|your screen on the right)\b/i.test(
        this.turn.scriptedUtterance?.text ?? '',
      )
    ) {
      this.interrupt('visitor already handled the task');
    }
  }

  /** Interrupt any running AI turn, speak `text` aloud from `speaker` without transcribing it, and then pause the conversation. */
  announceClosing(speaker: string, text: string): void {
    const line = text.trim();
    if (this.closed || this.concluded || line.length === 0 || !this.names.includes(speaker)) return;
    this.stop();
    this.concluded = true;
    this.paused = false;
    this.pausedCutOff = false;
    this.pausedUtterances = undefined;
    this.pausedScripted = undefined;
    const turn: Turn = {
      abort: new AbortController(),
      spoken: [],
      enqueued: [],
      streamFinished: true,
      aborted: false,
      finalized: false,
      done: Promise.resolve(),
      startedAt: Date.now(),
      scripted: true,
      scriptedUtterance: { speaker, text: line },
    };
    this.turn = turn;
    const { signal } = turn.abort;
    const queue = new SentenceQueue<{ utterance: Utterance; clip: Promise<Clip | undefined> }>();
    signal.addEventListener('abort', () => queue.close(), { once: true });
    const player = this.playAll(turn, queue, false);
    for (const sentence of splitSentences(line)) {
      const item: Utterance = { speaker, text: sentence };
      const clip = this.ports.synthesize(item, signal).catch(() => undefined);
      queue.push({ utterance: item, clip });
    }
    queue.close();
    turn.done = player.then(() => {
      this.turn = undefined;
      this.gate.setAiAudible(false);
      this.ports.emitState(this.idleState());
      this.paused = true;
    });
  }

  /** True while `speaker` is a character this conversation voices. */
  plays(speaker: string): boolean {
    return !this.closed && this.names.includes(speaker);
  }

  /** True when the visitor has settled a decision on the current agenda item (or the item is observe-only). */
  canDispatchTask(): boolean {
    const withinPreviousDecisionGrace =
      this.hadDecisionBeforeMove && Date.now() - this.movedAt < 3_500;
    return (
      !this.closed &&
      (this.mode() === 'observe' ||
        this.humanSettledOnCurrentItem ||
        this.decisionWrappedUpOnItem ||
        withinPreviousDecisionGrace)
    );
  }

  /** Resolves when no turn is running. */
  async settled(): Promise<void> {
    while (this.turn !== undefined) await this.turn.done;
  }

  close(): void {
    this.closed = true;
    this.humanRecognizing(false);
    this.clearRespondTimer();
    this.clearBargeTimer();
    this.clearAdvanceTimer();
    this.clearSilenceTimer();
    this.clearBriefTimer();
    this.clearObserveTimer();
    this.clearDeferredFollowUpTimer();
    this.interrupt('the meeting ended');
  }

  private bargeTimer: ReturnType<typeof setTimeout> | undefined;
  private advanceTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private briefTimer: ReturnType<typeof setTimeout> | undefined;
  private observeTimer: ReturnType<typeof setTimeout> | undefined;
  private deferredFollowUpTimer: ReturnType<typeof setTimeout> | undefined;
  private silencePromptStage = 0;
  private bridgedStatementOnTurn = false;

  private clearBargeTimer(): void {
    if (this.bargeTimer !== undefined) clearTimeout(this.bargeTimer);
    this.bargeTimer = undefined;
  }

  private clearAdvanceTimer(): void {
    if (this.advanceTimer !== undefined) clearTimeout(this.advanceTimer);
    this.advanceTimer = undefined;
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== undefined) clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
  }

  private clearBriefTimer(): void {
    if (this.briefTimer !== undefined) clearTimeout(this.briefTimer);
    this.briefTimer = undefined;
  }

  private clearObserveTimer(): void {
    if (this.observeTimer !== undefined) clearTimeout(this.observeTimer);
    this.observeTimer = undefined;
  }

  private clearDeferredFollowUpTimer(): void {
    if (this.deferredFollowUpTimer !== undefined) clearTimeout(this.deferredFollowUpTimer);
    this.deferredFollowUpTimer = undefined;
  }

  private clearRespondTimer(): void {
    if (this.respondTimer !== undefined) clearTimeout(this.respondTimer);
    this.respondTimer = undefined;
  }

  private scheduleRespond(): void {
    if (this.humanTalking || this.paused) return;
    if (this.pending.length === 0) {
      // The person cut in but no words came (a cough, a click, a word the recogniser missed): carry on.
      if (this.cutOff && !this.closed) {
        this.clearRespondTimer();
        this.respondTimer = setTimeout(() => {
          this.respondTimer = undefined;
          if (!this.humanTalking && !this.closed && !this.paused && this.cutOff && this.pending.length === 0) this.resume();
        }, this.resumeMs);
        return;
      }
      // Something cut the answer off (a cough, a click) and the person said nothing more: answer anyway.
      if (this.unanswered && !this.closed) {
        this.clearRespondTimer();
        this.respondTimer = setTimeout(() => {
          this.respondTimer = undefined;
          if (!this.humanTalking && !this.closed && !this.paused && this.unanswered && this.pending.length === 0) this.startTurn(true);
        }, this.retryMs);
      }
      return;
    }
    this.clearRespondTimer();
    this.respondTimer = setTimeout(() => {
      this.respondTimer = undefined;
      if (!this.humanTalking && !this.closed && !this.paused) this.startTurn();
    }, this.responseDelayMs);
  }

  /**
   * The AI host (or NPC co-host when a human plays the host seat) asks a person directly, once, for the call their role owns:
   * it comes when the meeting moves to the next agenda item (`agendaMoved`), or, as a backstop, after many lines from them.
   */
  private facilitatorOrCoHost(): string | undefined {
    const npcs = this.options.scenario.npcs ?? [];
    const host = npcs.find((npc) => npc.role === 'host')?.attendee;
    if (host !== undefined && this.names.includes(host)) return host;
    const opsDirector = npcs.find((npc) => {
      const role = this.options.scenario.attendees.find((a) => a.name === npc.attendee)?.role;
      return role === 'producer' && this.names.includes(npc.attendee);
    })?.attendee;
    return opsDirector ?? this.names[0];
  }

  private askLine(): string | undefined {
    const human = this.human;
    if (human === undefined || this.asked.has(human.name) || this.mode() === 'observe') return undefined;
    const host = this.facilitatorOrCoHost();
    const owns = responsibilityFor(this.options.scenario, human);
    if (host === undefined || owns === undefined) return undefined;
    this.asked.add(human.name);
    this.askDue = false;
    const decision = this.options.scenario.agenda.find((item) => item.title === (this.agendaItem ?? this.options.scenario.agenda[0]?.title))?.decision;
    if (/decide/i.test(owns) && decision !== undefined) return `${human.name}, ${decision}`;
    return `${human.name}, as ${human.role}, what's your take?`;
  }

  private ask(): void {
    const line = this.askLine();
    const host = this.facilitatorOrCoHost();
    if (line !== undefined && host !== undefined) this.announce(host, line, ASK_GIVE_UP_MS);
  }

  /** The person said another line: ask if they have talked a long time without being asked. */
  private noteHumanLine(text = ''): void {
    const currentTitle = this.currentItem()?.title;
    if (
      currentTitle !== undefined &&
      !this.briefed.has(currentTitle) &&
      this.names.length > 2 &&
      GREETING_OR_FILLER.test(text.trim())
    ) {
      // A short greeting or acknowledgement ("Hello", "OK", "Sure") while the room is transitioning to a new item
      // must not cancel the colleagues' opening briefing on that item.
      return;
    }
    this.humanLines += 1;
    if (this.humanLines >= ASK_BACKSTOP_LINES || this.askDue) this.ask();
  }

  /**
   * One bounded readiness check for the visitor line being answered. Questions, side requests and
   * filler never reach the model; a failed or timed-out check leaves the item open.
   */
  private async assessVisitorLine(text: string, signal: AbortSignal): Promise<ProposalAssessment | undefined> {
    if (this.mode() === 'observe') return undefined;
    const item = this.currentItem();
    if (item === undefined) return undefined;
    if (this.assessedText === text) return this.proposalAssessment;
    const priorLines = this.proposalLines.filter((line) => line !== text);
    if (!this.proposalLines.includes(text)) this.proposalLines.push(text);
    const assistantContext = this.history
      .filter((m) => m.role === 'assistant')
      .slice(-2)
      .map((m) => m.content);
    const assessment = await assessProposal({
      scenario: this.options.scenario,
      item,
      visitorText: text,
      visitorContext: priorLines,
      assistantContext,
      resolvedSoFar: this.resolvedTradeOffs,
      stream: (messages, innerSignal) => this.ports.stream(messages, innerSignal),
      signal,
      log: this.ports.log,
    });
    if (signal.aborted) return assessment;
    if (assessment !== undefined) {
      this.assessedText = text;
      this.proposalAssessment = assessment;
    }
    if (assessment !== undefined && !assessment.isProposal) {
      this.proposalLines = this.proposalLines.filter((line) => line !== text);
    }
    if (assessment !== undefined && assessment.isProposal) {
      this.resolvedTradeOffs = assessment.resolved;
    }
    if (assessment !== undefined && assessment.needsWingman === true) {
      this.wingmanHintActive = true;
    }
    if (assessment?.dynamicWingmanTip !== undefined && assessment.dynamicWingmanTip.trim() !== '') {
      this.ports.onWingmanTip?.(assessment.dynamicWingmanTip.trim(), item.title);
    }
    this.humanSettledOnCurrentItem = assessment?.isProposal === true && assessment.readiness === 'complete';
    if (!this.humanSettledOnCurrentItem && this.proposalLines.length >= 3) {
      // After 3+ unresolved substantive proposal attempts on the same topic, allow Sam to break the deadlock via a 10 AM follow-up meeting.
      this.humanSettledOnCurrentItem = true;
    }
    if (this.humanSettledOnCurrentItem) {
      this.wingmanHintActive = false;
    }
    if (assessment !== undefined) {
      this.ports.log?.(
        `proposal readiness: ${assessment.readiness} (${assessment.resolved.length} resolved, ${assessment.unresolved.length} open)`,
      );
    }
    return assessment;
  }

  /**
   * The visitor's lines that still make up the final decision. The readiness check names them, so a
   * line that a later proposal replaced is not quoted back as if it were still adopted; when the check
   * did not name any, the whole history is kept so a cumulative proposal does not lose details.
   */
  private finalDecisionLines(text: string, assessment: ProposalAssessment | undefined): string[] {
    const history = [...this.proposalLines.filter((line) => line !== text), text];
    const named = assessment?.decisionLines;
    if (named === undefined) return history;
    return named.length > 0 ? named : [text];
  }

  /** Pick 1–2 distinct integration deliverables for the current item that prioritize platforms not yet showcased in this session, tailored dynamically to what the visitor actually decided. */
  private recommendedDeliverablesForItem(title: string, spokenDecision: string): string {
    const lowerTitle = title.toLowerCase();
    const lowerDecision = spokenDecision.toLowerCase();
    const who = this.human?.name ?? 'them';
    type Option = { kind: string; phrase: string };

    if (/\b(?:table|park|postpone|defer|follow[- ]?up\s+(?:session|meeting)|10\s*am\s+follow[- ]?up)\b/i.test(lowerDecision)) {
      this.usedActionKinds.add('calendar_event');
      return `Specifically, ask ${who} directly using "Could you..." (never say "are you happy to" or "do you want to") to schedule the 10 AM follow-up session on the calendar so Kaki can draft the calendar invite on their screen right now.`;
    }

    const options: Option[] = [];
    if (
      /\b(?:customer|hospital|sfa|officer|inspector|grab|foodpanda|delivery|partner|vendor|supplier|landlord|media|press|voucher|apology|hamper|refund)\b/i.test(
        `${lowerDecision} ${lowerTitle}`,
      )
    ) {
      const recipientHint =
        lowerTitle.includes('sfa') || lowerTitle.includes('hygiene') || lowerTitle.includes('inspection')
          ? 'the hospitalized customer or SFA officer'
          : lowerTitle.includes('delivery') || lowerTitle.includes('grab')
            ? 'our GrabFood account manager or office partners'
            : lowerTitle.includes('kiosk') || lowerTitle.includes('queue')
              ? 'the mall landlord'
              : 'the external partner';
      options.push({
        kind: 'email',
        phrase: `send an email to ${recipientHint} with the plan we just agreed on`,
      });
    }
    if (
      /\b(?:kiosk|screen|subtitle|button|app|pos|docket|printer|menu|bundle|promo|code|system|ticket|setup|signage)\b/i.test(
        `${lowerDecision} ${lowerTitle}`,
      )
    ) {
      options.push({
        kind: 'gitea_issue',
        phrase: 'file a ticket in the issue tracker to implement the system and menu changes we just agreed on',
      });
    }
    options.push(
      {
        kind: 'wiki_page',
        phrase: 'write up our agreed morning SOP and decision on the team wiki',
      },
      {
        kind: 'mattermost_post',
        phrase: 'post our agreed morning plan in the team channel so the floor crew is aligned',
      },
      {
        kind: 'calendar_event',
        phrase: 'schedule a quick 10 AM follow-up check-in on the calendar',
      },
    );

    const fresh = options.filter((opt) => !this.usedActionKinds.has(opt.kind));
    const chosen = (fresh.length >= 2 ? fresh.slice(0, 2) : [...fresh, ...options].slice(0, 2));
    for (const c of chosen) this.usedActionKinds.add(c.kind);
    if (chosen.length >= 2 && chosen[0]!.kind !== chosen[1]!.kind) {
      return `Specifically, ask ${who} directly using "Could you..." (never say "are you happy to" or "do you want to") to take on these two follow-ups based strictly on what ${who} just decided so Kaki can draft both on their screen right now: (1) ${chosen[0]!.phrase}, and (2) ${chosen[1]!.phrase}.`;
    }
    return `Specifically, ask ${who} directly using "Could you..." (never say "are you happy to" or "do you want to") to ${chosen[0]!.phrase} based strictly on what ${who} just decided so Kaki can draft it for them.`;
  }

  /** What the colleagues should do with the visitor's proposal on this item, from the readiness check. */
  private proposalNote(text: string, assessment: ProposalAssessment | undefined): string {
    const who = this.human?.name ?? 'The person';
    const item = this.currentItem();
    const title = this.agendaItem ?? item?.title ?? 'this item';
    const decideWords = item?.decision ?? 'the decision is still open';
    const spokenDecision = this.finalDecisionLines(text, assessment).join(' ');
    if (assessment === undefined) {
      const settled = this.resolvedTradeOffs.map((entry) => entry.tradeOff.trim().toLowerCase());
      const stillOpen =
        (item?.discussion?.tradeOffs ?? [])
          .filter((tradeOff) => !settled.includes(tradeOff.tradeOff.trim().toLowerCase()))
          .map((tradeOff) => `${tradeOff.tradeOff} (ask: ${tradeOff.question})`)
          .join('; ') || decideWords;
      return `[${who} just made a proposal on "${title}". The readiness check could not run, so keep the item open. Still to settle: ${stillOpen}. Acknowledge what works in ${who}'s idea, then have the colleague whose trade-off is unresolved raise it from their own facts and ask ${who} the open question by name. Do not propose a workaround, do not say "I'll", and do not ask for a follow-up task yet.]`;
    }
    if (!assessment.isProposal) {
      return `[${who}'s last line was a question, confirmation check, side request or filler, not a final proposal on "${title}". Answer it directly and concisely and keep the item open; do not say "I'll" and do not ask for a follow-up task yet.]`;
    }
    if (assessment.readiness === 'complete') {
      const recentAssistant = this.history
        .filter((m) => m.role === 'assistant')
        .slice(-2)
        .map((m) => m.content)
        .join('\n');
      const alreadyAskedForDeliverable =
        /\b(?:(?:can|could|would|will|do you want)\s+(?:you|us)\s+(?:to\s+)?|(?:are\s+you|would\s+you\s+be)\s+happy\s+to\s+)(?:[\w'-]+,?\s+){0,5}(?:take\s+on|handle|cover|post|send|email|file|write|schedule|draft|arrange|book|update|record|create)\b|\bso\s+kaki\s+can\s+draft\b/i.test(
          recentAssistant,
        ) &&
        /^(?:(?:that's|that is|sounds|looks)\s+(?:good|fine|great|okay|ok)|(?:yes|yeah|yep|sure|ok|okay|can|steady|happy to|let's do (?:that|it)|do that|go ahead|go for it|works for me)\b)[^?]*$/i.test(
          text.trim(),
        );
      if (alreadyAskedForDeliverable) {
        return `[${who} just confirmed the plan and follow-up on "${title}" ("${spokenDecision}"). Reply in ONE short, warm sentence confirming you are locking that in (e.g., "Great, let's lock that in — ${who}, could you post that update in the team channel so everyone has it?"), without repeating the whole plan or asking a second open-ended question.]`;
      }
      const deliverableHint = this.recommendedDeliverablesForItem(title, spokenDecision);
      return `[${who} has made a complete proposal on "${title}". The final decision in ${who}'s own words, across the lines that still stand on this item, was: "${spokenDecision}". Confirm ONLY that decision: treat that quote as evidence of what ${who} decided, not as words to repeat, and do not add new terms, numbers, equipment or promises. Never add new decisions, and do not revive a superseded earlier proposal as if it were adopted. Acknowledge it faithfully in your own voice as a colleague, addressing ${who} as "you" or by name, and never speak as ${who} or copy their first-person commitments. Then ask ${who} by name for the matching follow-up deliverable (team channel post, email, wiki page, calendar invite or issue tracker ticket) unless ${who} already volunteered, and base that follow-up on the final decision only. ${deliverableHint} Nobody should reopen the trade-offs or raise a new catch.]`;
    }
    if (this.proposalLines.length >= 3) {
      const host = this.facilitatorOrCoHost() ?? 'Sam';
      this.usedActionKinds.add('calendar_event');
      return `[We have gone back and forth 3 times on "${title}" without a full consensus. Begin your reply with "${host}:". ${host} steps in warmly as the meeting chair to prevent a stalemate: acknowledge the remaining tension, propose parking "${title}" for a focused 15-minute working session at 10 AM today, and ask ${who} by name ("${who}, could you schedule that 10 AM follow-up on the calendar so we can keep the stand-up moving?") so Kaki can draft the calendar invite for ${who}.]`;
    }
    const stillOpen =
      assessment.unresolved.map((entry) => `${entry.tradeOff} (ask: ${entry.question})`).join('; ') || decideWords;
    return `[${who} has not settled "${title}" yet. Still to settle: ${stillOpen}. Acknowledge what works in ${who}'s idea, then have the colleague whose trade-off is unresolved raise that specific trade-off from their own facts, share any practical option or capability from their "Knows" facts that could help bridge the gap, and ask ${who} the open question by name so ${who} can decide. Do not repeat a fact already said aloud, do not say "I'll", and NEVER ask about drafting, posting, emailing, or filing a follow-up task while trade-offs are still open.]`;
  }

  /**
   * What the colleagues should do with a side request that is not a proposal: answer the item the
   * visitor actually asked for, without pretending the decision is settled or inventing another task.
   */
  private sideRequestNote(): string {
    const who = this.human?.name ?? 'The person';
    const item = this.currentItem();
    const title = this.agendaItem ?? item?.title ?? 'this item';
    const open = this.humanSettledOnCurrentItem
      ? ''
      : ` The decision on "${title}" is still open, so keep the item open and do not say it is settled.`;
    return `[${who}'s last line is a side request, not a proposal on "${title}". Address exactly the deliverable ${who} asked for; do not substitute a different follow-up such as a team channel post.${open} You may acknowledge the request or say you will prepare that requested item provisionally, including a ticket ${who} asked for, but take on only that item; never promise a task ${who} did not ask for.]`;
  }

  /** The agenda item the meeting is on, and how this person takes part in it. */
  private currentItem() {
    const title = this.agendaItem ?? this.options.scenario.agenda[0]?.title;
    if (title === undefined) return undefined;
    const cleanTitle = cleanSpokenTopic(title).toLowerCase();
    return this.options.scenario.agenda.find(
      (item) => item.title === title || cleanSpokenTopic(item.title).toLowerCase() === cleanTitle,
    );
  }

  private mode() {
    return itemMode(this.options.scenario, this.currentItem(), this.human?.role);
  }

  private advanceOrEnd(): void {
    const agenda = this.options.scenario.agenda;
    const current = this.currentItem();
    const currentIdx = current === undefined ? -1 : agenda.findIndex((item) => item.title === current.title);
    if (currentIdx >= 0 && currentIdx + 1 >= agenda.length && this.ports.endMeeting !== undefined) {
      this.ports.endMeeting();
      return;
    }
    this.ports.advanceAgenda?.();
  }

  /**
   * Hold the advance and silence timers for `holdMs` (default 25s) when the visitor actively clicks
   * "Let Kaki do it" on a task assigned to them in the right panel, so they have time to read and approve
   * the Kaki draft without Sam interrupting or moving the agenda on early.
   */
  holdForHumanTask(holdMs = 25_000, origin?: string | null): void {
    if (!this.originIsCurrent(origin)) return;
    const title = this.currentItem()?.title;
    if (this.closed || this.concluded || title === undefined || this.advanced.has(title)) return;
    this.clearSilenceTimer();
    this.clearAdvanceTimer();
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = undefined;
      if (this.closed || this.concluded || this.currentItem()?.title !== title || this.advanced.has(title)) return;
      if (
        this.paused ||
        this.humanTalking ||
        this.recognizingSpeech ||
        this.turn !== undefined ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined ||
        this.pendingAnnouncements > 0
      ) {
        this.holdForHumanTask(5_000, origin);
        return;
      }
      this.advanced.add(title);
      this.ports.log?.(`moving on after "${title}" human task review window finished`);
      this.advanceOrEnd();
    }, holdMs).unref();
  }

  /**
   * Called once the visitor has finished syncing (or declining) their follow-up task and Sam has acknowledged it:
   * immediately advances to the next agenda item (or ends the meeting if on the last item).
   */
  completeHumanTask(origin?: string | null): void {
    if (!this.originIsCurrent(origin)) return;
    const title = this.currentItem()?.title;
    if (
      this.closed ||
      this.concluded ||
      title === undefined ||
      this.advanced.has(title) ||
      (this.ports.advanceAgenda === undefined && this.ports.endMeeting === undefined)
    ) {
      return;
    }
    this.clearSilenceTimer();
    this.clearAdvanceTimer();
    this.advanced.add(title);
    this.ports.log?.(`moving on after "${title}" human task was synced`);
    this.advanceOrEnd();
  }

  /**
   * A follow-up task was just accepted (`CLAIMED`). If the meeting is on an item where the person participates
   * (`decide` or `involve`) and the person has already wrapped up their decision on this item, the decision has produced
   * its follow-up task, so advance to the next agenda item once the room is quiet.
   */
  taskAccepted(origin?: string | null): void {
    if (!this.originIsCurrent(origin)) return;
    const title = this.currentItem()?.title;
    if (
      this.closed ||
      this.concluded ||
      title === undefined ||
      this.mode() === 'observe' ||
      this.advanced.has(title) ||
      this.humanLines <= this.linesAtMove ||
      !this.decisionWrappedUpOnItem ||
      (this.ports.advanceAgenda === undefined && this.ports.endMeeting === undefined)
    ) {
      return;
    }
    this.clearSilenceTimer();
    this.clearAdvanceTimer();
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = undefined;
      if (this.closed || this.currentItem()?.title !== title || this.advanced.has(title)) return;
      if (
        this.paused ||
        this.humanTalking ||
        this.recognizingSpeech ||
        this.turn !== undefined ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined ||
        this.pendingAnnouncements > 0
      ) {
        this.taskAccepted(origin);
        return;
      }
      this.advanced.add(title);
      this.ports.log?.(`moving on after "${title}" task was accepted`);
      this.advanceOrEnd();
    }, 3000).unref();
  }

  /**
   * The meeting is on a new agenda item (also called for the first one, once the welcome is spoken). If the person takes part in
   * it, the host asks them for their call after the announcement. If they only watch, the characters start talking it through
   * between themselves, unless the person speaks first: a newcomer sees how the team works before being asked anything.
   */
  agendaMoved(title?: string): void {
    this.clearAdvanceTimer();
    this.clearSilenceTimer();
    this.clearBriefTimer();
    this.clearObserveTimer();
    if (title !== undefined) {
      const cleanTitle = cleanSpokenTopic(title).toLowerCase();
      const matched = this.options.scenario.agenda.find(
        (candidate) => candidate.title === title || cleanSpokenTopic(candidate.title).toLowerCase() === cleanTitle,
      );
      this.agendaItem = matched?.title ?? title;
      this.silencePromptStage = 0;
      this.bridgedStatementOnTurn = false;
    }
    if (this.closed || this.human === undefined) return;
    this.linesAtMove = this.humanLines;
    this.hadDecisionBeforeMove = this.humanSettledOnCurrentItem;
    this.movedAt = Date.now();
    this.humanSettledOnCurrentItem = false;
    this.wingmanHintActive = false;
    this.proposalAssessment = undefined;
    this.assessedText = undefined;
    this.proposalLines = [];
    this.resolvedTradeOffs = [];
    this.decisionWrappedUpOnItem = false;
    const item = this.currentItem();
    if (this.mode() === 'observe') {
      this.askDue = false;
      if (item !== undefined && !this.observed.has(item.title)) this.observeLater(item.title, 0);
      return;
    }
    // In a full kopitiam/multi-colleague demo (more than 2 NPCs), let two AI colleagues briefly explain the background
    // and trade-offs of the item first before asking the visitor for their decision, so the visitor isn't asked cold!
    if (item !== undefined && this.names.length > 2 && !this.briefed.has(item.title)) {
      this.askDue = false;
      this.briefLater(item.title, 0);
      return;
    }
    if (this.asked.has(this.human.name)) return;
    this.askDue = true;
    setTimeout(() => {
      if (!this.closed && !this.paused && this.askDue) this.ask();
    }, this.options.askDelayMs ?? DEFAULT_ASK_DELAY_MS).unref();
  }

  private briefLater(title: string, attempt: number): void {
    if (this.closed || this.paused) return;
    this.clearBriefTimer();
    this.briefTimer = setTimeout(() => {
      this.briefTimer = undefined;
      if (this.closed || this.paused || this.briefed.has(title) || this.currentItem()?.title !== title) return;
      if (this.humanLines > this.linesAtMove) return;
      if (
        this.turn !== undefined ||
        this.humanTalking ||
        this.recognizingSpeech ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined
      ) {
        if (attempt < 12) this.briefLater(title, attempt + 1);
        return;
      }
      const cue = this.briefCue(title);
      if (cue === undefined) return;
      this.briefed.add(title);
      this.asked.add(this.human?.name ?? '');
      this.pending.push(cue);
      this.startTurn();
    }, attempt === 0 ? (this.options.observeDelayMs ?? DEFAULT_OBSERVE_DELAY_MS) : 1500).unref();
  }

  /** Tells two AI colleagues to briefly explain the context and trade-offs of the item and then ask the human for their call. */
  private briefCue(title: string): string | undefined {
    const scenario = this.options.scenario;
    const npcs = scenario.npcs ?? [];
    const item = scenario.agenda.find((candidate) => candidate.title === title);
    const hostName = npcs.find((npc) => npc.role === 'host')?.attendee;
    const others = this.names.filter((name) => name !== hostName);
    const topicWords = `${item?.title ?? ''} ${item?.decision ?? ''}`
      .toLowerCase()
      .match(/[a-z0-9]{4,}/g) ?? [];
    const scoreText = (text: string): number =>
      topicWords.reduce((sum, word) => sum + (text.toLowerCase().includes(word) ? 1 : 0), 0);
    const scoreProfile = (name: string): number => {
      const profile = npcs.find((npc) => npc.attendee === name);
      if (profile === undefined) return 0;
      const blob = [
        profile.agenda,
        ...profile.concerns,
        ...(profile.knows ?? []),
        ...(profile.tensions?.map((t) => t.about) ?? []),
      ].join(' ');
      return scoreText(blob);
    };
    const discussion = item?.discussion;
    const discussionOpeningSpeakers = (discussion?.openingViews ?? [])
      .map((v) => v.attendee)
      .filter((name) => others.includes(name));
    const discussionTradeOffSpeakers = (discussion?.tradeOffs ?? [])
      .map((t) => t.attendee)
      .filter((name) => others.includes(name));
    const owner =
      others.find((name) => scenario.attendees.find((attendee) => attendee.name === name)?.role === item?.ownerRole) ??
      discussionOpeningSpeakers[0] ??
      discussionTradeOffSpeakers[0] ??
      [...others].sort((left, right) => scoreProfile(right) - scoreProfile(left))[0] ??
      others[0];
    const ownerProfile = npcs.find((npc) => npc.attendee === owner);
    const scoreTensionPair = (candidate: string): number => {
      if (candidate === owner) return -1;
      const openingRank = discussionOpeningSpeakers.indexOf(candidate);
      const inOpening = openingRank === 0 ? 140 : openingRank === 1 ? 120 : openingRank >= 2 ? 70 : 0;
      const inTradeOff = discussionTradeOffSpeakers.includes(candidate) ? 50 : 0;
      const unintroducedBonus = !this.introduced.has(candidate) && (inOpening > 0 || inTradeOff > 0) ? 15 : 0;
      const candidateProfile = npcs.find((npc) => npc.attendee === candidate);
      const fromOwner = ownerProfile?.tensions?.find((t) => t.with === candidate)?.about ?? '';
      const toOwner = candidateProfile?.tensions?.find((t) => t.with === owner)?.about ?? '';
      return inOpening + inTradeOff + unintroducedBonus + scoreText(`${fromOwner} ${toOwner}`) * 10 + scoreProfile(candidate);
    };
    const other =
      [...others]
        .filter((name) => name !== owner)
        .sort((left, right) => scoreTensionPair(right) - scoreTensionPair(left))[0] ??
      others[0];
    if (owner === undefined || other === undefined || this.human === undefined) return undefined;
    const ownerTradeOff = discussion?.tradeOffs.find((tradeOff) => tradeOff.attendee === owner);
    const otherTradeOff =
      discussion?.tradeOffs.find((tradeOff) => tradeOff.attendee === other) ?? ownerTradeOff;
    const humanRoleId =
      scenario.roles.find((r) => r.id === this.human?.role || r.label === this.human?.role)?.id ??
      scenario.attendees.find((a) => a.name === this.human?.name)?.role;
    // Opening views are written as a chain ("Cut the plugs!" -> "Cutting plugs makes sense, but..."). When the visitor
    // sits in a seat that has one, that line is never said aloud, so a later view would answer an idea nobody raised.
    // Use the neutral trade-off facts instead, and say plainly that nothing has been proposed yet.
    const visitorSeat = scenario.attendees.find((attendee) => attendee.role === humanRoleId)?.name;
    const visitorViewSkipped =
      visitorSeat !== undefined && (discussion?.openingViews ?? []).some((view) => view.attendee === visitorSeat);
    const viewOf = (name: string): string | undefined =>
      visitorViewSkipped ? undefined : discussion?.openingViews.find((view) => view.attendee === name)?.view;
    const ownerView = viewOf(owner);
    const otherView = viewOf(other);
    const nothingProposedYet = visitorViewSkipped
      ? ` Nobody has proposed a fix on this item yet: ${owner} must not react to, agree with or reject any earlier idea (there is none), and ${this.human.name} has not spoken on it yet.`
      : '';
    const discussionHint =
      discussion === undefined
        ? ''
        : ` Ground their turns in these real-world facts and examples in their own natural words (never read this note aloud, never recite a script, and make sure ${other} responds directly to what ${owner} actually says): ${owner}'s context is "${ownerView ?? ownerTradeOff?.tradeOff ?? 'the item is still open'}"; ${other}'s competing catch is "${otherView ?? otherTradeOff?.tradeOff ?? 'the item is still open'}".${nothingProposedYet}`;
    const visitorOwnsItem = item?.ownerRole !== undefined && humanRoleId === item.ownerRole;
    const itemIndex = Math.max(
      0,
      scenario.agenda.findIndex((candidate) => candidate.title === title),
    );
    const patternIndex = visitorOwnsItem ? 2 : itemIndex % 4;
    const patternInstruction =
      patternIndex === 0
        ? `Conversational dynamic (Story + Casual Question -> Colleague's Practical Catch):
- ${owner} speaks first in 2 short, casual spoken sentences with real personality (under 24 words per sentence): first share what happened on the ground yesterday in natural everyday words, then casually float the obvious fix as a question to ${other} or the room (e.g., "Can't we just rename the kiosk buttons to plain English like Black Coffee No Sugar for tomorrow?").
- ${other} speaks second in 2 short, casual spoken sentences (under 24 words per sentence): react naturally to ${owner}'s idea and explain the practical catch on ${other}'s side in plain words;`
        : patternIndex === 1
          ? `Conversational dynamic (Floor Frustration -> Partial Agreement + Practical Catch):
- ${owner} speaks first in 2 short, casual spoken sentences with real personality (under 24 words per sentence): vent briefly like a real coworker about what happened on the shop floor yesterday and state the rule ${owner} wants to set tomorrow morning.
- ${other} speaks second in 2 short, casual spoken sentences (under 24 words per sentence): agree with what makes sense in ${owner}'s idea, then point out who gets hurt on ${other}'s side if we do only that;`
          : patternIndex === 2
            ? `Conversational dynamic (Urgent Heads-Up -> Competing Operational Reality):
- ${owner} speaks first in 2 short, casual spoken sentences with real personality (under 24 words per sentence): flag the urgent situation for tomorrow morning and share ${owner}'s gut instinct on what to do.
- ${other} speaks second in 2 short, casual spoken sentences (under 24 words per sentence): push back warmly and directly on ${owner}'s instinct with the real-world catch on ${other}'s side;`
            : `Conversational dynamic (Margin Headache + Tempting Move -> Real-World Catch):
- ${owner} speaks first in 2 short, casual spoken sentences with real personality (under 24 words per sentence): explain the squeeze we're facing like a real coworker and float the tempting fix ${owner} is thinking of trying.
- ${other} speaks second in 2 short, casual spoken sentences (under 24 words per sentence): jump in naturally ("Hold on, ...") and explain why that tempting move backfires on ${other}'s side;`;
    const handoffExamples = [
      `"How should we balance both sides tomorrow morning, ${this.human.name}?"`,
      `"${this.human.name}, what are your thoughts on your side, or how do you want to play this?"`,
      `"What's your call on handling both catches, ${this.human.name}?"`,
      `"${this.human.name}, how should we sort this out before doors open?"`,
    ];
    const handoffExample = handoffExamples[itemIndex % handoffExamples.length]!;
    const handoffQuestionInstruction = visitorOwnsItem
      ? `Sentence 2 MUST be one short, natural question asking ${this.human.name} by name (ending with a question mark "?") how they want to steer this as the lead (e.g., "Since you're leading this one, ${this.human.name}, what numbers or options do you have on your side, or how do you want to play it?")`
      : `Sentence 2 MUST be one short, natural question to ${this.human.name} by name (ending with a question mark "?", such as ${handoffExample} — do NOT say "From your side as ${this.human.role}")`;
    return `[We just started agenda item "${title}". Speak naturally like two real colleagues having a genuine cause-and-effect conversation with ${this.human.name}, using complete, grammatical sentences and everyday words (never use robotic fragments like "Hey ${this.human.name}, ${owner} from ..." or "From the ... side,", never chop off the setup clause of a sentence, and do not address ${owner} or ${other} by name at the start or end of a sentence):
${patternInstruction} ${handoffQuestionInstruction}.
${discussionHint}
Keep every single sentence under 28 words so it flows naturally aloud. Keep it to 2 speakers total and do not mention this note.]`;
  }

  private observeLater(title: string, attempt: number): void {
    if (this.closed || this.paused) return;
    this.clearObserveTimer();
    this.observeTimer = setTimeout(() => {
      this.observeTimer = undefined;
      if (this.closed || this.paused || this.observed.has(title) || this.currentItem()?.title !== title) return;
      // The person spoke on this item, or the room is busy: leave it to them, or try again in a moment.
      if (this.humanLines > this.linesAtMove) return;
      if (this.turn !== undefined || this.humanTalking || this.pending.length > 0 || this.respondTimer !== undefined) {
        if (attempt < 12) this.observeLater(title, attempt + 1);
        return;
      }
      const cue = this.observeCue(title);
      if (cue === undefined) return;
      this.observed.add(title);
      this.pending.push(cue);
      this.startTurn();
    }, attempt === 0 ? (this.options.observeDelayMs ?? DEFAULT_OBSERVE_DELAY_MS) : 1500).unref();
  }

  /** Tells the characters to talk the item through between themselves. */
  private observeCue(title: string): string | undefined {
    const scenario = this.options.scenario;
    const npcs = scenario.npcs ?? [];
    const item = scenario.agenda.find((candidate) => candidate.title === title);
    const hostName = npcs.find((npc) => npc.role === 'host')?.attendee;
    const others = this.names.filter((name) => name !== hostName);
    const owner =
      others.find((name) => scenario.attendees.find((attendee) => attendee.name === name)?.role === item?.ownerRole) ?? others[0] ?? this.names[0];
    const other = others.find((name) => name !== owner) ?? this.names.find((name) => name !== owner);
    if (owner === undefined || other === undefined || this.human === undefined) return undefined;
    return `[${this.human.name} is just listening for now on "${title}". Without waiting for them, ${owner} says in plain words where things stand on "${title}" and what they plan to do, then ${other} reacts briefly on "${title}" only (do not bring up other agenda items), and ${owner} settles the call on "${title}" and ends by stating the one concrete follow-up action needed using "I'll ..." (such as "I'll file a bug ticket in Gitea today for the promo cart limit" or "I'll post the update in the team channel today") so the host can assign it. Two or three short turns, then stop. Do not ask ${this.human.name} anything, and do not mention this note.]`;
  }

  private scheduleObserveAdvance(): void {
    const title = this.currentItem()?.title;
    if (
      this.closed ||
      title === undefined ||
      this.mode() !== 'observe' ||
      !this.observed.has(title) ||
      this.advanced.has(title) ||
      this.humanLines > this.linesAtMove ||
      this.ports.advanceAgenda === undefined
    ) {
      return;
    }
    this.clearAdvanceTimer();
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = undefined;
      if (
        this.closed ||
        this.currentItem()?.title !== title ||
        this.humanLines > this.linesAtMove ||
        this.advanced.has(title)
      ) {
        return;
      }
      if (
        this.paused ||
        this.humanTalking ||
        this.turn !== undefined ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined ||
        this.pendingAnnouncements > 0
      ) {
        this.scheduleObserveAdvance();
        return;
      }
      this.advanced.add(title);
      this.ports.log?.(`moving on after "${title}" was talked through`);
      this.advanceOrEnd();
    }, this.options.observeAdvanceMs ?? DEFAULT_OBSERVE_ADVANCE_MS).unref();
  }

  /**
   * When the person has spoken on a `decide` or `involve` item and the AI's reply wraps up the decision
   * (no question at the end, and a character commits with "I'll ..." or "will follow up"), schedule moving
   * to the next agenda item after the notetaker and any task dispatch have had time to run, so the meeting
   * never gets stuck even if the notetaker does not extract a task.
   */
  private scheduleDecisionAdvance(turn: Turn): boolean {
    const current = this.currentItem();
    const title = current?.title;
    const hasTradeOffs = (current?.discussion?.tradeOffs?.length ?? 0) > 0;
    if (
      this.closed ||
      this.paused ||
      title === undefined ||
      this.mode() === 'observe' ||
      this.advanced.has(title) ||
      this.humanLines <= this.linesAtMove ||
      (hasTradeOffs && !this.humanSettledOnCurrentItem) ||
      (this.ports.advanceAgenda === undefined && this.ports.endMeeting === undefined)
    ) {
      return false;
    }
    const lastText = turn.spoken.at(-1)?.utterance.text.trim() ?? '';
    const wrappedUp = turn.spoken.some(({ utterance }) =>
      /\b(?:I'll|I\u2019ll|I will|will follow up|so we're|so we are|we'll go ahead|lock this in|(?:can|could|would|will) you (?:[a-z]+\s+){0,2}(?:post|send|email|file|write|schedule|draft|arrange|book))\b/i.test(
        utterance.text,
      ),
    );
    if (!wrappedUp) return false;
    // Allow a wrap-up turn to advance even if the last sentence is a follow-up task request ("Guest, could you post that in the team channel today?"),
    // as long as it is not asking which option to choose.
    const isTaskRequest = turn.spoken.some(({ utterance }) =>
      /\b(?:can|could|would|will) you (?:[\w'-]+,?\s+){0,5}(?:post|send|email|file|write|schedule|draft|arrange|book|update|record|create|take on)\b/i.test(
        utterance.text,
      ),
    );
    const lastIsTaskRequest =
      /\b(?:can|could|would|will) you (?:[\w'-]+,?\s+){0,5}(?:post|send|email|file|write|schedule|draft|arrange|book|update|record|create|take on)\b/i.test(
        lastText,
      );
    if (lastText.endsWith('?') && !lastIsTaskRequest) return false;
    this.decisionWrappedUpOnItem = true;
    this.askDue = false;
    if (this.human !== undefined) this.asked.add(this.human.name);
    this.clearSilenceTimer();
    this.clearAdvanceTimer();
    const baseAdvanceMs = this.options.observeAdvanceMs ?? DEFAULT_OBSERVE_ADVANCE_MS;
    const advanceDelayMs = isTaskRequest ? Math.max(baseAdvanceMs * 2, 18_000) : baseAdvanceMs;
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = undefined;
      if (this.closed || this.currentItem()?.title !== title || this.advanced.has(title)) return;
      if (
        this.paused ||
        this.humanTalking ||
        this.recognizingSpeech ||
        this.turn !== undefined ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined ||
        this.pendingAnnouncements > 0
      ) {
        this.scheduleDecisionAdvance(turn);
        return;
      }
      this.advanced.add(title);
      this.ports.log?.(`moving on after "${title}" decision was wrapped up`);
      this.advanceOrEnd();
    }, advanceDelayMs).unref();
    return true;
  }

  /**
   * Gentle silence handling when the room is waiting on the person (`decide` or `involve` mode):
   * - Stage 1: After `silencePromptMs`, the AI host gently checks in with the person by name and invites them to share a thought or ask a question.
   * - Stage 2: If the person stays silent again, a colleague briefly summarizes the two plain-English directions on the table as a question — never solving the item for them or auto-advancing.
   */
  private scheduleSilencePrompt(): void {
    const item = this.currentItem();
    const title = item?.title;
    const host = this.facilitatorOrCoHost();
    if (
      this.closed ||
      this.paused ||
      this.human === undefined ||
      host === undefined ||
      title === undefined ||
      this.mode() === 'observe' ||
      this.decisionWrappedUpOnItem ||
      this.silencePromptStage >= 2
    ) {
      return;
    }
    this.clearSilenceTimer();
    const linesBefore = this.humanLines;
    const stageAtSchedule = this.silencePromptStage;
    const endedWithQuestion = /\?["')\]]*$/.test(this.lastSpoken.trim());
    const shouldBridgeStatement =
      !endedWithQuestion &&
      !this.bridgedStatementOnTurn &&
      stageAtSchedule === 0 &&
      this.deferredFollowUpTimer === undefined &&
      !this.decisionWrappedUpOnItem &&
      !this.humanSettledOnCurrentItem &&
      this.humanLines - this.linesAtMove <= 1;
    const baseMs = this.options.silencePromptMs ?? DEFAULT_SILENCE_PROMPT_MS;
    const delayMs = shouldBridgeStatement ? Math.min(baseMs, 10_000) : baseMs;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = undefined;
      if (
        this.closed ||
        this.paused ||
        this.human === undefined ||
        this.currentItem()?.title !== title ||
        this.humanLines > linesBefore ||
        this.silencePromptStage !== stageAtSchedule
      ) {
        return;
      }
      if (
        this.humanTalking ||
        this.recognizingSpeech ||
        this.turn !== undefined ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined ||
        this.pendingAnnouncements > 0
      ) {
        this.scheduleSilencePrompt();
        return;
      }
      if (shouldBridgeStatement) {
        this.bridgedStatementOnTurn = true;
        const npcs = this.options.scenario.npcs ?? [];
        const spokenTitle = cleanSpokenTopic(title);
        if (npcs.length > 1) {
          this.forcedSpeaker = { target: host, from: host };
          this.pending.push(
            `[${this.human.name} just heard the team's answer on "${spokenTitle}", and the colleague finished on a statement without passing the floor. Begin your reply with "${host}:". ${host} steps in as the meeting chair in ONE short, natural spoken sentence connecting what was just said back to the decision and asking ${this.human.name} by name (ending with a question mark "?") how they want to play this or if they want to lock a direction in — never prescribe an answer or mention this note.]`,
          );
          this.startTurn();
          return;
        }
      }
      this.silencePromptStage = stageAtSchedule + 1;
      if (this.silencePromptStage === 1) {
        const npcs = this.options.scenario.npcs ?? [];
        const others = this.names.filter((name) => name !== host);
        const owner =
          others.find((name) => this.options.scenario.attendees.find((a) => a.name === name)?.role === item?.ownerRole) ??
          others[0];
        const spokenTitle = cleanSpokenTopic(title);
        if (owner !== undefined && npcs.length > 1) {
          this.forcedSpeaker = { target: host, from: host };
          const checkInContext = this.humanSettledOnCurrentItem
            ? `asking warmly if they are good with that follow-up plan or ready to move on to the next item`
            : this.proposalLines.length >= 1
              ? `checking in warmly on the open question the team just raised and asking how they'd like to play it`
              : `letting them know there is no rush and asking if they want a quick recap of the two options on the table`;
          this.pending.push(
            `[${this.human.name} is taking a moment to think on "${spokenTitle}". Begin your reply with "${host}:". ${host} checks in with ${this.human.name} in one short, warm, plain-English sentence ${checkInContext} — never prescribe an answer, never refer to "the right panel" or UI elements, and do not mention this note.]`,
          );
          this.startTurn();
        } else {
          this.announce(
            host,
            `${this.human.name}, no rush — what are your thoughts on ${spokenTitle}, or do you want us to go over the options again?`,
            DEFAULT_ANNOUNCE_GIVE_UP_MS,
            () => this.scheduleSilencePrompt(),
          );
        }
      } else if (this.silencePromptStage === 2) {
        const npcs = this.options.scenario.npcs ?? [];
        const others = this.names.filter((name) => name !== host);
        const owner =
          others.find((name) => this.options.scenario.attendees.find((a) => a.name === name)?.role === item?.ownerRole) ??
          others[0] ??
          this.names[0];
        const decisionText = item?.decision ? ` (${item.decision})` : '';
        if (owner !== undefined && npcs.length > 1) {
          this.forcedSpeaker = { target: owner, from: host };
          this.pending.push(
            `[${this.human.name} is still thinking on "${title}"${decisionText}. Begin your reply with "${owner}:". ${owner} speaks in ONE short, plain-English sentence offering two simple everyday directions ${this.human.name} could pick between as a helpful question — do NOT solve the trade-offs yourself, do NOT use technical jargon, and wait for ${this.human.name}'s answer. Do not mention this note.]`,
          );
          this.startTurn();
        }
      }
    }, delayMs).unref();
  }

  /** A character handed over to another by name and nobody has answered yet: the named one answers, after a short pause. */
  private scheduleFollowUp(from: string, target: string): void {
    if (this.closed || this.paused || this.chain >= MAX_FOLLOW_UPS) return;
    this.clearRespondTimer();
    this.respondTimer = setTimeout(() => {
      this.respondTimer = undefined;
      if (this.closed || this.paused || this.humanTalking || this.pending.length > 0 || this.turn !== undefined) return;
      this.chain += 1;
      this.ports.log?.(`${from} handed over to ${target}: ${target} answers`);
      this.forcedSpeaker = { target, from };
      this.pending = [`[${from} handed over to ${target}. Begin your reply with "${target}:". ${target} answers now for their own side, briefly, and nobody else speaks.]`];
      this.startTurn();
    }, this.speakerGapMs);
  }

  private startTurn(retry = false, recoveryRetry = false): void {
    if (this.closed || this.paused) return;
    const text = retry ? this.lastText : this.pending.join(' ').trim();
    this.pending = [];
    if (text.length === 0) return;
    this.interrupt('a new turn started');
    const forced = this.forcedSpeaker;
    this.forcedSpeaker = undefined;
    this.unanswered = false;
    this.cutOff = false;
    this.lastText = text;

    // On a retry the question is already in the history.
    const lastAssistant = [...this.history].reverse().find((m) => m.role === 'assistant')?.content ?? '';
    const recentAssistant = this.history
      .filter((m) => m.role === 'assistant')
      .slice(-3)
      .map((m) => m.content)
      .join('\n');
    const lastWasTaskRequest =
      /\b(?:(?:can|could|would|will)\s+you|(?:are\s+you|would\s+you\s+be)\s+happy\s+to|(?:do\s+you\s+)?(?:want|like)\s+to|would\s+you\s+like\s+to)\s+(?:[\w'-]+,?\s+){0,5}(?:take\s+on|handle|cover|post|send|email|file|write|schedule|draft|arrange|book|update|record|create)\b|\bso\s+kaki\s+can\s+draft\b/i.test(
        `${lastAssistant}\n${recentAssistant}`,
      );
    if (retry) {
      this.ports.log?.(
        recoveryRetry
          ? 'retrying the same request after the model said nothing'
          : 'answering again: the last answer was cancelled before anything was said',
      );
    } else {
      this.history.push({ role: 'user', content: text });
    }
    if (
      !retry &&
      forced === undefined &&
      this.humanSettledOnCurrentItem &&
      lastWasTaskRequest &&
      /^(?:(?:ok(?:ay)?|sure(?:\s+thing)?|yes(?:\s+please)?|yep|yeah|can|steady|happy\s+to(?:\s+do\s+(?:that|it))?|sounds\s+good|got\s+it|will\s+do|go\s+(?:ahead|for\s+it)|let'?s\s+do\s+(?:that|it)|let\s+kaki\s+(?:draft|do)\s+(?:it|that)|i(?:'ll| will)(?: do that| post(?: that| it)?| send(?: that| it)?| handle(?: that| it)?| take(?:\s+care\s+of|\s+on) (?:that|it))?|no\s+problem|on\s+it)(?:\s+in\s+the\s+team\s+channel|\s+today|\s+right\s+now)?[,.\s!]*)+$/i.test(
        text,
      )
    ) {
      const host = this.facilitatorOrCoHost() ?? 'Sam';
      const speakerMatch = /^([A-Za-z][A-Za-z\s]{0,20}):/.exec(lastAssistant.trim());
      const ackSpeaker =
        speakerMatch?.[1] !== undefined && this.names.includes(speakerMatch[1].trim())
          ? speakerMatch[1].trim()
          : host;
      const acks = [
        'Thanks, appreciate you taking that on!',
        'Steady, thanks for sorting that out.',
        'Sounds good, appreciate you handling that.',
        'Lovely, thanks for covering that follow-up.',
      ];
      const ackText = acks[this.humanLines % acks.length]!;
      this.ports.log?.(`short-circuiting task acceptance ack with scripted "${ackSpeaker}: ${ackText}"`);
      this.startScripted({ speaker: ackSpeaker, text: ackText }, () => {
        this.taskAccepted();
      });
      return;
    }
    const turn: Turn = {
      abort: new AbortController(),
      spoken: [],
      enqueued: [],
      streamFinished: false,
      aborted: false,
      finalized: false,
      done: Promise.resolve(),
      startedAt: Date.now(),
      forced,
      recoveryRetry,
    };
    this.turn = turn;
    turn.done = this.runTurn(turn).catch((error: unknown) => {
      this.ports.log?.(`turn failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private startReplayTurn(utterances: Utterance[]): void {
    const turn: Turn = {
      abort: new AbortController(),
      spoken: [],
      enqueued: [...utterances],
      streamFinished: true,
      aborted: false,
      finalized: false,
      done: Promise.resolve(),
      startedAt: Date.now(),
    };
    this.turn = turn;
    turn.done = this.runReplayTurn(turn, utterances).catch((error: unknown) => {
      this.ports.log?.(`replay turn failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async runReplayTurn(turn: Turn, utterances: Utterance[]): Promise<void> {
    const { signal } = turn.abort;
    const queue = new SentenceQueue<{ utterance: Utterance; clip: Promise<Clip | undefined> }>();
    signal.addEventListener('abort', () => queue.close(), { once: true });
    this.ports.emitState({ kind: 'thinking' });
    const player = this.playAll(turn, queue);
    for (const utterance of utterances) {
      const clip = this.ports.synthesize(utterance, signal).catch((error: unknown) => {
        if (!signal.aborted) {
          this.ports.log?.(`could not synthesize "${utterance.text}": ${error instanceof Error ? error.message : String(error)}`);
        }
        return undefined;
      });
      queue.push({ utterance, clip });
    }
    queue.close();
    await player;
    if (turn.aborted) return;
    this.finalize(turn);
    this.turn = undefined;
    this.gate.setAiAudible(false);
    const handedTo = findHandover(turn.spoken.map((entry) => entry.utterance), this.names, this.human?.name);
    if (handedTo !== undefined) this.scheduleFollowUp(handedTo.from, handedTo.target);
    else if (turn.spoken.length > 0) {
      this.scheduleObserveAdvance();
      if (!this.scheduleDecisionAdvance(turn)) this.scheduleSilencePrompt();
    }
    this.ports.emitState(this.idleState());
  }

  private startScripted(utterance: Utterance, onDone?: (spoken: boolean) => void): void {
    const turn: Turn = {
      abort: new AbortController(),
      spoken: [],
      enqueued: [],
      streamFinished: true,
      aborted: false,
      finalized: false,
      done: Promise.resolve(),
      startedAt: Date.now(),
      scripted: true,
      scriptedUtterance: utterance,
      onScriptedDone: onDone,
    };
    this.turn = turn;
    turn.done = this.runScripted(turn, utterance)
      .then(() => {
        if (!turn.aborted) onDone?.(true);
        else if (!this.closed && !this.paused && turn.onScriptedDone !== undefined) turn.onScriptedDone(false);
      })
      .catch((error: unknown) => {
        this.ports.log?.(`cue failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private async runScripted(turn: Turn, utterance: Utterance): Promise<void> {
    const { signal } = turn.abort;
    const queue = new SentenceQueue<{ utterance: Utterance; clip: Promise<Clip | undefined> }>();
    signal.addEventListener('abort', () => queue.close(), { once: true });
    this.ports.emitState({ kind: 'thinking' });
    const player = this.playAll(turn, queue);
    const sentences = splitSentences(utterance.text);
    for (const sentence of sentences) {
      const item: Utterance = { speaker: utterance.speaker, text: sentence };
      const clip = this.ports.synthesize(item, signal).catch((error: unknown) => {
        if (!signal.aborted) {
          this.ports.log?.(`could not synthesize "${item.text}": ${error instanceof Error ? error.message : String(error)}`);
        }
        return undefined;
      });
      queue.push({ utterance: item, clip });
    }
    queue.close();
    await player;
    if (turn.aborted) return;
    this.finalize(turn);
    this.turn = undefined;
    this.gate.setAiAudible(false);
    this.ports.emitState(this.idleState());
    if (this.lastSpoken.trim().endsWith('?') && turn.onScriptedDone === undefined) this.scheduleSilencePrompt();
  }

  /** Carry on from where the person cut in without saying anything. */
  private resume(): void {
    this.cutOff = false;
    const speaker = this.cutOffSpeaker;
    this.cutOffSpeaker = undefined;
    const scripted = this.pausedScripted;
    this.pausedScripted = undefined;
    if (scripted !== undefined) {
      this.ports.log?.('the person cut in but said nothing recognisable: carrying on scripted cue');
      this.startScripted(scripted.utterance, scripted.onDone);
      return;
    }
    const who = this.human?.name ?? 'The person';
    const speakerHint =
      speaker !== undefined ? ` Begin your reply with "${speaker}:" so ${speaker} finishes their thought first.` : '';
    if (speaker !== undefined) this.forcedSpeaker = { target: speaker, from: speaker };
    this.ports.log?.('the person cut in but said nothing recognisable: carrying on');
    this.lastText = `[${who} made a sound but said nothing. Carry on from where you were cut off, briefly, without mentioning it.${speakerHint}]`;
    this.history.push({ role: 'user', content: this.lastText });
    this.startTurn(true);
  }

  /** Stop the current turn, if any, and keep in the history only what was heard of it. */
  private interrupt(reason: string): void {
    const turn = this.turn;
    if (turn === undefined || turn.finalized) return;
    this.ports.log?.(`interrupted: ${reason}`);
    if (turn.scripted === true) {
      if (
        (reason === 'the person started talking' || reason === 'the person kept talking') &&
        turn.scriptedUtterance !== undefined
      ) {
        const allSentences = splitSentences(turn.scriptedUtterance.text);
        const completedCount = turn.spoken.filter((entry) => entry.complete).length;
        const remaining = allSentences.slice(completedCount).join(' ').trim();
        if (remaining.length > 0) {
          this.cutOff = true;
          this.pausedScripted = {
            utterance: { speaker: turn.scriptedUtterance.speaker, text: remaining },
            onDone: turn.onScriptedDone,
          };
          turn.onScriptedDone = undefined;
        }
      }
    } else {
      if (turn.spoken.length === 0) this.unanswered = true;
      else if (reason === 'the person started talking' || reason === 'the person kept talking') {
        this.cutOff = true;
        this.cutOffSpeaker = turn.spoken.at(-1)?.utterance.speaker;
      }
    }
    turn.aborted = true;
    this.finalize(turn);
    this.turn = undefined;
    turn.abort.abort();
    this.gate.setAiAudible(false);
    this.ports.emitState(this.idleState());
  }

  /**
   * When a colleague promises aloud to check Kaki or pull numbers and report back "in a minute" / "in two minutes",
   * schedule a real callback timer so that colleague genuinely chimes back in with the exact figures from their records!
   */
  private scheduleDeferredFollowUp(turn: Turn): void {
    if (this.closed || this.concluded || this.paused) return;
    const DEFERRED_PROMISE_RE =
      /\b(?:get (?:right )?back to you|come back to you|check (?:kaki|the numbers|the figures|our records)|pull (?:up )?the (?:numbers|figures)|give me)\b[^.?!]*\b(?:in\s+(?:a|one|two|1|2)\s+(?:minutes?|moments?|seconds?)|(?:a|one|two|1|2)\s+(?:minutes?|moments?)|30\s+seconds?|shortly|right\s+back)\b|\b(?:in\s+(?:a|one|two|1|2)\s+(?:minutes?|moments?)|30\s+seconds?)\b[^.?!]*\b(?:get back|come back|share|update|have the (?:numbers|figures))\b/i;
    const promised = [...turn.spoken]
      .reverse()
      .find(({ utterance }) => DEFERRED_PROMISE_RE.test(utterance.text));
    if (promised === undefined) return;
    const speaker = promised.utterance.speaker;
    const promisedTopic = this.currentItem()?.title ?? 'the earlier item';
    const isTwoMin = /\b(?:two|2)\s+minutes\b/i.test(promised.utterance.text);
    const delayMs = isTwoMin ? 75_000 : 45_000;
    this.clearDeferredFollowUpTimer();
    this.ports.log?.(`scheduled real-time callback from ${speaker} in ${Math.round(delayMs / 1000)}s on "${promisedTopic}"`);
    const fire = (): void => {
      this.deferredFollowUpTimer = undefined;
      if (this.closed || this.concluded) return;
      if (
        this.paused ||
        this.humanTalking ||
        this.turn !== undefined ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined ||
        this.pendingAnnouncements > 0
      ) {
        this.deferredFollowUpTimer = setTimeout(fire, 5_000);
        this.deferredFollowUpTimer.unref?.();
        return;
      }
      const who = this.human?.name ?? 'everyone';
      this.forcedSpeaker = { target: speaker, from: speaker };
      this.pending.push(
        `[A minute has passed since ${speaker} promised to check Kaki / pull the figures on "${promisedTopic}". Begin your reply with "${speaker}:". ${speaker} briefly chimes back in to ${who} ("Hey ${who}, quick update — I just pulled those numbers from Kaki...") and shares the exact concrete figures from ${speaker}'s own facts in ONE short sentence, then lets the room continue without derailing the current topic. Do not mention this note.]`,
      );
      this.startTurn();
    };
    this.deferredFollowUpTimer = setTimeout(fire, delayMs);
    this.deferredFollowUpTimer.unref?.();
  }

  private finalize(turn: Turn): void {
    if (turn.finalized) return;
    turn.finalized = true;

    const stripSelfIntro = (speaker: string, text: string): string => {
      const escaped = speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cleaned = text
        .replace(
          new RegExp(
            `^(?:(?:hey|hi|hello)\\s+[a-z]+,\\s*)?(?:and\\s+)?(?:(?:i'm|i am)\\s+${escaped}(?:\\s+here)?|${escaped}\\s+here|(?:i'm|i am)?\\s*${escaped}\\s+(?:from|on|in|your)\\s+[^,—–-]+)(?:\\s*[,—–-]\\s*[^,—–-]+(?:lead|director|manager)|\\s+(?:from|on|in|your)\\s+[^,—–-]+)?\\s*[,—–-]\\s*`,
            'i',
          ),
          '',
        )
        .trim();
      if (cleaned.length === 0) return text;
      return cleaned[0]!.toUpperCase() + cleaned.slice(1);
    };

    const lines = turn.spoken
      .filter(({ complete }) => complete || !this.paused || this.pausedUtterances === undefined)
      .map(({ utterance, complete }) => {
        const historyText = stripSelfIntro(utterance.speaker, utterance.text);
        return complete ? `${utterance.speaker}: ${historyText}` : `${utterance.speaker}: ${historyText} [cut off]`;
      });
    if (lines.length === 0) return;
    if (turn.aborted && (!this.paused || this.pausedUtterances === undefined)) {
      lines.push(`[${this.human?.name ?? 'The person'} interrupted here; nothing after this was said aloud.]`);
    }
    this.history.push({ role: 'assistant', content: lines.join('\n') });
    if (this.history.length > this.maxHistory * 2) this.history = this.history.slice(-this.maxHistory);
  }

  /**
   * The model failed before any of its answer was heard. Retry the exact same turn once, so the
   * visitor's request still gets answered; if that retry fails too, say a natural cue asking them
   * to repeat it instead of showing the raw error. Nothing here creates a task or changes the agenda.
   */
  private recoverFromEmptyTurn(turn: Turn): boolean {
    if (this.closed || this.paused) return false;
    if (turn.recoveryRetry !== true) {
      this.ports.log?.('the model said nothing; retrying the same request once');
      if (turn.forced !== undefined) this.forcedSpeaker = turn.forced;
      this.startTurn(true, true);
      return true;
    }
    const host = this.facilitatorOrCoHost();
    if (host === undefined) return false;
    const who = this.human?.name;
    const line =
      who === undefined
        ? 'Sorry, I lost you for a second there — could you say that again?'
        : `Sorry, ${who}, I lost you for a second there — could you say that again?`;
    // A no-op completion keeps the silence-prompt timer from starting another model turn.
    this.announce(host, line, DEFAULT_ANNOUNCE_GIVE_UP_MS, () => undefined);
    return true;
  }

  private async runTurn(turn: Turn): Promise<void> {
    const { signal } = turn.abort;
    const queue = new SentenceQueue<{ utterance: Utterance; clip: Promise<Clip | undefined> }>();
    signal.addEventListener('abort', () => queue.close(), { once: true });

    this.ports.emitState({ kind: 'thinking' });
    const player = this.playAll(turn, queue);

    const handover = new HandoverGuard(this.names, this.human?.name);
    let safetyRefusalDetected = false;
    const SAFETY_REFUSAL_RE =
      /\b(?:I cannot (?:continue|engage|simulate|proceed|discuss)|I can't (?:continue|proceed|engage)|I can no longer proceed|thoughts of (?:self-harm|suicide)|National Suicide Prevention Lifeline|Crisis Text Line|Samaritans of Singapore|National Care Hotline|professional helpline|call a friend or|step away from the screen|741741|1-800-273-TALK|1-?767|immediate danger|need someone to talk to|sorry to hear (?:that )?you are feeling this way|get the support you need right now|we can pause the meeting so you can take care of yourself|your well-?being is the most important thing)\b/i;
    const enqueue = (utterance: Utterance): void => {
      let trimmed = utterance.text
        .replace(/\s*\[(?:cut off|[^\]]*interrupted here[^\]]*)\]\s*/gi, ' ')
        .replace(/^(?:from|on)\s+the\s+(?:menu|floor|kitchen|tech|pos|marketing|operations|ops|store)\s+side,\s*/i, '')
        .trim();
      if (trimmed.length === 0) return;
      if (trimmed !== utterance.text.trim()) {
        trimmed = trimmed[0]!.toUpperCase() + trimmed.slice(1);
        utterance = { speaker: utterance.speaker, text: trimmed };
      }
      if (this.introduced.has(utterance.speaker)) {
        const escaped = utterance.speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const withoutRepeatIntro = trimmed
          .replace(
            new RegExp(
              `^(?:(?:hey|hi|hello)\\s+[a-z]+,\\s*)?(?:and\\s+)?(?:(?:i'm|i am)\\s+${escaped}(?:\\s+here)?|${escaped}\\s+here|(?:i'm|i am)?\\s*${escaped}\\s+(?:from|on|in|your)\\s+[^,—–-]+)(?:\\s*[,—–-]\\s*[^,—–-]+(?:lead|director|manager)|\\s+(?:from|on|in|your)\\s+[^,—–-]+)?\\s*[,—–-]\\s*`,
              'i',
            ),
            '',
          )
          .trim();
        if (withoutRepeatIntro.length > 0 && withoutRepeatIntro !== trimmed) {
          trimmed = withoutRepeatIntro[0]!.toUpperCase() + withoutRepeatIntro.slice(1);
          utterance = { speaker: utterance.speaker, text: trimmed };
        }
      }
      if (SAFETY_REFUSAL_RE.test(trimmed)) {
        safetyRefusalDetected = true;
        this.ports.log?.(`dropped ${utterance.speaker}'s raw safety refusal line: "${utterance.text}"`);
        return;
      }
      if (
        (trimmed.startsWith('(') && trimmed.endsWith(')')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
        /\bnext up\b/i.test(trimmed) ||
        /\blet's move on to\b/i.test(trimmed) ||
        /\blet's talk about the\b/i.test(trimmed) ||
        /\blet's lock that in and move on\b/i.test(trimmed)
      ) {
        this.ports.log?.(`dropped ${utterance.speaker}'s meta/stage line: "${utterance.text}"`);
        return;
      }
      if (!handover.allow(utterance)) {
        this.ports.log?.(`dropped ${utterance.speaker}'s line after the handover: "${utterance.text}"`);
        return;
      }
      if (turn.firstSentenceAt === undefined) {
        turn.firstSentenceAt = Date.now();
        this.ports.log?.(`first sentence written ${turn.firstSentenceAt - turn.startedAt} ms after the model was asked`);
      }
      const clip = this.ports.synthesize(utterance, signal).catch((error: unknown) => {
        if (!signal.aborted) {
          this.ports.log?.(`could not synthesize "${utterance.text}": ${error instanceof Error ? error.message : String(error)}`);
        }
        return undefined;
      });
      turn.enqueued.push(utterance);
      queue.push({ utterance, clip });
    };

    let failure: unknown;
    try {
      const cast = this.options.scenario.npcs ?? [];
      const addressed = turn.forced?.target ?? addressedCharacter(this.lastText, cast);
      const host = cast.find((npc) => npc.role === 'host')?.attendee;
      const seatNames = this.options.scenario.attendees.map((attendee) => attendee.name);
      const parser = new TurnParser(this.names, addressed ?? host, this.human?.name, seatNames);
      const alreadyAsked =
        this.human !== undefined && this.asked.has(this.human.name) && this.humanLines > this.linesAtMove;
      const includeKnows =
        this.human === undefined || this.humanLines > this.linesAtMove;
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: buildSystemPrompt(
            this.options.scenario,
            this.human,
            this.agendaItem,
            alreadyAsked,
            includeKnows,
            [...this.introduced],
          ),
        },
        ...this.history.slice(-this.maxHistory),
      ];
      const last = messages[messages.length - 1]!;
      const freshHumanLine = last.role === 'user' && !last.content.startsWith('[') ? last.content : undefined;
      if (freshHumanLine !== undefined && this.mode() !== 'observe') {
        if (isSideRequest(freshHumanLine)) {
          messages[messages.length - 1] = {
            ...last,
            content: `${last.content}\n${this.sideRequestNote()}`,
          };
        } else if (
          isSubstantiveProposal(freshHumanLine) ||
          ((this.proposalLines.length >= 1 || this.silencePromptStage >= 2) &&
            /^(?:yes|yeah|yep|sure|ok|okay|alright|all right|fine|agreed|go ahead|please do|do it|let'?s do (?:it|that)|sounds good)\b/i.test(
              freshHumanLine.trim(),
            ))
        ) {
          const assessment = await this.assessVisitorLine(freshHumanLine, signal);
          if (signal.aborted) throw new Error('the turn was interrupted during the readiness check');
          messages[messages.length - 1] = {
            ...last,
            content: `${last.content}\n${this.proposalNote(freshHumanLine, assessment)}`,
          };
        }
      }
      if (addressed !== undefined && last?.role === 'user' && turn.forced === undefined) {
        const currentLast = messages[messages.length - 1]!;
        const who = this.human?.name ?? 'The person';
        messages[messages.length - 1] = {
          ...currentLast,
          content: `${currentLast.content}\n[${who} is speaking directly to ${addressed}. Begin your reply with "${addressed}:". ${addressed} answers first, and nobody else speaks unless ${addressed} hands over by name. If ${who} only said ${addressed}'s name, ${addressed} just acknowledges and invites them to go on.]`,
        };
      }
      for await (const chunk of this.ports.stream(messages, signal)) {
        if (signal.aborted) break;
        if (/\[WINGMAN_NUDGE\]/i.test(chunk)) {
          this.wingmanHintActive = true;
        }
        for (const utterance of parser.push(chunk.replace(/\s*\[WINGMAN_NUDGE\]\s*/gi, ' '))) enqueue(utterance);
      }
      if (!signal.aborted) {
        for (const utterance of parser.flush()) enqueue(utterance);
        if (safetyRefusalDetected) {
          if (this.history.at(-1)?.role === 'user') this.history.pop();
          if (freshHumanLine !== undefined) {
            this.proposalLines = this.proposalLines.filter((line) => line !== freshHumanLine);
          }
          if (turn.enqueued.length === 0) {
            const host = this.facilitatorOrCoHost() ?? this.names[0]!;
            const who = this.human?.name ?? 'friend';
            const careLines = [
              `Hey ${who}, hold on — forget the meeting for a second, are you doing okay? Take all the time you need, we're right here for you.`,
              `${who}, your wellbeing comes way before any launch plan — please take a breather and reach out to someone you trust if you're going through a tough time.`,
              `We care about you, ${who} — let's pause the work pressure, and whenever you want to step away or talk about something else, just say the word.`,
            ];
            let careSpoken = false;
            if (this.refusalCount >= careLines.length) {
              try {
                const careParser = new TurnParser(this.names, host, this.human?.name, seatNames);
                const carePrompt: ChatMessage[] = [
                  {
                    role: 'system',
                    content: `You are ${host}, a warm, caring human colleague in a live video meeting with ${who}. Write ONE short, natural spoken sentence starting with "${host}:" checking in on ${who}'s wellbeing with genuine warmth and telling them there is zero rush on the meeting (vary your phrasing naturally; never sound like an AI or mention hotlines).`,
                  },
                  {
                    role: 'user',
                    content: `Check in warmly on ${who} in your own words (attempt #${this.refusalCount + 1}).`,
                  },
                ];
                for await (const chunk of this.ports.stream(carePrompt, signal)) {
                  if (signal.aborted) break;
                  for (const u of careParser.push(chunk)) {
                    if (!SAFETY_REFUSAL_RE.test(u.text)) {
                      enqueue(u);
                      careSpoken = true;
                    }
                  }
                }
                for (const u of careParser.flush()) {
                  if (!SAFETY_REFUSAL_RE.test(u.text)) {
                    enqueue(u);
                    careSpoken = true;
                  }
                }
              } catch {
                /* fall back to warm in-character line below */
              }
            }
            const text = careLines[this.refusalCount % careLines.length]!;
            this.refusalCount += 1;
            if (!careSpoken && turn.enqueued.length === 0) {
              const careUtterance: Utterance = { speaker: host, text };
              const clip = this.ports.synthesize(careUtterance, signal).catch(() => undefined);
              turn.enqueued.push(careUtterance);
              queue.push({ utterance: careUtterance, clip });
            }
          }
        }
        turn.streamFinished = true;
      }
    } catch (error) {
      if (!signal.aborted) failure = error;
    }

    queue.close();
    await player;
    if (turn.aborted) return;

    this.finalize(turn);
    if (safetyRefusalDetected && this.history.at(-1)?.role === 'assistant') {
      this.history.pop();
    }
    this.turn = undefined;
    this.gate.setAiAudible(false);
    const handedTo =
      failure === undefined
        ? findHandover(turn.spoken.map((entry) => entry.utterance), this.names, this.human?.name)
        : undefined;
    if (handedTo !== undefined) this.scheduleFollowUp(handedTo.from, handedTo.target);
    else if (failure === undefined && turn.spoken.length > 0) {
      this.scheduleDeferredFollowUp(turn);
      this.scheduleObserveAdvance();
      const decisionAdvancing = this.scheduleDecisionAdvance(turn);
      if (!decisionAdvancing) {
        if (!this.lastSpoken.trim().endsWith('?')) {
          const finalSpeaker = turn.spoken.at(-1)?.utterance.speaker;
          const questionFromFinalSpeaker = [...turn.spoken]
            .reverse()
            .find((entry) => entry.utterance.speaker === finalSpeaker && entry.utterance.text.trim().endsWith('?'));
          if (questionFromFinalSpeaker !== undefined) {
            this.lastSpoken = questionFromFinalSpeaker.utterance.text;
          }
        }
        this.scheduleSilencePrompt();
      }
    }
    if (failure !== undefined && turn.spoken.length === 0) {
      const message = failure instanceof Error ? failure.message : String(failure);
      this.ports.log?.(`the model failed: ${message}`);
      if (!this.recoverFromEmptyTurn(turn)) this.ports.emitState({ kind: 'error', message });
    } else {
      this.ports.emitState(this.idleState());
    }
  }

  private async playAll(
    turn: Turn,
    queue: SentenceQueue<{ utterance: Utterance; clip: Promise<Clip | undefined> }>,
    transcribe = true,
  ): Promise<void> {
    const { signal } = turn.abort;
    let previousSpeaker: string | undefined;
    for await (const { utterance, clip } of queue) {
      const audio = await clip;
      if (signal.aborted) return;
      if (audio === undefined) continue;

      const gapMs = previousSpeaker === undefined ? 0 : previousSpeaker === utterance.speaker ? this.sentenceGapMs : this.speakerGapMs;
      if (gapMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, gapMs);
          signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
        });
        if (signal.aborted) return;
      }
      previousSpeaker = utterance.speaker;

      const entry = { utterance, complete: false };
      if (turn.spoken.length === 0) {
        this.ports.log?.(`speaking ${Date.now() - turn.startedAt} ms after the model was asked`);
      }
      this.ports.log?.(`${utterance.speaker}: ${utterance.text}`);
      this.introduced.add(utterance.speaker);
      turn.spoken.push(entry);
      this.gate.setAiAudible(true);
      this.gate.aiSaid(utterance.text);
      this.lastSpoken = utterance.text;
      this.ports.emitState({ kind: 'speaking', speaker: utterance.speaker });
      const transcriptKey = `${utterance.speaker}:${utterance.text}`;
      if (transcribe && transcriptKey !== this.lastTranscriptEmit) {
        this.lastTranscriptEmit = transcriptKey;
        this.ports.emitTranscript(utterance.speaker, utterance.text);
      }

      try {
        await this.ports.play(utterance.speaker, audio, signal);
      } catch (error) {
        if (!signal.aborted) {
          this.ports.log?.(`playback failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (signal.aborted) return;
      entry.complete = true;
    }
  }
}
