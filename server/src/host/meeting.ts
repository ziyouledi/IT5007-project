import type { KakiEvent } from '@kaki/shared';
import type { LlmClient } from '../llm';
import type { KakiContext, KakiModule } from '../modules';
import { createAgendaClock } from './clock';
import { createNotetaker } from './notetaker';
import { loadReplay, startReplay, type ReplayLine } from './replay';

const TICK_MS = 1_000;
const DEFAULT_NOTETAKER_INTERVAL_MS = 7_000;
/** Republish an unchanged record after this much meeting time so clients can resync their clocks. */
const HEARTBEAT_MEETING_SECONDS = 30;
/** Talk time is compared at this granularity, so every transcript line does not cause a publish. */
const TALK_STEP_SECONDS = 10;

/** How the meeting module runs; `hostModules` builds this from the environment. */
export interface MeetingModuleOptions {
  llm?: LlmClient;
  /** Play the scenario's scripted transcript; pass lines directly in tests. */
  replay?: boolean | ReplayLine[];
  /** Meeting time per real second while replaying (2 = twice as fast). */
  speed?: number;
  notetakerIntervalMs?: number;
}

/**
 * The meeting record: agenda clock, notetaker and (optionally) the replay feed.
 * The clock starts on the first transcript line, live or replayed.
 */
export function createMeetingModule({
  llm,
  replay = false,
  speed = 1,
  notetakerIntervalMs = DEFAULT_NOTETAKER_INTERVAL_MS,
}: MeetingModuleOptions = {}): KakiModule {
  return {
    name: 'host-meeting',
    start({ hub, tasks, scenario }: KakiContext) {
      const clock = createAgendaClock({ agenda: scenario.agenda, speed });
      const notetaker = createNotetaker({
        scenario,
        tasks,
        llm,
        agendaIndex: () => clock.snapshot().agendaIndex,
        onAgendaIndex: (index) => {
          clock.advanceTo(index);
          publishRecord();
        },
      });
      if (llm === undefined) console.warn('kaki host: no LLM configured; the notetaker only tracks talk time');

      let lastSignature: string | undefined;
      let lastPublishedAt = 0;

      // Clients keep every record they receive, so publish only when something people see has
      // changed, plus a heartbeat; between records, clients count elapsedSeconds up themselves.
      function publishRecord(): void {
        const now = clock.snapshot();
        if (!now.started) return;
        const { openQuestions, talkSecondsFor, status, quietRoles } = notetaker.state();
        const talk = talkSecondsFor(now.agendaIndex);
        const signature = JSON.stringify([
          now.agendaIndex,
          now.overrun,
          openQuestions,
          status,
          quietRoles,
          Object.entries(talk).map(([role, seconds]) => [role, Math.floor((seconds ?? 0) / TALK_STEP_SECONDS)]),
        ]);
        if (signature === lastSignature && now.meetingElapsedSeconds - lastPublishedAt < HEARTBEAT_MEETING_SECONDS) {
          return;
        }
        lastSignature = signature;
        lastPublishedAt = now.meetingElapsedSeconds;

        const event: KakiEvent = {
          type: 'MEETING_RECORD_UPDATED',
          audience: { kind: 'all' },
          // elapsedSeconds and speakerTalkSeconds are for the current agenda item.
          payload: {
            agendaIndex: now.agendaIndex,
            openQuestions,
            elapsedSeconds: Math.floor(now.itemElapsedSeconds),
            speakerTalkSeconds: Object.fromEntries(
              Object.entries(talk).map(([role, seconds]) => [role, Math.round(seconds ?? 0)]),
            ),
            notetakerStatus: status,
            quietRoles,
          },
        };
        hub.publish(event, { retainKey: 'record' });
      }

      clock.onOverrun((index, item) => {
        console.log(`kaki host: agenda item ${index} "${item.title}" is over its ${item.minutes} minutes`);
      });

      const unsubscribe = hub.subscribe((event) => {
        if (event.type !== 'TRANSCRIPT_CHUNK') return;
        clock.start();
        notetaker.addChunk(event.payload);
      });

      const ticker = setInterval(() => {
        clock.tick();
        publishRecord();
      }, TICK_MS);
      const notetakerTimer = setInterval(() => {
        void notetaker.run().then(publishRecord);
      }, notetakerIntervalMs);

      let stopReplay: (() => void) | undefined;
      let stopped = false;
      if (replay !== false) {
        const lines = replay === true ? loadReplay(scenario) : Promise.resolve(replay);
        lines.then(
          (loaded) => {
            if (stopped) return;
            console.log(`kaki host: replaying ${loaded.length} transcript lines at ${speed}x`);
            stopReplay = startReplay({ lines: loaded, hub, speed });
          },
          (error: unknown) => console.error('kaki host: could not start the replay', error),
        );
      }

      return () => {
        stopped = true;
        stopReplay?.();
        unsubscribe();
        clearInterval(ticker);
        clearInterval(notetakerTimer);
      };
    },
  };
}
