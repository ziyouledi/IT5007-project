import type { KakiEvent } from '@kaki/shared';
import type { LlmClient } from '../llm';
import type { KakiContext, KakiModule } from '../modules';
import { createAgendaClock } from './clock';
import { createNotetaker } from './notetaker';
import { loadReplay, startReplay, type ReplayLine } from './replay';

const TICK_MS = 1_000;
const DEFAULT_NOTETAKER_INTERVAL_MS = 7_000;

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

      function publishRecord(): void {
        const now = clock.snapshot();
        if (!now.started) return;
        const { openQuestions, talkSecondsFor } = notetaker.state();
        const speakerTalkSeconds = Object.fromEntries(
          Object.entries(talkSecondsFor(now.agendaIndex)).map(([role, seconds]) => [role, Math.round(seconds ?? 0)]),
        );
        const event: KakiEvent = {
          type: 'MEETING_RECORD_UPDATED',
          audience: { kind: 'all' },
          // elapsedSeconds and speakerTalkSeconds are for the current agenda item.
          payload: {
            agendaIndex: now.agendaIndex,
            openQuestions,
            elapsedSeconds: Math.floor(now.itemElapsedSeconds),
            speakerTalkSeconds,
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
