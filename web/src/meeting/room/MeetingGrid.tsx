import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ControlBar,
  GridLayout,
  RoomAudioRenderer,
  useDataChannel,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useTracks,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import {
  CONTROL_TOPIC,
  isKakiListener,
  NPC_STATE_TOPIC,
  parseSpeechStatusMessage,
  roleLabel,
  SPEECH_STATUS_TOPIC,
  type ControlMessage,
  type NpcStateMessage,
  type SpeechStatusMessage,
} from '@kaki/shared';
import { useKaki, useScenario } from '../../kaki';
import { ConnectedTypeBar } from './TypeBar';
import { CaptionedTile, StageContext } from './CaptionedTile';
import { activeStageTaskFor, cardFactForItem, newClientLineId, starterChipsFromAgendaItem, tracksWithSpeakerFirst, visibleStageTracks } from './stageModel';
import { textOnlyNote, transcriptChunks } from './captions';

/** The meeting stage: one tile per participant with live captions, and the AI attendees' status. */
export function MeetingGrid({
  role,
  onOpenKaki,
  onKakiBadgeChange,
  onLeave,
  sharedAudience = 'screen',
}: {
  role: string;
  onOpenKaki?: () => void;
  onKakiBadgeChange?: (count: number) => void;
  /** Leaves the meeting. LiveKit's own Leave only disconnects, which the page cannot tell apart from a reload. */
  onLeave?: () => void;
  /** A team participant reads the seat-bound projection; the owner and practice keep the screen. */
  sharedAudience?: 'screen' | 'participant';
}) {
  const scenario = useScenario();
  const room = useRoomContext();
  const { isMicrophoneEnabled, localParticipant } = useLocalParticipant();
  const { events, send: sendToServer, rejection: commandRejection } = useKaki({ kind: 'role', role });
  const { events: screenEvents, latestRecord, speechByTopic, tasks: screenTasks } = useKaki(sharedAudience === 'participant' ? { kind: 'participant' } : { kind: 'screen' });
  // One path for every line the person produces: the server writes it whether or not an AI runner is up.
  const sendHumanLine = useCallback(
    (text: string, source: 'speech' | 'typed') => {
      sendToServer({ type: 'HUMAN_LINE', text, source, clientLineId: newClientLineId() });
    },
    [sendToServer],
  );
  const sendTypedLine = useCallback((text: string) => sendHumanLine(text, 'typed'), [sendHumanLine]);
  const participants = useParticipants().filter((participant) => !isKakiListener(participant.identity));
  const tracks = visibleStageTracks(
    useTracks(
      [
        { source: Track.Source.Camera, withPlaceholder: true },
        { source: Track.Source.ScreenShare, withPlaceholder: false },
      ],
      { onlySubscribed: false },
    ),
    scenario,
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

  const [speechStatus, setSpeechStatus] = useState<SpeechStatusMessage>({ participants: {} });
  useDataChannel(SPEECH_STATUS_TOPIC, (message) => {
    try {
      const parsed = parseSpeechStatusMessage(JSON.parse(new TextDecoder().decode(message.payload)));
      if (parsed !== undefined) setSpeechStatus(parsed);
    } catch {
      // not a speech-status message
    }
  });

  const aiNames = useMemo(() => new Set((scenario.npcs ?? []).map((npc) => npc.attendee)), [scenario]);
  const aiPresent = participants.some((participant) => aiNames.has(participant.identity));
  const speechRecording = useMemo(() => {
    for (let index = screenEvents.length - 1; index >= 0; index -= 1) {
      const event = screenEvents[index]!;
      if (event.type === 'SPEECH_RECORDING') return event.payload.recording;
    }
    return undefined;
  }, [screenEvents]);
  const ownIdentity = localParticipant?.identity;
  const ownSpeechFailure =
    ownIdentity === undefined ? undefined : speechStatus.participants[ownIdentity]?.state === 'failed'
      ? speechStatus.participants[ownIdentity]
      : undefined;
  const speechNotice = useMemo(() => {
    if (speechStatus.outage !== undefined) {
      return {
        key: `outage:${speechStatus.outage.message}`,
        text:
          ownSpeechFailure === undefined
            ? speechStatus.outage.message
            : `${speechStatus.outage.message} Your last line was not heard: repeat it or type it.`,
      };
    }
    if (ownSpeechFailure !== undefined) {
      return {
        key: `failed:${ownSpeechFailure.message ?? 'failed'}`,
        text: ownSpeechFailure.message ?? 'Kaki could not hear that. Please repeat it, or type it instead.',
      };
    }
    return undefined;
  }, [speechStatus.outage, ownSpeechFailure]);
  const chunks = useMemo(() => transcriptChunks(events), [events]);
  const voiceNote = textOnlyNote(chunks, now);
  const facilitatorName = useMemo(() => {
    const hostRole = scenario.roles.find((r) => r.facilitator === true);
    if (hostRole === undefined) return 'the host';
    return scenario.attendees.find((a) => a.role === hostRole.id)?.name ?? roleLabel(scenario, hostRole.id);
  }, [scenario]);
  const facilitatorRole = useMemo(
    () => scenario.roles.find((role) => role.facilitator === true)?.id,
    [scenario.roles],
  );
  const activeAgendaIndex = latestRecord?.payload.agendaIndex ?? 0;
  // The pause button follows the server's latest record, so a reload, another seat's Stop or an
  // empty-room auto-pause all show the same truth the meeting clock has.
  const serverPaused = latestRecord?.payload.paused === true;

  // Who spoke is recorded by the hook as each line arrives, so it survives the record leaving the
  // 50-event window. Exact seats come from speakerRole; names only for older lines without one.
  const hasColleagueBriefed = useMemo(() => {
    const speech = speechByTopic.get(activeAgendaIndex);
    if (speech === undefined) return false;
    for (const speakerRole of speech.roles) {
      if (speakerRole !== facilitatorRole) return true;
    }
    const facilitator = facilitatorName.toLowerCase();
    for (const speaker of speech.names) {
      if (!speaker.startsWith(facilitator)) return true;
    }
    return false;
  }, [speechByTopic, facilitatorRole, facilitatorName, activeAgendaIndex]);
  const hasVisitorSpokenOnTopic = useMemo(() => {
    const speech = speechByTopic.get(activeAgendaIndex);
    if (speech === undefined) return false;
    if (speech.roles.has(role)) return true;
    const npcNameSet = new Set((scenario.npcs ?? []).map((n) => n.attendee.toLowerCase()));
    for (const speaker of speech.names) {
      if (!npcNameSet.has(speaker)) return true;
    }
    return false;
  }, [speechByTopic, scenario.npcs, activeAgendaIndex, role]);
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
    () => ({
      scenario, chunks, events, now, npcState, speechStatus, waitingForHuman,
      activeItemOwnerRole: activeOwnerRole, activeAgendaIndex,
    }),
    [scenario, chunks, events, now, npcState, speechStatus, waitingForHuman, activeOwnerRole, activeAgendaIndex],
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
    const openQs = latestRecord?.payload.openQuestions.filter(
      (question) => question.agendaIndex === activeAgendaIndex,
    ) ?? [];
    const hostName = facilitatorRole === undefined ? undefined : facilitatorName;
    return starterChipsFromAgendaItem(activeItem, viewerSeatName, openQs, hostName);
  }, [activeItem, role, scenario.attendees, latestRecord, activeAgendaIndex, facilitatorName, facilitatorRole]);

  const sendQuickLine = useCallback(
    (text: string) => {
      window.dispatchEvent(new Event('kaki:quick-line'));
      const msg: ControlMessage = { kind: 'text', text };
      room.localParticipant
        .publishData(new TextEncoder().encode(JSON.stringify(msg)), { reliable: true, topic: CONTROL_TOPIC })
        .catch(() => undefined);
      sendHumanLine(text, 'typed');
    },
    [room, sendHumanLine],
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
        {speechRecording === false && (
          <div role="alert" className="kd-banner" data-tone="error">
            Speech is not being recorded: the AI service is not connected. Start it with{' '}
            <code>npm run npc</code>.
          </div>
        )}
        {speechNotice !== undefined && (
          <div role="alert" className="kd-banner" data-tone="error">
            {speechNotice.text}{' '}
            <button
              type="button"
              onClick={() => document.querySelector<HTMLInputElement>('.kd-typebar input')?.focus()}
            >
              Type it instead
            </button>
          </div>
        )}
        {(scenario.npcs ?? []).length > 0 && !aiPresent && (
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
        <ConnectedTypeBar
          micOnline={isMicrophoneEnabled}
          paused={serverPaused}
          onTextSent={sendTypedLine}
          pauseRejection={commandRejection}
          lineRejection={commandRejection}
          onPauseChange={(paused) => sendToServer({ type: 'SET_PAUSED', paused })}
        />
        <div className="kd-controls">
          <ControlBar controls={{ screenShare: false, chat: false, leave: onLeave === undefined }} />
          {onLeave === undefined ? null : (
            <button
              type="button"
              className="lk-button lk-disconnect-button"
              onClick={() => {
                void room.disconnect().catch(() => undefined);
                onLeave();
              }}
            >
              Leave
            </button>
          )}
        </div>
        <RoomAudioRenderer />
      </div>
    </StageContext.Provider>
  );
}
