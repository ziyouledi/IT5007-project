# Kaki Meeting demo video: script draft v1

Target length: about 2:45 (the Kaki promo is 2:46). 1920×1080, 30 fps.

## Style taken from the Kaki promo (kakiai.me/video)

- **Voice:** Kaki speaks in the first person ("Hi. I'm Kaki. I read your company's records…"). Short, plain sentences, often two or three per caption. One story follows one person through one day.
- **Captions:** every narration line appears as a white rounded pill with a soft shadow, centred near the bottom.
- **Background:** warm off-white. UI shots float as white cards with a soft lavender shadow. The camera zooms and pans into the part of the UI being narrated, never the full screen for long.
- **Title cards:** large bold black text, with the key phrase highlighted (yellow underlay or purple text), e.g. "Nothing promised is lost. Nothing secret gets out."
- **Close:** "Record anywhere. I'll do the follow-up. And nothing goes out without you." Then the logo and URL on a plain card.

## Part 1: Narration (Azure TTS, English)

About 370 words, roughly 2:40 at 140 wpm. "Visual" is what the cut shows under the line.

| # | Narration (caption text) | Visual |
|---|---|---|
| 1 | Hi. I'm Kaki. I sit in on your meetings, and I make sure what's decided actually gets done. | Title card: **"Decide in the room. Kaki does the rest."** → Kaki Meeting logo |
| 2 | Seven a.m. at Nanyang Kopi & Toast. The Raffles Place flagship reopens at eight. | Practice landing page: hero art and the "Opening day" badge |
| 3 | Five problems. One hour. | Agenda list, zoomed in, five items |
| 4 | Wei Ling runs operations. This morning she's practising with AI colleagues: Arjun, Mei and Daniel. Sam keeps the room moving. | Join form → seat pick (Operations Director) → room with the four AI tiles |
| 5 | Sam runs the agenda and the clock. Five minutes a topic. | Agenda clock counting down; Sam's caption on stage |
| 6 | And I sit beside Wei Ling. Only she sees my cards. | Wingman dock slides in |
| 7 | Every fact comes from the company's own records, with its source and date. | Zoom on a fact card's source and date line |
| 8 | First: Siti's kid is in hospital. We're one short at the counter. | Topic A title on stage |
| 9 | Wei Ling calls in Auntie Mary, and asks for the roster to go out. | Her typed line in the transcript |
| 10 | I draft the post. She reads it, and approves. | Task card: Draft ready → **Approve** click |
| 11 | It's on Mattermost, from her own account. | Cut to the Mattermost post in #kopitiam-launch |
| 12 | Next, the regulars. Kopi went from a dollar thirty to two forty, and the old uncles walked out. | Topic B; Mei and Arjun arguing in captions |
| 13 | Mei and Arjun disagree. Wei Ling makes the call: a regulars' price on the till. | Her decision line highlighted |
| 14 | Arjun takes the ticket. Mei takes the note for the counter. | Two task cards: "Accepted by Arjun", "Accepted by Mei" |
| 15 | Each one shows exactly whose words it came from. | Zoom on the card's quote/source |
| 16 | A Gitea issue, filed by Arjun. A Mattermost post, from Mei. | Split: Gitea issue page / Mattermost post |
| 17 | Laptops took half the seats yesterday. Booth power goes off from eight to ten, and the Wi-Fi code lasts forty-five minutes. | Topic C; time lapse of the discussion |
| 18 | Another ticket for Arjun. | Gitea issue list, new issue at the top |
| 19 | Then the hard one. A customer says she got sick here. | Topic D; the meeting's tone shifts (slower cut) |
| 20 | That's sensitive. So I draft carefully: an apology, a refund, her clinic bill, and the fridge log. | Email draft card, zoom on the body |
| 21 | Wei Ling changes one line. Then she approves. | Edit in the draft → Approve |
| 22 | Sent. | Mailpit inbox, the reply open |
| 23 | The delivery app fees? That can wait till after lunch. | Topic E; "park it" line |
| 24 | Parked doesn't mean lost. I book a follow-up, and it's on everyone's calendar. | Calendar event card → Radicale event |
| 25 | Nothing promised is lost. Nothing is written until its owner says yes. | Title card, "owner says yes" highlighted |
| 26 | Meeting over. The minutes are drafted, but they wait for Wei Ling. | Minutes card: full Markdown draft |
| 27 | One tap, and they're on the team wiki. | Approve & publish → Wiki.js page |
| 28 | Mattermost. Gitea. Email. Calendar. Wiki. Your own tools, written for you, the moment the meeting decides. | Quick montage of all five, one beat each |
| 29 | Talk it through. I'll do the follow-up. And nothing goes out without you. | Title card |
| 30 | Kaki Meeting. | End card: logo + URL |

### TTS settings (proposal)

- Voice: `en-US-Ava:DragonHDLatestNeural`, warm and conversational like the promo. Alternates to try: `en-US-Andrew:DragonHDLatestNeural`, `en-GB-Ada:DragonHDLatestNeural`.
- One TTS call per row, so each row is its own clip with an exact duration. The edit then times the video to the voice, not the other way round.
- Rate default; 400 ms of silence between rows, 700 ms before and after title cards.

## Part 2: The practice meeting run (what the visitor types)

### Setup

- Local stack, **`KAKI_DRAFT_ONLY` off** (actions really write to the local Gitea, Mattermost, Mailpit, Radicale and Wiki.js).
- **`KAKI_AGENDA_ITEMS=5`**, so all five topics are on the agenda. The order is shuffled, so the driver picks its lines by the **current topic title**, not by position.
- Visitor seat: **Operations Director (Wei Ling)**. Why this seat:
  - She owns A and D, so two of her own drafts (Mattermost and email) are approved on camera.
  - Arjun (Gitea), Mei (Mattermost) and Daniel (calendar) show AI colleagues accepting and completing their tasks.
  - Every connector appears once, with both "I approve" and "a colleague does it".
- Lines are **typed**, not spoken, so every take is the same. The NPCs still speak with their Azure voices.
- Before each take: `npm run meeting:reset`, then reseed so the tools start clean and the new records are easy to spot.

### Lines by topic

Each topic follows the same pattern: let Sam open it and the colleagues talk for about 20 s, then (1) state the decision, (2) assign the follow-up by name and by tool, (3) close the topic.

**A. One counter staff short for the opening rush** (owner: visitor) → **Mattermost**
1. "Let's call Auntie Mary in from nine on double pay, and Mei covers the counter until then. Drinks and toast only at the counter before nine."
2. "I'll post today's shift plan to the team channel on Mattermost so everyone knows who's where."
3. "Okay, that's settled. Let's move on."
- Expect: a task card assigned to the visitor → claim → draft → **approve on camera**.

**B. Old regulars and the new kopi prices** (owner: Mei) → **Gitea + Mattermost**
1. "We keep the new price, but add a regulars' price of a dollar eighty on the till, for regulars Uncle Lim vouches for."
2. "Arjun, please open a Gitea ticket to add the regulars' price button on the till."
3. "Mei, can you post a note to the counter team on Mattermost explaining who gets the regulars' price and why?"
4. "Great, let's move on."
- If a colleague offers to ask Uncle Lim, let that play out once. It's a good on-camera moment.

**C. Laptop campers and the breakfast seat crunch** (owner: Arjun) → **Gitea**
1. "Booth power off from eight to ten, and a 45-minute Wi-Fi code printed on each receipt. Laptop folks get the window bar."
2. "Arjun, open a ticket for the socket timer and the 45-minute Wi-Fi code."
3. "Done. Next topic."

**D. Food safety complaint before the 9 AM inspection** (owner: visitor) → **Email (Mailpit)**
1. "We open at eight without Set A until the ten o'clock delivery, and we show the inspector both the fridge log and the disposal log."
2. "I'll email the customer back today: an apology, a full refund, we cover her eighty-five dollar clinic bill, and the fridge log attached."
3. "Okay, moving on."
- Expect: an email draft for the visitor. On camera, **edit one line** (e.g. add "Please reply with the clinic receipt"), then approve.

**E. Delivery app commission squeeze** (owner: Daniel, can wait) → **Calendar (Radicale)**, optional extra email
1. "This one can wait till after the lunch rush. Let's park it."
2. "Daniel, book a short follow-up for two thirty today with the four of us to settle the GrabFood pricing."
3. *(optional, only if a second email is wanted)* "And Daniel, email our GrabFood account manager to ask whether the promo rate can be extended."

**Wrap-up** → **Wiki.js**
- After the last topic, Sam closes the meeting. The visitor opens the minutes card, scrolls the draft, and taps **Approve & publish**, then opens "Open meeting minutes in Wiki ↗".

### Coverage check after each take

| Tool | Expected record | Pass if |
|---|---|---|
| Mattermost | Wei Ling's shift plan; Mei's regulars' note | 2 new posts in `kopitiam-launch` |
| Gitea | Regulars' price button; socket timer + Wi-Fi code | 2 new issues in `kopitiam/kopitiam-pos` |
| Mailpit | Reply to the customer (+ optional GrabFood email) | 1–2 new messages |
| Radicale | Follow-up on delivery pricing | 1 new event today |
| Wiki.js | Meeting minutes | 1 new page |

If a tool is missing, retake only that topic. Because the topics are shuffled, the edit can cut topics from different takes as long as the tile layout matches.

### Footage to capture

1. Main take: the full browser window, meeting page, 1920×1080, with the NPC audio.
2. B-roll, captured automatically after each success: the new Gitea issue, the Mattermost post, the Mailpit message, the Radicale event, and the wiki page, each as a short clip with a slow scroll.
3. Close-ups: re-shoot the wingman dock and the task cards at 2× device scale so the zoom-ins stay sharp.

## Open questions

1. **Meeting audio:** the reference video is narration only. Should the meeting audio be muted under the narration, with two or three short clips where the AI colleagues are heard (e.g. Mei and Arjun arguing in B)? My recommendation is yes.
2. **Seat:** Operations Director (Wei Ling), as above, or another seat?
3. **End card URL:** which link (the Azure demo URL or something else)?
4. **Logo:** is there a Kaki Meeting logo, or should it reuse the Kaki hand logo?
