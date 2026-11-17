import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  ControlBar,
  GridLayout,
  ParticipantTile,
  RoomAudioRenderer,
  useDataChannel,
  useIsSpeaking,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useTrackRefContext,
  useTracks,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { CONTROL_TOPIC, NPC_STATE_TOPIC, type AgendaItem, type ControlMessage, type KakiEvent, type NpcStateMessage, type Scenario, type Task } from '@kaki/shared';
import { useKaki, useScenario } from '../kaki';
import { ConnectedTypeBar } from './TypeBar';
import { Orb, orbPalette } from './Orb';
import { captionFor, textOnlyNote, transcriptChunks, transcriptNameFor, type TranscriptChunk } from './captions';

const COLLEAGUE_STANCE: Record<string, string> = {
  producer: 'Guards staff, hygiene & margins',
  lead_programmer: 'Keeps POS & kiosks simple',
  engineer: 'Keeps POS & kiosks simple',
  game_designer: 'Protects Kopi & Toast craft',
  designer: 'Protects Kopi & Toast craft',
  marketing_lead: 'Watches TikTok & PR buzz',
  comms: 'Watches TikTok & PR buzz',
  studio_manager: 'Chairs the meeting',
  host: 'Chairs the meeting',
};

function starterChipsFromAgendaItem(
  item: Scenario['agenda'][number] | undefined,
  viewerSeatName: string | undefined,
  openQuestions: ReadonlyArray<{ text: string; forRole?: string }>,
): readonly string[] {
  const chips: string[] = [];
  for (const q of openQuestions) {
    if (q.text.trim().length > 0 && !chips.includes(q.text.trim())) {
      chips.push(q.text.trim());
    }
  }
  const tradeOffs = item?.discussion?.tradeOffs ?? [];
  for (const to of tradeOffs) {
    if (viewerSeatName !== undefined && to.attendee.toLowerCase() === viewerSeatName.toLowerCase()) continue;
    const question = to.question.trim();
    const addressed = question.toLowerCase().startsWith(to.attendee.toLowerCase())
      ? question
      : `${to.attendee}, ${question[0]!.toLowerCase()}${question.slice(1)}`;
    if (!chips.includes(addressed)) chips.push(addressed);
  }
  const fallback = [
    "Sam, could you summarize the two main options we're choosing between right now?",
    // Not a decision: a one-tap "lock it in" line let a visitor close any item without addressing its trade-offs (#53).
    // Locking a decision is the TypeBar's job, which only enables once the room has heard one.
    'Which catch is still open before we lock a plan in?',
  ];
  for (const fb of fallback) {
    if (!chips.includes(fb)) chips.push(fb);
  }
  return chips.slice(0, 2);
}

export function reactionForColleague(
  attendeeName: string,
  events: readonly (KakiEvent & { receivedAt?: number })[],
  now: number,
): { emoji: string; label: string; tone: 'catch' | 'lock' | 'agree' } | undefined {
  const latest = [...events].reverse().find((event) => event.type === 'COLLEAGUE_REACTION' &&
    event.payload.who === attendeeName && event.receivedAt !== undefined &&
    now - event.receivedAt < 4000);
  if (latest?.type !== 'COLLEAGUE_REACTION') return undefined;
  const tone = latest.payload.emoji === '🙌' ? 'lock' : latest.payload.emoji === '👍' ? 'agree' : 'catch';
  return { emoji: latest.payload.emoji, label: 'Reacted', tone };
}

/**
 * Put a speaking participant's track first so a paginated phone stage shows whoever is talking.
 * The order is unchanged when the speaker is already on the visible page.
 */
export function tracksWithSpeakerFirst<T extends { participant: { identity: string } }>(
  tracks: readonly T[],
  speaker: string | undefined,
): T[] {
  if (speaker === undefined) return [...tracks];
  const index = tracks.findIndex((track) => track.participant.identity === speaker);
  if (index <= 0) return [...tracks];
  const reordered = [...tracks];
  const [speaking] = reordered.splice(index, 1);
  if (speaking !== undefined) reordered.unshift(speaking);
  return reordered;
}

interface Stage {
  scenario: Scenario;
  chunks: TranscriptChunk[];
  events: KakiEvent[];
  now: number;
  npcState: NpcStateMessage;
  waitingForHuman: boolean;
  activeItemOwnerRole?: string;
}

const StageContext = createContext<Stage | null>(null);

function useStage(): Stage {
  const stage = useContext(StageContext);
  if (stage === null) throw new Error('useStage must be used inside MeetingGrid');
  return stage;
}

function CaptionedTile() {
  const { scenario, chunks, events, now, npcState } = useStage();
  const participant = useTrackRefContext().participant;
  const aiIndex = (scenario.npcs ?? []).findIndex((npc) => npc.attendee === participant.identity);
  const isAi = aiIndex >= 0;
  const humanSpeaking = useIsSpeaking(participant);
  const serverHumanSpeaking = !isAi && 'humanSpeaking' in npcState && npcState.humanSpeaking === true;
  const serverTranscribing = !isAi && 'transcribing' in npcState && npcState.transcribing === true;
  const speaking = isAi
    ? npcState.kind === 'speaking' && npcState.speaker === participant.identity
    : humanSpeaking || serverHumanSpeaking;
  const speakerAliases = isAi
    ? []
    : [participant.name ?? '', participant.identity, 'Guest'].filter((s) => s.trim().length > 0);
  const recognizedCaption = captionFor(
    chunks,
    transcriptNameFor(scenario, participant),
    now,
    isAi ? 8000 : 10000,
    speaking,
    speakerAliases,
  );
  const caption =
    !isAi && (humanSpeaking || serverHumanSpeaking)
      ? '🎙️ Speaking…'
      : !isAi && serverTranscribing
        ? '⏳ Transcribing…'
        : recognizedCaption;
  const thinking = isAi && npcState.kind === 'thinking';
  const state = speaking ? 'speaking' : thinking ? 'thinking' : 'idle';
  const attendee = isAi ? scenario.attendees.find((candidate) => candidate.name === participant.identity) : undefined;
  const roleTitle = isAi
    ? scenario.roles.find((role) => role.id === attendee?.role)?.label
    : participant.metadata?.trim() || undefined;
  const stance = isAi && attendee?.role !== undefined ? COLLEAGUE_STANCE[attendee.role] : undefined;
  const reaction = isAi
    ? reactionForColleague(participant.identity, events, now)
    : undefined;

  return (
    <div className="kd-tile" data-state={state} data-ai={isAi} style={{ ['--c' as string]: `var(${orbPalette(isAi ? aiIndex : 1)[0]})` }}>
      {isAi ? <Orb state={state} palette={orbPalette(aiIndex)} /> : <ParticipantTile style={{ width: '100%', height: '100%' }} />}
      <div className="kd-who">
        <i />
        <div className="kd-who-text">
          <div className="kd-who-line">
            <span>{isAi ? participant.identity : `${participant.name || participant.identity} (You)`}</span>
            {roleTitle !== undefined && <small className="kd-who-role">· {roleTitle}</small>}
          </div>
          {stance !== undefined && <small className="kd-who-stance">{stance}</small>}
        </div>
      </div>
      {reaction !== undefined && (
        <div
          className="kd-reaction-badge"
          data-tone={reaction.tone}
          style={{ ['--reaction-delay' as string]: `${(Math.max(0, aiIndex) % 3) * 240}ms` }}
          aria-label={`${participant.identity}: ${reaction.label}`}
        >
          <span className="kd-reaction-emoji">{reaction.emoji}</span>
        </div>
      )}
      {isAi && <div className="kd-state">{state}</div>}
      {caption !== null && (
        <div key={caption} className="kd-caption">
          {caption}
        </div>
      )}
    </div>
  );
}

/**
 * The fact this seat holds for this topic, when the scenario gives each seat one. This is the
 * source of truth for the Wingman card.
 */
export function cardFactForItem(item: AgendaItem | undefined, role: string): string | undefined {
  return item?.seatFacts?.[role];
}

/**
 * The visitor's open task the stage banner should announce: their task on the current topic when there is
 * one, otherwise the most recently updated open task. Map order alone would keep announcing topic 1's draft
 * after the meeting has moved on.
 */
export function activeStageTaskFor(
  tasks: Iterable<Task>,
  role: string,
  currentAgendaTitle: string | undefined,
): Task | undefined {
  const openTasks = [...tasks].filter(
    (t) =>
      (t.assignee ?? t.suggestedAssignee) === role &&
      (t.status === 'DISPATCHED' || t.status === 'DRAFT_READY'),
  );
  if (currentAgendaTitle !== undefined) {
    const onCurrentTopic = openTasks.find((t) => t.agendaItemTitle === currentAgendaTitle);
    if (onCurrentTopic !== undefined) return onCurrentTopic;
  }
  return openTasks.reduce<Task | undefined>(
    (latest, task) => (latest === undefined || task.updatedAt >= latest.updatedAt ? task : latest),
    undefined,
  );
}

/** The meeting stage: one tile per participant with live captions, and the AI attendees' status. */
export function MeetingGrid({
  role,
  onOpenKaki,
  onKakiBadgeChange,
}: {
  role: string;
  onOpenKaki?: () => void;
  onKakiBadgeChange?: (count: number) => void;
}) {
  const scenario = useScenario();
  const room = useRoomContext();
  const { isMicrophoneEnabled } = useLocalParticipant();
  const { events } = useKaki(role);
  const { events: screenEvents, tasks: screenTasks } = useKaki('screen');
  const participants = useParticipants();
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  // Captions fade by the clock, so the stage re-renders twice a second.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, []);

  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 700px)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 700px)');
    const update = (): void => setNarrow(query.matches);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  const [npcState, setNpcState] = useState<NpcStateMessage>({ kind: 'idle' });
  useDataChannel(NPC_STATE_TOPIC, (message) => {
    try {
      setNpcState(JSON.parse(new TextDecoder().decode(message.payload)) as NpcStateMessage);
    } catch {
      // not a message from the AI attendees
    }
  });

  const aiNames = useMemo(() => new Set((scenario.npcs ?? []).map((npc) => npc.attendee)), [scenario]);
  const aiPresent = participants.some((participant) => aiNames.has(participant.identity));
  const chunks = useMemo(() => transcriptChunks(events), [events]);
  const voiceNote = textOnlyNote(chunks, now);
  const facilitatorName = useMemo(() => {
    const hostRole = scenario.roles.find((r) => r.facilitator === true);
    return scenario.attendees.find((a) => a.role === hostRole?.id)?.name ?? 'Sam';
  }, [scenario]);
  const activeAgendaIndex = useMemo(() => {
    const latestRecord = [...screenEvents].reverse().find((e) => e.type === 'MEETING_RECORD_UPDATED');
    return latestRecord?.type === 'MEETING_RECORD_UPDATED' ? latestRecord.payload.agendaIndex : 0;
  }, [screenEvents]);

  // The agenda record only goes to the screen audience, so these must read the screen feed: it carries both that
  // record and every transcript line, in order.
  const hasColleagueBriefed = useMemo(() => {
    let currentIdx = 0;
    let sawCurrentItemBrief = false;
    for (const event of screenEvents) {
      if (event.type === 'MEETING_RECORD_UPDATED') {
        if (event.payload.agendaIndex !== currentIdx) {
          currentIdx = event.payload.agendaIndex;
          sawCurrentItemBrief = false;
        }
      } else if (
        event.type === 'TRANSCRIPT_CHUNK' &&
        currentIdx === activeAgendaIndex &&
        !event.payload.speaker.startsWith(facilitatorName)
      ) {
        sawCurrentItemBrief = true;
      }
    }
    return sawCurrentItemBrief;
  }, [screenEvents, facilitatorName, activeAgendaIndex]);
  const hasVisitorSpokenOnTopic = useMemo(() => {
    const npcNameSet = new Set((scenario.npcs ?? []).map((n) => n.attendee.toLowerCase()));
    let currentIdx = 0;
    let spoken = false;
    for (const event of screenEvents) {
      if (event.type === 'MEETING_RECORD_UPDATED') {
        if (event.payload.agendaIndex !== currentIdx) {
          currentIdx = event.payload.agendaIndex;
          spoken = false;
        }
      } else if (event.type === 'TRANSCRIPT_CHUNK' && currentIdx === activeAgendaIndex) {
        const cleanSpeaker = event.payload.speaker.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
        if (cleanSpeaker.length > 0 && !npcNameSet.has(cleanSpeaker)) {
          spoken = true;
        }
      }
    }
    return spoken;
  }, [screenEvents, scenario.npcs, activeAgendaIndex]);
  const waitingForHuman =
    npcState.kind === 'idle' && npcState.yourTurn !== undefined && hasColleagueBriefed;
  const idleAfterBriefing = npcState.kind === 'idle' && hasColleagueBriefed;
  const [showStarterIdeas, setShowStarterIdeas] = useState(false);
  const [turnWaitStartAt, setTurnWaitStartAt] = useState<number | null>(null);
  const [dismissedWingmanGlideKey, setDismissedWingmanGlideKey] = useState<string>('');
  const [latchedSemanticWingmanIdx, setLatchedSemanticWingmanIdx] = useState<number | null>(null);
  const [latchedWaitWingmanIdx, setLatchedWaitWingmanIdx] = useState<number | null>(null);

  useEffect(() => {
    setShowStarterIdeas(false);
    setLatchedSemanticWingmanIdx(null);
    setLatchedWaitWingmanIdx(null);
  }, [activeAgendaIndex]);

  useEffect(() => {
    if ('wingmanHint' in npcState && npcState.wingmanHint === true) {
      setLatchedSemanticWingmanIdx(activeAgendaIndex);
    }
  }, [npcState, activeAgendaIndex]);

  useEffect(() => {
    if (!idleAfterBriefing) {
      setTurnWaitStartAt(null);
    } else {
      setTurnWaitStartAt((prev) => prev ?? Date.now());
    }
  }, [idleAfterBriefing]);

  useEffect(() => {
    if (idleAfterBriefing && turnWaitStartAt !== null && now - turnWaitStartAt >= 10_000) {
      setLatchedWaitWingmanIdx(activeAgendaIndex);
    }
  }, [idleAfterBriefing, turnWaitStartAt, now, activeAgendaIndex]);
  const activeItem = scenario.agenda[activeAgendaIndex];
  const activeOwnerRole = activeItem?.ownerRole ?? role;
  const stage = useMemo(
    () => ({ scenario, chunks, events, now, npcState, waitingForHuman, activeItemOwnerRole: activeOwnerRole }),
    [scenario, chunks, events, now, npcState, waitingForHuman, activeOwnerRole],
  );

  const wingmanFactPreview = useMemo(() => {
    const seatFact = cardFactForItem(activeItem, role);
    if (seatFact !== undefined) return seatFact;
    let latestFactText: string | undefined;
    for (const event of events) {
      if (
        event.type === 'FACT_FOUND' &&
        event.payload.facts.length > 0 &&
        event.payload.agendaIndex === activeAgendaIndex
      ) {
        const text = event.payload.facts[0]?.text;
        if (text !== undefined) latestFactText = text;
      }
    }
    if (latestFactText !== undefined) return latestFactText;
    return undefined;
  }, [events, role, activeItem, activeAgendaIndex]);

  const starterChips = useMemo(() => {
    const viewerSeatName = scenario.attendees.find((a) => a.role === role)?.name;
    const latestRecord = [...screenEvents].reverse().find((e) => e.type === 'MEETING_RECORD_UPDATED');
    const openQs = latestRecord?.type === 'MEETING_RECORD_UPDATED' ? latestRecord.payload.openQuestions : [];
    return starterChipsFromAgendaItem(activeItem, viewerSeatName, openQs);
  }, [activeItem, role, scenario.attendees, screenEvents]);

  const sendQuickLine = useCallback(
    (text: string) => {
      window.dispatchEvent(new Event('kaki:quick-line'));
      const msg: ControlMessage = { kind: 'text', text };
      room.localParticipant
        .publishData(new TextEncoder().encode(JSON.stringify(msg)), { reliable: true, topic: CONTROL_TOPIC })
        .catch(() => undefined);
    },
    [room],
  );

  const [dismissedToastKey, setDismissedToastKey] = useState<string>('');
  const actionableMyTasksCount = useMemo(() => {
    const allTasks = [...screenTasks.values()];
    return allTasks.filter(
      (t) =>
        (t.assignee ?? t.suggestedAssignee) === role &&
        (t.status === 'DISPATCHED' || t.status === 'DRAFT_READY'),
    ).length;
  }, [screenTasks, role]);

  useEffect(() => {
    onKakiBadgeChange?.(actionableMyTasksCount);
  }, [actionableMyTasksCount, onKakiBadgeChange]);

  const wingmanGlideNudge = useMemo(() => {
    if (wingmanFactPreview === undefined) return undefined;
    const semanticWingmanHint =
      ('wingmanHint' in npcState && npcState.wingmanHint === true) ||
      latchedSemanticWingmanIdx === activeAgendaIndex;
    let hasSemanticFactOrNudgeOnTopic = false;
    for (const event of events) {
      if (
        (event.type === 'FACT_FOUND' || event.type === 'NUDGE') &&
        event.payload.agendaIndex === activeAgendaIndex &&
        hasColleagueBriefed
      ) {
        hasSemanticFactOrNudgeOnTopic = true;
      }
    }
    const waitedLongEnough =
      (idleAfterBriefing && turnWaitStartAt !== null && now - turnWaitStartAt >= 10_000) ||
      latchedWaitWingmanIdx === activeAgendaIndex;
    if (!semanticWingmanHint && !hasSemanticFactOrNudgeOnTopic && !waitedLongEnough) return undefined;
    const key = semanticWingmanHint
      ? `glide-semantic:${activeAgendaIndex}`
      : hasSemanticFactOrNudgeOnTopic
        ? `glide-fact:${activeAgendaIndex}`
        : `glide-wait:${activeAgendaIndex}`;
    const proposalChip = /^Consider proposing:\s*/i.test(wingmanFactPreview)
      ? wingmanFactPreview.replace(/^Consider proposing:\s*/i, '').trim()
      : undefined;
    return {
      key,
      reason: semanticWingmanHint || hasSemanticFactOrNudgeOnTopic
        ? '✨ Kaki Wingman · Store fact for this question'
        : '✨ Kaki Wingman · Quick tip for your turn',
      fact: wingmanFactPreview,
      chip: proposalChip ?? starterChips[0],
      isDirectProposal: proposalChip !== undefined,
    };
  }, [wingmanFactPreview, npcState, latchedSemanticWingmanIdx, latchedWaitWingmanIdx, events, activeAgendaIndex, hasColleagueBriefed, idleAfterBriefing, turnWaitStartAt, now, starterChips]);

  const activeStageToast = useMemo(() => {
    const allTasks = [...screenTasks.values()];
    const myTask = activeStageTaskFor(allTasks, role, activeItem?.title);
    if (myTask !== undefined) {
      const key = `task:${myTask.id}:${myTask.status}`;
      return {
        key,
        badge: myTask.status === 'DRAFT_READY' ? 'Kaki Action · Draft Ready' : 'Kaki Action · Assigned to You',
        text:
          myTask.status === 'DRAFT_READY'
            ? narrow
              ? `"${myTask.title}" is drafted — review in Kaki →`
              : `"${myTask.title}" is drafted. Review and click Approve & publish in Kaki →`
            : narrow
              ? `"${myTask.title}" needs you in Kaki →`
              : `"${myTask.title}": click "Let Kaki do it" in Kaki →`,
      };
    }
    const publishedTask = [...allTasks]
      .reverse()
      .find((t) => (t.status === 'COMPLETED' || t.status === 'SYNCED') && t.artifactUrl !== undefined);
    if (publishedTask !== undefined) {
      const key = `published:${publishedTask.id}:${publishedTask.status}`;
      return {
        key,
        badge: 'Kaki Action · Published',
        text: `"${publishedTask.title}" is live. Open it in Kaki →`,
      };
    }
    let latestFactOnCurrentTopic: Extract<typeof events[number], { type: 'FACT_FOUND' }> | undefined;
    for (const event of events) {
      if (
        event.type === 'FACT_FOUND' &&
        event.payload.facts.length > 0 &&
        event.payload.agendaIndex === activeAgendaIndex
      ) {
        latestFactOnCurrentTopic = event;
      }
    }
    if (latestFactOnCurrentTopic !== undefined && hasColleagueBriefed) {
      const key = `fact:${activeAgendaIndex}:${latestFactOnCurrentTopic.payload.question}`;
      return {
        key,
        badge: 'Kaki Wingman · Record Found',
        text: `${latestFactOnCurrentTopic.payload.facts[0]?.text ?? latestFactOnCurrentTopic.payload.question} (open Kaki →)`,
      };
    }
    return undefined;
  }, [screenTasks, events, role, hasColleagueBriefed, activeAgendaIndex, activeItem, narrow]);

  const speakingSpeaker = npcState.kind === 'speaking' ? npcState.speaker : undefined;
  const gridTracks = useMemo(
    () => (narrow ? tracksWithSpeakerFirst(tracks, speakingSpeaker) : tracks),
    [narrow, tracks, speakingSpeaker],
  );
  const meetingWrappedUp = useMemo(
    () => screenEvents.some((event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING'),
    [screenEvents],
  );
  const topicSettled = useMemo(() => {
    const title = activeItem?.title;
    if (title === undefined) return false;
    return [...screenTasks.values()].some(
      (task) => task.agendaItemTitle === title && task.status !== 'SUGGESTED',
    );
  }, [screenTasks, activeItem]);
  const wingmanBannerVisible =
    wingmanGlideNudge !== undefined &&
    wingmanGlideNudge.key !== dismissedWingmanGlideKey &&
    !meetingWrappedUp &&
    !topicSettled &&
    !(narrow && activeStageToast !== undefined);
  const stageToastVisible =
    activeStageToast !== undefined &&
    activeStageToast.key !== dismissedToastKey &&
    !meetingWrappedUp &&
    (!topicSettled || activeStageToast.key.startsWith('task:') || activeStageToast.key.startsWith('published:')) &&
    !(!narrow && activeStageToast.key.startsWith('task:') && actionableMyTasksCount > 0) &&
    (wingmanBannerVisible ? activeStageToast.key.startsWith('task:') : true);

  return (
    <StageContext.Provider value={stage}>
      <div className="kd-stage-col">
        {npcState.kind === 'error' && (
          <div role="alert" className="kd-banner" data-tone="error">
            The AI attendees hit a problem: {npcState.message}
          </div>
        )}
        {!aiPresent && (
          <div className="kd-banner">
            Waiting for the AI attendees. Start them with <code>npm run npc</code>.
          </div>
        )}
        {wingmanBannerVisible && wingmanGlideNudge !== undefined && (
          <div
            className="kd-wingman-glide"
            role="status"
            aria-live="polite"
          >
            <div
              className="kd-wingman-glide-main"
              onClick={() => {
                onOpenKaki?.();
                document.querySelector('.kd-topic-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              }}
              style={{ cursor: 'pointer' }}
            >
              <span className="kd-wingman-glide-badge">{wingmanGlideNudge.reason}</span>
              <p className="kd-wingman-glide-fact">{wingmanGlideNudge.fact}</p>
            </div>
            <div className="kd-wingman-glide-actions">
              {wingmanGlideNudge.isDirectProposal && wingmanGlideNudge.chip !== undefined ? (
                <button
                  type="button"
                  className="kd-wingman-glide-btn kd-wingman-glide-btn-say"
                  onClick={() => {
                    sendQuickLine(wingmanGlideNudge.chip!);
                    setDismissedWingmanGlideKey(wingmanGlideNudge.key);
                  }}
                >
                  💬 Say this proposal
                </button>
              ) : (
                <button
                  type="button"
                  className="kd-wingman-glide-btn kd-wingman-glide-btn-say"
                  onClick={() => {
                    setShowStarterIdeas(true);
                    setDismissedWingmanGlideKey(wingmanGlideNudge.key);
                  }}
                >
                  💡 See what to say
                </button>
              )}
              <button
                type="button"
                className="kd-wingman-glide-btn"
                onClick={() => {
                  onOpenKaki?.();
                  document.querySelector('.kd-topic-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                  setDismissedWingmanGlideKey(wingmanGlideNudge.key);
                }}
              >
                Open Kaki panel →
              </button>
              <button
                type="button"
                className="kd-stage-toast-close"
                aria-label="Dismiss Wingman tip"
                onClick={() => setDismissedWingmanGlideKey(wingmanGlideNudge.key)}
              >
                ✕
              </button>
            </div>
          </div>
        )}
        {stageToastVisible && activeStageToast !== undefined && (
          <div
            className="kd-stage-toast"
            role="status"
            aria-live="polite"
            onClick={() => {
              onOpenKaki?.();
              const targetSelector = activeStageToast.key.startsWith('task:')
                ? '.kd-role-active'
                : activeStageToast.key.startsWith('published:')
                  ? '.kd-role-active, .kd-tasks'
                  : '.kd-topic-card';
              document.querySelector(targetSelector)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }}
            style={{ cursor: 'pointer' }}
          >
            <span className="kd-stage-toast-badge">{activeStageToast.badge}</span>
            <span className="kd-stage-toast-text">{activeStageToast.text}</span>
            <button
              type="button"
              className="kd-stage-toast-close"
              aria-label="Dismiss notification"
              onClick={(event) => {
                event.stopPropagation();
                setDismissedToastKey(activeStageToast.key);
              }}
            >
              ✕
            </button>
          </div>
        )}
        <div className="kd-grid-wrap">
          <GridLayout tracks={gridTracks} style={{ height: '100%' }}>
            <CaptionedTile />
          </GridLayout>
        </div>
        {voiceNote !== null && (
          <div className="kd-caption-note" role="status" aria-live="polite">
            {voiceNote}
          </div>
        )}
        {(idleAfterBriefing || showStarterIdeas) && !meetingWrappedUp && !topicSettled && (
          <div className="kd-turn-bar" role="region" aria-label="Your turn and starter questions">
            <div className="kd-turn-row">
              <span className="kd-turn-pill">
                {showStarterIdeas
                  ? '🟢 Click any line below to say it immediately (or speak/type)'
                  : waitingForHuman
                    ? '🟢 Your turn — speak on mic or type below'
                    : '💬 Jump in anytime — speak, type, or click Need an idea?'}
              </span>
              <button
                type="button"
                className="kd-turn-idea-btn"
                aria-expanded={showStarterIdeas}
                onClick={() => setShowStarterIdeas((prev) => !prev)}
              >
                {showStarterIdeas ? 'Hide ideas' : '💡 Need an idea?'}
              </button>
            </div>
            {showStarterIdeas && (
              <div className="kd-starter-chips">
                {starterChips.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    className="kd-starter-chip"
                    onClick={() => {
                      sendQuickLine(chip);
                      setShowStarterIdeas(false);
                    }}
                  >
                    💬 {chip}
                  </button>
                ))}
                {hasVisitorSpokenOnTopic && (
                  <button
                    type="button"
                    className="kd-starter-chip"
                    onClick={() => {
                      sendQuickLine(
                        "We're split on this — let's table it for now and set up a follow-up to settle it later.",
                      );
                      setShowStarterIdeas(false);
                    }}
                  >
                    ⏭️ Table topic &amp; set a follow-up
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <ConnectedTypeBar micOnline={isMicrophoneEnabled} />
        <ControlBar controls={{ screenShare: false, chat: false }} />
        <RoomAudioRenderer />
      </div>
    </StageContext.Provider>
  );
}
