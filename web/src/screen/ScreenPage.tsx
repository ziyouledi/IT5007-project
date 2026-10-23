import { roleLabel, type KakiCommand, type KakiEvent, type Scenario, type Task } from '@kaki/shared';
import { useKaki, useScenario } from '../kaki';
import {
  Button,
  Card,
  ConnectionBanner,
  EventList,
  RejectionBanner,
  StatusPill,
} from '../ui';

/** Shared screen shell: shows every event and task addressed to the meeting screen. */
export function ScreenPage() {
  const scenario = useScenario();
  const { events, tasks, rejection, connected, send } = useKaki('screen');
  const taskList = [...tasks.values()];
  const record = events.filter(isRecord).at(-1);
  const otherEvents = events.filter((event) => !isRecord(event));

  return (
    <main className="page">
      <header className="page-header">
        <p className="eyebrow">Kaki · Shared Action Panel</p>
        <h1>{scenario.meetingTitle}</h1>
        <p className="page-subtitle">Everything the room is meant to see lands here.</p>
      </header>
      {connected ? null : <ConnectionBanner />}
      {rejection === null ? null : (
        <RejectionBanner message={`${rejection.commandType}: ${rejection.reason}`} />
      )}
      {record?.payload.notetakerStatus === 'stale' ? (
        <p className="connection-banner" role="status">
          Kaki's notes are paused — questions and tasks may be out of date. The agenda clock is still running.
        </p>
      ) : null}
      {record === undefined ? null : <MeetingRecordCard record={record} scenario={scenario} />}
      <Card title="Tasks">
        {taskList.length === 0 ? (
          <p className="empty-state">No tasks yet.</p>
        ) : (
          <ul className="event-list">
            {taskList.map((task) => (
              <li key={task.id}>
                <ScreenTask task={task} scenario={scenario} send={send} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <EventList events={otherEvents} />
    </main>
  );
}

type RecordEvent = Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }>;

function isRecord(event: KakiEvent): event is RecordEvent {
  return event.type === 'MEETING_RECORD_UPDATED';
}

function formatMinutes(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(Math.floor(totalSeconds % 60)).padStart(2, '0')}`;
}

/** The current agenda item, its time, and who has barely spoken. */
function MeetingRecordCard({ record, scenario }: { record: RecordEvent; scenario: Scenario }) {
  const { agendaIndex, elapsedSeconds, openQuestions, quietRoles = [] } = record.payload;
  const item = scenario.agenda[agendaIndex];
  const limitSeconds = (item?.minutes ?? 0) * 60;

  return (
    <Card title={item === undefined ? 'Meeting' : `Now: ${item.title}`}>
      <p className="task-meta">
        {formatMinutes(elapsedSeconds)} of {formatMinutes(limitSeconds)}
        {item !== undefined && elapsedSeconds >= limitSeconds ? ' · over time' : ''} ·{' '}
        {openQuestions.length} open question{openQuestions.length === 1 ? '' : 's'}
      </p>
      {quietRoles.length === 0 ? null : (
        <p className="task-meta">
          Hasn't spoken much yet: {quietRoles.map((role) => roleLabel(scenario, role)).join(', ')}
        </p>
      )}
    </Card>
  );
}

function ScreenTask({
  task,
  scenario,
  send,
}: {
  task: Task;
  scenario: Scenario;
  send: (command: KakiCommand) => void;
}) {
  const assignee = task.assignee ?? task.suggestedAssignee;

  return (
    <Card>
      <h2 className="card-title">{task.title}</h2>
      <p className="task-meta">
        <StatusPill status={task.status} /> · {roleLabel(scenario, assignee)}
      </p>
      {task.error === undefined ? null : <p className="task-error">{task.error}</p>}
      {task.status === 'SUGGESTED' ? (
        <div className="task-actions">
          <Button
            onClick={() =>
              send({ type: 'DISPATCH_TASK', taskId: task.id, assignee: task.suggestedAssignee })
            }
          >
            Dispatch to {roleLabel(scenario, task.suggestedAssignee)}
          </Button>
          <Button variant="ghost" onClick={() => send({ type: 'DISMISS_TASK', taskId: task.id })}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
