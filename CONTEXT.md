# Domain Context: Kaki Meeting Assistant

## Glossary & Core Concepts

- **`kaki.host`**: The single, neutral, meeting-level AI facilitator. It does NOT speak continuously; it only produces speech at three deterministic points: Meeting Opening, Meeting Closing, and Agenda Timeout transitions. It also manages the public Shared Action Panel.
- **`kaki.wingman`**: The private, role-tailored copilot running on each individual participant's screen (mobile/web). Delivers silent nudges, private fact retrieval, and receives tasks dispatched by `kaki.host`.
- **`kaki.action`**: The background execution agent spawned by a participant from their `kaki.wingman`. Has tool-calling write permissions to external systems (e.g. Gitea Issue creation, Mattermost channel messages).
- **`Shared Action Panel`**: The visual board visible to the entire meeting (like a shared chat or meeting board) where candidate tasks are posted and synced upon completion. Zero audio interruption.
- **`Meeting Record`**: The unified structured JSON state stream maintained by the Notetaker LLM (agenda items, speaker times, transcript slices, open questions, detected action items).
- **`Human-in-the-Loop Dispatch`**: The workflow where tasks are detected -> presented visually on the Shared Action Panel -> dispatched to a specific attendee -> confirmed by attendee to run via `kaki.action` -> executed -> synced back visually to the meeting.
