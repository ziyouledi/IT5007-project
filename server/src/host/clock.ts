import type { AgendaItem } from '@kaki/shared';

/** Where the meeting is on its agenda right now. */
export interface ClockSnapshot {
  started: boolean;
  /** True once the meeting is over; time stands still from then on. */
  ended: boolean;
  agendaIndex: number;
  /** Seconds spent on the current agenda item. */
  itemElapsedSeconds: number;
  /** Seconds since the meeting started. */
  meetingElapsedSeconds: number;
  /** True once the current item has used up its minutes. */
  overrun: boolean;
}

/** The agenda clock: knows the current item and its elapsed time, and signals overrun once per item. */
export interface AgendaClock {
  start(): void;
  /** Stop the meeting: time freezes and no more overruns fire. */
  end(): void;
  snapshot(): ClockSnapshot;
  /** Move forward to a later agenda item; earlier or out-of-range indexes are ignored. */
  advanceTo(index: number): void;
  /** Check for overrun now; call this on every tick. */
  tick(): void;
  onOverrun(handler: (agendaIndex: number, item: AgendaItem) => void): () => void;
}

/** Options for the agenda clock; `speed` runs meeting time faster than real time for replays. */
export interface AgendaClockOptions {
  agenda: AgendaItem[];
  speed?: number;
  now?: () => number;
}

/** Create an agenda clock that has not started yet. */
export function createAgendaClock({ agenda, speed = 1, now = Date.now }: AgendaClockOptions): AgendaClock {
  if (!(speed > 0)) throw new Error(`Clock speed must be positive, got ${speed}`);

  let startedAt: number | undefined;
  let endedAtSeconds: number | undefined;
  let agendaIndex = 0;
  let itemStartSeconds = 0;
  const overrunFired = new Set<number>();
  const overrunHandlers = new Set<(agendaIndex: number, item: AgendaItem) => void>();

  function meetingSeconds(): number {
    if (endedAtSeconds !== undefined) return endedAtSeconds;
    return startedAt === undefined ? 0 : ((now() - startedAt) / 1000) * speed;
  }

  function snapshot(): ClockSnapshot {
    const meetingElapsedSeconds = meetingSeconds();
    const itemElapsedSeconds = Math.max(0, meetingElapsedSeconds - itemStartSeconds);
    const item = agenda[agendaIndex];
    return {
      started: startedAt !== undefined,
      ended: endedAtSeconds !== undefined,
      agendaIndex,
      itemElapsedSeconds,
      meetingElapsedSeconds,
      overrun: item !== undefined && startedAt !== undefined && itemElapsedSeconds >= item.minutes * 60,
    };
  }

  return {
    start() {
      startedAt ??= now();
    },
    end() {
      if (startedAt !== undefined) endedAtSeconds ??= meetingSeconds();
    },
    snapshot,
    advanceTo(index) {
      if (endedAtSeconds !== undefined || !Number.isInteger(index) || index <= agendaIndex || index >= agenda.length) {
        return;
      }
      agendaIndex = index;
      itemStartSeconds = meetingSeconds();
    },
    tick() {
      const current = snapshot();
      const item = agenda[current.agendaIndex];
      if (current.ended || !current.overrun || item === undefined || overrunFired.has(current.agendaIndex)) return;
      overrunFired.add(current.agendaIndex);
      for (const handler of overrunHandlers) {
        try {
          handler(current.agendaIndex, item);
        } catch (error) {
          console.error('kaki host: an overrun handler failed', error);
        }
      }
    },
    onOverrun(handler) {
      overrunHandlers.add(handler);
      return () => {
        overrunHandlers.delete(handler);
      };
    },
  };
}
