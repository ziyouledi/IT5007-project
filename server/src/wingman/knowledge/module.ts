import type { KakiEvent, SearchCompanyData } from '@kaki/shared';
import { Pool } from 'pg';
import type { KakiContext, KakiModule } from '../../modules';
import { gatewayConfigFromEnv, missingGatewayEnv } from './gateway';
import { createCompanySearchFromEnv } from './search';

export interface KnowledgeModuleOptions {
  /** A prepared search, used by tests and the check script. */
  search?: SearchCompanyData;
  env?: NodeJS.ProcessEnv;
}

function missingSearchEnv(env: NodeJS.ProcessEnv): string[] {
  return [...missingGatewayEnv(env), ...(env.POSTGRES_URL ? [] : ['POSTGRES_URL'])];
}

/** How many times a question is searched before Kaki gives up; a failed search retries on the next record. */
const MAX_SEARCH_ATTEMPTS = 3;

interface QuestionLog {
  /** Questions already answered, skipped, or out of attempts. */
  settled: Set<string>;
  running: Set<string>;
  attempts: Map<string, number>;
  stopped?: boolean;
}

function handleEvent(
  ctx: KakiContext,
  search: SearchCompanyData,
  log: QuestionLog,
  event: KakiEvent,
): void {
  if (log.stopped) return;
  if (event.type === 'MEETING_RESET') {
    log.settled.clear();
    log.running.clear();
    log.attempts.clear();
    return;
  }
  if (event.type !== 'MEETING_RECORD_UPDATED') return;

  const { agendaIndex } = event.payload;
  for (const question of event.payload.openQuestions) {
    if (log.settled.has(question.id) || log.running.has(question.id)) continue;
    if (question.agendaIndex !== undefined && question.agendaIndex < event.payload.agendaIndex) {
      // Raised on an earlier agenda item: the meeting has moved on, so facts for it would only distract.
      log.settled.add(question.id);
      continue;
    }
    if (question.forRole === undefined) {
      log.settled.add(question.id);
      console.warn(`kaki wingman: open question ${question.id} has no role, skipping company search`);
      continue;
    }

    const role = question.forRole;
    const attempt = (log.attempts.get(question.id) ?? 0) + 1;
    log.attempts.set(question.id, attempt);
    if (attempt >= MAX_SEARCH_ATTEMPTS) log.settled.add(question.id);
    log.running.add(question.id);

    void (async () => {
      try {
        const facts = await search(question.text, role);
        if (log.stopped) return;
        if (facts.length === 0) {
          console.error(
            `kaki wingman: no company facts found for question ${question.id} (${role}), attempt ${attempt}`,
          );
          return;
        }
        ctx.hub.publish(
          {
            type: 'FACT_FOUND',
            audience: { kind: 'role', role },
            payload: { questionId: question.id, question: question.text, facts, agendaIndex },
          },
          { retainKey: `fact:${question.id}` },
        );
        log.settled.add(question.id);
      } catch (error) {
        if (log.stopped) return;
        console.error(
          `kaki wingman: company search failed for question ${question.id} (${role}), attempt ${attempt}:`,
          error,
        );
      } finally {
        log.running.delete(question.id);
      }
    })();
  }
}

/** The module that answers open meeting questions from the fake company's records. */
export function createKnowledgeModule(options: KnowledgeModuleOptions = {}): KakiModule {
  return {
    name: 'wingman-knowledge',
    start(ctx) {
      const env = options.env ?? process.env;
      let search = options.search;
      let pool: Pool | undefined;

      if (search === undefined) {
        const missing = missingSearchEnv(env);
        if (gatewayConfigFromEnv(env) === undefined || missing.length > 0) {
          console.log(
            `kaki wingman: company search disabled (missing ${[...new Set(missing)].join(', ')})`,
          );
          return;
        }
        pool = new Pool({ connectionString: env.POSTGRES_URL });
        // An idle connection dying (database restart) must not crash the server.
        pool.on('error', (error) => console.error('kaki wingman: company search database error', error));
        search = createCompanySearchFromEnv(env, pool);
      }

      const log: QuestionLog = { settled: new Set(), running: new Set(), attempts: new Map() };
      const unsubscribe = ctx.hub.subscribe((event) => handleEvent(ctx, search, log, event));
      return () => {
        log.stopped = true;
        unsubscribe();
        if (pool) void pool.end();
      };
    },
  };
}

export const knowledgeModule = createKnowledgeModule();
