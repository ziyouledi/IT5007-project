# Scenarios

Each scenario lives in its own folder.

- `scenario.json` (required) — roles, attendees and agenda. Validated at startup.
- `demo-events.json` — sample events and tasks for `npm run emit-demo`.
- `seed/` — later: fake company data for Wingman.
- `replay/transcript.json` — scripted, speaker-tagged transcript (`at` = seconds from the start, `speaker` = an attendee's Zoom name). Play it with `KAKI_REPLAY=1` (and `KAKI_REPLAY_SPEED=10` to speed it up).

Switch scenarios by setting `SCENARIO=<folder>` (default: `pixel-kampung`).
