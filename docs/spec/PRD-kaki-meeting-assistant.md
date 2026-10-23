# PRD: Kaki — Multi-Agent Meeting Facilitation & Action Delegation Ecosystem

## Problem Statement

During hybrid and virtual meetings, human meeting hosts face extreme cognitive overload. The host must present content, track time, manage agendas, ensure equitable participation, answer technical/factual questions, and accurately log action items with owners. Inevitably, meetings overrun, critical questions are left unanswered, quiet domain experts are overlooked, and action items discussed orally evaporate without accountability.

Existing meeting assistants (Zoom AI Companion, Otter.ai, Fireflies, Read.ai, Copilot) are fundamentally passive, post-meeting, or single-perspective summaries. They either act only after the call ends, or offer a single assistant panel to one user. Furthermore, academic research into proactive "overhearing" conversational agents faces severe technical and social bottlenecks: real-time speech turn-taking and conversational interruptions (knowing *when* to speak without being rude or lagging) remain fragile and disruptive.

Meeting participants and hosts need a proactive system that:
1. Maintains strict meeting tempo without awkward verbal interruptions;
2. Provides personalized, silent assistance to individual attendees based on their specific roles;
3. Bridges the gap between verbal meeting decisions and real external systems (e.g. ticketing, team chat) through background execution agents without causing race conditions or unwanted side effects.

---

## Solution

**Kaki** is a multi-agent meeting ecosystem that divides responsibilities cleanly across three distinct agent roles and two operational planes (public meeting vs. private attendee):

1. **`kaki.host` (Public Meeting Facilitator)**:
   - The single, neutral chair of the meeting.
   - **Deterministic Speech Only**: To eliminate the conversational turn-taking interruption problem, `kaki.host` ONLY speaks audibly at three deterministic, socially expected moments:
     1. Meeting Opening (greetings and agenda walkthrough);
     2. Agenda Timeout / Segment Transition (e.g., *"Topic 1 has reached 15 minutes, please summarize so we can move to Topic 2"*);
     3. Meeting Closing (recap of achievements and farewell).
   - **Visual Task Dispatch**: Hosts a meeting-wide **Shared Action Panel** (purely visual, zero voice interruption) that automatically detects candidate tasks from the live discussion and proposes an assignee.

2. **`kaki.wingman` (Private Participant Copilot)**:
   - Runs privately on each attendee's screen (mobile or web app, joined via QR code).
   - Provides role-tailored silent nudges (e.g., reminding the Tech Lead about upcoming topics, feeding private knowledge base facts when questions arise).
   - Receives tasks dispatched by `kaki.host` and asks the user whether to spawn a background `kaki.action` agent or handle it manually later.

3. **`kaki.action` (Personal Background Execution Worker)**:
   - Spawned only with explicit human consent from a participant's `kaki.wingman`.
   - Executes real write actions via external APIs (Tool Calling): creating Gitea bug/task issues, posting Mattermost follow-ups, and updating databases.
   - Reports execution results back to the user's `kaki.wingman`. Upon user confirmation, updates the meeting's public Shared Action Panel visually.

---

## User Stories

### kaki.host (Public Facilitation)
1. As a meeting organizer, I want `kaki.host` to deliver a clear verbal opening statement in Zoom at the start of the call, so that all attendees understand the scheduled agenda and time limits.
2. As a meeting participant, I want `kaki.host` to announce when an agenda item's allocated time has expired, so that the meeting stays strictly on schedule without any single person having to be the "bad guy".
3. As a meeting participant, I want `kaki.host` to refrain from speaking aloud during active brainstorming and debates, so that organic conversation is never interrupted by AI latency or awkward turn-taking.
4. As a meeting host, I want `kaki.host` to deliver a concise closing recap at the end of the meeting, so that all attendees leave aligned on what was discussed.
5. As a meeting participant, I want `kaki.host` to continuously scan the transcript and visually highlight candidate action items on the Shared Action Panel, so that oral commitments are not forgotten.
6. As a meeting host, I want `kaki.host` to recommend an appropriate assignee for each detected task based on attendee roles, so that tasks can be dispatched with a single click.

### kaki.wingman (Personal Copilot)
7. As an attendee joining from my phone, I want to scan a QR code and select my role (e.g. Tech Lead, Finance Lead), so that my `kaki.wingman` loads context relevant only to me.
8. As a quiet or introverted attendee, I want my `kaki.wingman` to notify me on my screen 1 minute before my topic begins, so that I can prepare my notes and speak up with confidence.
9. As an attendee who has been asked a factual question, I want my `kaki.wingman` to instantly search our company knowledge base (Wiki.js, Gitea, Mattermost, Postgres) and display the verified fact privately on my screen, so that I can cite it accurately during the meeting.
10. As an attendee assigned a task by the meeting host, I want a notification card in my `kaki.wingman` asking whether I want to spawn `kaki.action` or do it myself later, so that I maintain complete control over my work.
11. As an attendee whose `kaki.action` just completed a background task, I want to review the generated artifact (e.g. Gitea Issue link) privately in my Wingman, so that I can verify its correctness before sharing.
12. As an attendee, I want a 1-click button to sync my completed task status to the meeting's Shared Action Panel, so that the entire room sees it marked as done in real time.

### kaki.action (Background Tool Execution)
13. As an attendee delegating a task, I want `kaki.action` to parse the discussion context and automatically formulate a well-structured Gitea Issue (title, description, reproduction steps, labels), so that I don't have to write tickets manually during the meeting.
14. As an attendee delegating a communication task, I want `kaki.action` to format and publish a summary post to the designated Mattermost channel, so that absent team members receive immediate updates.
15. As a developer running `kaki.action`, I want task executions to run asynchronously in an isolated background worker, so that long-running API calls never block live meeting transcription or UI responsiveness.
16. As a system administrator, I want `kaki.action` tool calls to be authenticated against self-hosted Docker services (Gitea, Mattermost, Postgres), so that sensitive meeting data never leaves the self-contained environment.

---

## Implementation Decisions

### 1. Architectural Roles and Subsystems
- **Audio & Ears Pipeline**: Deepgram STT connected via Attendee bot running on an x86 cloud VM (or local replay audio file for deterministic testing/demo). Emits timestamped, speaker-attributed transcript chunks over WebSockets.
- **Notetaker & Meeting Record**: A background LLM worker (OpenAI-compatible DeepSeek instance) that ingests transcript batches every 5–10 seconds and produces a structured, append-only `Meeting Record` JSON state containing:
  - `agenda_progress`: current item index, elapsed seconds, status;
  - `speaker_stats`: talk time per speaker per agenda item;
  - `open_questions`: list of unanswered questions;
  - `detected_action_items`: candidate tasks with inferred owner, title, and context.
- **`kaki.host` Service**:
  - TTS: Web Speech API / Edge-TTS triggered deterministically. Audio routed to Zoom via virtual audio / host mic.
  - State Engine: Triggers speech events only on `MEETING_START`, `AGENDA_TIMEOUT`, and `MEETING_END`.
  - Public UI: Displays the **Shared Action Panel** showing active agenda status and the live task dispatch board.
- **`kaki.wingman` Client**:
  - Responsive web/mobile client built in React / Vite.
  - Subscribes to the central WebSocket server using a `participant_id` and `role` query param.
  - Receives filtered, role-relevant nudges and task assignment prompts.
- **`kaki.action` Runtime**:
  - Node.js / TypeScript worker engine.
  - Tool execution modules:
    - `giteaTool`: `POST /api/v1/repos/{owner}/{repo}/issues`
    - `mattermostTool`: `POST /api/v4/posts`
  - Dispatches WebSocket event `ACTION_COMPLETED` containing external URLs and payload upon completion.

### 2. State & Event Protocol
WebSocket event types:
- `TRANSCRIPT_CHUNK`: `{ speaker, text, timestamp }`
- `MEETING_RECORD_UPDATED`: `{ agendaIndex, openQuestions, candidateTasks }`
- `HOST_SPEECH_TRIGGERED`: `{ type: 'OPENING'|'TIMEOUT'|'CLOSING', text }`
- `TASK_DISPATCHED`: `{ taskId, title, suggestedAssignee, context }`
- `TASK_CLAIMED`: `{ taskId, assignee, mode: 'ACTION_AGENT'|'MANUAL' }`
- `ACTION_STATUS_CHANGED`: `{ taskId, status: 'RUNNING'|'COMPLETED'|'FAILED', artifactUrl }`
- `TASK_SYNCED_TO_MEETING`: `{ taskId, status: 'COMPLETED', artifactUrl }`

### 3. Data & Infrastructure
- Self-hosted Docker Compose stack:
  - `postgres` with `pgvector` for meeting state storage and vector knowledge search.
  - `gitea` for code and issue tracker mock.
  - `mattermost` for team chat mock.
  - `wiki.js` for company documentation mock.
- Single `.env` file containing API keys and base URLs.

---

## Testing Decisions

### Seam 1: Meeting Record State Engine (Backend Core)
- Feed canned transcript JSON chunks through the Notetaker service and verify that `Meeting Record` correctly increments agenda timing, detects overrun conditions, and extracts candidate action items with >90% precision.

### Seam 2: Host Speech Trigger Seam (Deterministic TTS)
- Test clock ticks against agenda boundaries. Verify that audio trigger events fire strictly at t=0, t=agenda_limit, and t=meeting_end, and NEVER fire in the presence of conversational dialogue mid-agenda.

### Seam 3: Task Dispatch & Action Execution Seam (End-to-End Worker)
- Trigger a synthetic `TASK_DISPATCHED` event for a Gitea issue creation task.
- Assert that `kaki.action` executes `giteaTool`, verifies HTTP 201 response, emits `ACTION_COMPLETED` with the valid issue URL, and updates the task status in the Shared Action Panel.

### Seam 4: Multi-Client UI Isolation Seam
- Connect two distinct WebSocket clients (Client A with role `tech_lead`, Client B with role `finance_lead`).
- Emit a tech-specific task. Assert Client A receives the prompt card while Client B receives zero extraneous notifications.

---

## Out of Scope

- Real-time conversational mid-sentence voice interruptions by `kaki.host`.
- Full-duplex voice interaction between `kaki.wingman` and participants (interactions on Wingman are purely silent touch/text).
- Automatic autonomous execution of write tools without human confirmation (zero unchecked side effects).
- Native Zoom In-Client App SDK packaging (runs beside Zoom as a responsive web client).

---

## Further Notes

- Demonstration Scenario: 29th NUS SoC Term Project Showcase (STePS) preparation meeting (https://uvents.nus.edu.sg/event/29th-steps at COM3 MPH). Agenda includes booth logistics, demo hardware verification, live Attendee bot checks, and emergency bug triage.
- Course Presentation Plan: 1 laptop (Zoom + `kaki.host` audio and Shared Action Panel) + 2 mobile phones (`kaki.wingman` for Tech Lead and Finance Lead).
