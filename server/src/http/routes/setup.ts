import type { ServerResponse } from 'node:http';
import {
  blankMeetingSetup,
  defaultMeetingSetup,
  demoPackNpcProfileIds,
  deriveMeetingScenario,
  KOPITIAM_INVITE_UID,
  parseMeetingInvite,
  parseMeetingSetup,
  type MeetingSetup,
} from '@kaki/shared';
import { CALENDAR_CONFIG_MESSAGE, CalendarFetchError, fetchCalendarIcs } from '../../action/calendar';
import { actionToolStatus, isActionToolKind, probeActionTool } from '../../action/tools';
import { MAX_BODY_BYTES, type RouteCall } from '../routeCall';
import { readJsonBody, sendJson } from '../http';

/** Refuse a setup write while the meeting is starting or already started. */
function sendSetupLocked(response: ServerResponse, lock: 'starting' | 'started'): void {
  sendJson(response, 409, {
    error:
      lock === 'starting'
        ? "The meeting is starting; setup can't change now."
        : "The meeting has started; setup can't change now.",
  });
}

/** Returns the current meeting setup: the sealed plan while running, else the draft. */
export async function handleGetSetup(call: RouteCall): Promise<void> {
  const { response, context } = call;
  const phase = context.session.phase();
  // Locked exactly when setup writes are refused, so an abandoned, released meeting reads as over.
  const live = phase === 'running' && context.setupLocked() === 'started';
  sendJson(response, 200, {
    // Only a live running meeting shows its seal; every other phase edits the next meeting's draft.
    setup: live ? (context.session.sealed() ?? context.session.draft()) : context.session.draft(),
    started: live,
    phase,
    ...(context.session.kind() === undefined ? {} : { kind: context.session.kind() }),
  });
  return;
}

/** Lists every action tool and whether its settings are complete. */
export async function handleGetSetupTools(call: RouteCall): Promise<void> {
  const { response, context } = call;
  sendJson(response, 200, { tools: actionToolStatus(context.actionTools.env) });
  return;
}

/** Tests one action tool's connection by kind and returns the probe result. */
export async function handleSetupToolTest(call: RouteCall): Promise<void> {
  const { response, context, path } = call;
  const toolTestMatch = /^\/api\/setup\/tools\/([^/]+)\/test$/.exec(path);
  if (toolTestMatch === null) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }
  const kind = decodeURIComponent(toolTestMatch[1] ?? '');
  if (!isActionToolKind(kind)) {
    sendJson(response, 404, { error: 'Unknown tool kind.' });
    return;
  }
  const result = await probeActionTool(kind, context.actionTools);
  sendJson(response, 200, { kind, ...result });
  return;
}

/** Replaces the draft with an empty setup for a blank meeting. */
export async function handleSetupBlank(call: RouteCall): Promise<void> {
  const { response, context } = call;
  // Only the meeting owner edits setup; everyone else gets the read-only join view.
  const lock = context.setupLocked();
  if (lock !== undefined) {
    sendSetupLocked(response, lock);
    return;
  }
  const setup = blankMeetingSetup();
  // An ended meeting keeps its seal for saving; this blank plan is the next meeting's draft.
  context.session.setDraft(setup);
  context.runnerStateChanged();
  context.scheduleSave();
  sendJson(response, 200, {
    setup,
    started: false,
    ...(context.session.kind() === undefined ? {} : { kind: context.session.kind() }),
  });
  return;
}

/** Validates and saves an edited setup as the next meeting's draft. */
export async function handlePutSetup(call: RouteCall): Promise<void> {
  const { request, response, context } = call;
  // Only the meeting owner edits setup; everyone else gets the read-only join view.
  const lock = context.setupLocked();
  if (lock !== undefined) {
    sendSetupLocked(response, lock);
    return;
  }
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    sendJson(response, body.status, { error: body.error });
    return;
  }
  const lateLock = context.setupLocked();
  if (lateLock !== undefined) {
    sendSetupLocked(response, lateLock);
    return;
  }
  const parsed = parseMeetingSetup(body.value, {
    npcProfileIds: demoPackNpcProfileIds(context.fullScenario),
  });
  if (!parsed.ok) {
    sendJson(response, 400, { errors: parsed.errors });
    return;
  }
  const derived = deriveMeetingScenario(context.fullScenario, parsed.value);
  if (!derived.ok) {
    sendJson(response, 422, {
      error: 'This setup describes a meeting that cannot run. Fix the highlighted setup and try again.',
      errors: derived.errors,
    });
    return;
  }
  // An ended meeting keeps its seal for saving; this edit is the next meeting's draft.
  context.session.setDraft(parsed.value);
  context.runnerStateChanged();
  context.scheduleSave();
  sendJson(response, 200, {
    setup: parsed.value,
    started: false,
    ...(context.session.kind() === undefined ? {} : { kind: context.session.kind() }),
  });
  return;
}

/** Reads the demo calendar invite and drafts a setup from its agenda. */
export async function handleImportCalendar(call: RouteCall): Promise<void> {
  const { response, context } = call;
  // Only the meeting owner edits setup; everyone else gets the read-only join view.
  const lock = context.setupLocked();
  if (lock !== undefined) {
    sendSetupLocked(response, lock);
    return;
  }
  if (context.calendar === undefined) {
    sendJson(response, 503, { error: CALENDAR_CONFIG_MESSAGE });
    return;
  }

  let ics: string;
  try {
    ics = await fetchCalendarIcs(context.calendar, context.calendarFetch);
  } catch (error) {
    if (error instanceof CalendarFetchError) {
      sendJson(response, error.status, { error: error.message });
    } else {
      console.error('kaki setup: calendar import failed', error);
      sendJson(response, 502, { error: 'The calendar could not be read.' });
    }
    return;
  }
  const lateLock = context.setupLocked();
  if (lateLock !== undefined) {
    sendSetupLocked(response, lateLock);
    return;
  }

  const pack = defaultMeetingSetup(context.fullScenario);
  const knownOwners = [
    ...pack.roles.flatMap((role) => [role.id, role.label]),
    ...pack.seats.map((seat) => seat.displayName),
  ];
  const parsedInvite = parseMeetingInvite(ics, { uid: KOPITIAM_INVITE_UID, knownOwners });
  if (!parsedInvite.ok) {
    const missing = parsedInvite.errors.some((problem) => problem.field === 'invite');
    sendJson(
      response,
      missing ? 404 : 422,
      missing
        ? { error: parsedInvite.errors[0]?.message ?? 'The calendar invite was not found.' }
        : { error: 'The calendar invite agenda could not be read.', errors: parsedInvite.errors },
    );
    return;
  }

  const invite = parsedInvite.value;
  const problems: Array<{ field: string; message: string }> = [];
  const roleForOwner = (owner: string): MeetingSetup['roles'][number] | undefined => {
    const key = owner.trim().toLowerCase();
    const role = pack.roles.find(
      (candidate) => candidate.id.toLowerCase() === key || candidate.label.toLowerCase() === key,
    );
    if (role !== undefined) return role;
    const seat = pack.seats.find((candidate) => candidate.displayName.trim().toLowerCase() === key);
    return seat === undefined ? undefined : pack.roles.find((candidate) => candidate.id === seat.roleId);
  };

  const agenda: MeetingSetup['agenda'] = [];
  invite.agenda.forEach((item, index) => {
    const role = roleForOwner(item.owner);
    if (role === undefined) {
      problems.push({
        field: `agenda[${index}].owner`,
        message: `"${item.owner}" is not a seat or role in the demo pack.`,
      });
      return;
    }
    agenda.push({ id: `agenda-${index + 1}`, title: item.title, minutes: item.minutes, ownerRoleId: role.id });
  });

  // The invite's people are the meeting's people; the pack supplies each one's role and AI stand-in.
  const packSeatByName = new Map(pack.seats.map((seat) => [seat.displayName.trim().toLowerCase(), seat]));
  const seats: MeetingSetup['seats'] = [];
  invite.people.forEach((displayName, index) => {
    const seat = packSeatByName.get(displayName.trim().toLowerCase());
    if (seat === undefined) {
      problems.push({
        field: `seats[${index}].displayName`,
        message: `"${displayName}" is in the calendar invite but not in the demo pack.`,
      });
      return;
    }
    // A team meeting is chaired by its owner and Kaki stays silent, so every imported seat
    // starts as a person; the owner can still switch an individual seat to an AI stand-in.
    seats.push({ displayName, roleId: seat.roleId, kind: 'person' });
  });

  if (problems.length > 0) {
    sendJson(response, 422, { error: 'The calendar invite does not match the demo pack.', errors: problems });
    return;
  }

  const imported: MeetingSetup = {
    title: invite.title,
    agenda,
    roles: pack.roles,
    seats,
    pace: pack.pace,
    source: {
      title: 'calendar invite',
      agenda: 'calendar invite',
      roles: 'demo pack',
      seats: 'demo pack',
      pace: 'demo pack',
    },
  };
  const parsed = parseMeetingSetup(imported, {
    npcProfileIds: demoPackNpcProfileIds(context.fullScenario),
  });
  if (!parsed.ok) {
    sendJson(response, 422, { error: 'The imported setup is not valid.', errors: parsed.errors });
    return;
  }
  const derived = deriveMeetingScenario(context.fullScenario, parsed.value);
  if (!derived.ok) {
    sendJson(response, 422, {
      error: 'The imported setup describes a meeting that cannot run.',
      errors: derived.errors,
    });
    return;
  }

  // An ended meeting keeps its seal for saving; this import is the next meeting's draft.
  context.session.setDraft(parsed.value);
  context.scheduleSave();
  sendJson(response, 200, {
    setup: parsed.value,
    started: false,
    ...(context.session.kind() === undefined ? {} : { kind: context.session.kind() }),
  });
  return;
}
