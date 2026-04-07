# MILA

**Functional Specification — Layer 2: How It Works**
Source of Truth · v0.2 · March 2026

*This is Layer 2 — how Mila does what she does. Layer 1 defines what Mila is and why. Layer 3 covers architecture and stack. If Layer 1 and Layer 2 disagree, Layer 1 wins.*

## 1. Pipeline

Mila runs on a polling model — no real-time streaming. Each user has a per-user cron schedule (QStash). A pipeline run can also be triggered manually via API.

Each pipeline run:

1. Polls Gmail for new inbound and outbound messages
2. Syncs Google Calendar
3. Threads new messages into deals (see §2)
4. Enriches messages: extracts key facts (who, what property, what stage, what money)
5. Updates deal summaries: current state, risks, next steps
6. Generates action proposals (see §3)
7. Ranks actions by priority (see §4)
8. Checks lead protection thresholds (see §5)
9. Assembles the brief (see §6)

## 2. Conversation Threading — The Deal Model

The fundamental unit is the deal, not the message thread. A deal is the ongoing story of a business relationship centered on a counterparty. Messages from multiple people, across multiple channels, over weeks or months, all thread into one deal.

### 2.1 Threading Logic

Messages are matched to deals using a pipeline of four mechanisms, in order:

1. **External thread ID match** — email thread IDs, In-Reply-To headers. Fast path for same-channel email chains.
2. **Contact matching** — if the counterparty has exactly one active deal, assign immediately.
3. **Density/recency heuristic** — if one candidate deal has ≥3 timeline entries in the last 15 minutes and no other deal is close, assign without AI.
4. **AI assignment** — feed recent timeline entries per candidate deal to the AI. AI responds with deal ID or "NEW."

Vector embeddings were previously used for semantic matching across channels and subject lines. They have been superseded by the timeline-based algorithm above and are preserved for potential future semantic search only.

When a message matches no existing deal, a new deal is created.

### 2.2 Deal Enrichment

Each message is processed to extract structured facts:

- Counterparty identity (who, role, relationship to deal)
- Property (address, type, details mentioned)
- Financial (price, commission, offer amounts)
- Stage signals (viewing requested, offer made, documents needed, notary scheduled)
- Time references (proposed dates, deadlines)
- Sentiment and urgency signals

These accumulate at the deal level. The deal summary is regenerated on each pipeline run, reflecting the current state of all messages.

### 2.3 Deal Context

Each deal maintains a running narrative — not a message log, but a summary: where the deal stands, how it got there, key facts, and what needs to happen next. This is what appears on action cards so the agent can step back into a deal they haven't thought about in weeks.

### 2.4 Deal States

Each deal has an internal state that controls Mila's behavior:

- **Active** — ongoing conversation. Mila monitors, proposes actions, tracks lead health.
- **Waiting** — no action needed right now. Mila keeps watching but does not generate new action proposals. Typically set when the deal is blocked on a third party (bank, land registry, lawyer).
- **Archived** — conversation is finished. No monitoring, no proposals. The deal is closed, lost, or otherwise concluded.

## 3. Action Generation

For every deal that needs attention, Mila proposes specific actions. Not "you should follow up" — specific: what she'll say, to whom, via which channel.

### 3.1 Action Types

- **REPLY:** Mila will draft and send a message (email or WhatsApp) on approval.
- **SCHEDULE:** Mila will find a slot, block the calendar, and send an invite on approval.
- **TODO:** Something the agent must do themselves. Mila describes what and why.

One deal can produce multiple actions.

### 3.2 Action Card Content

Each action card contains:

- Deal context summary (the narrative, not raw messages)
- Mila's proposed plan: what she intends to do and a rough outline of what she'll say
- Missing information: if Mila needs specific input to draft well, she identifies what's missing
- Priority score
- Action buttons: UDĚLAT, UPRAVIT, UDĚLÁM SÁM

### 3.3 Approval Workflow

Action cards do not contain finished drafts. The workflow is multi-step:

1. **Action card** — Mila presents her plan and outline.
2. **Edit card** (on UPRAVIT) — A form with deal-specific questions Mila needs answered (e.g. is parking available? when was the roof last done?) plus a general comments field for the agent to shape tone or add details.
3. **Draft** — Generated on-demand at execution time, not during proposal creation. Mila generates the full draft using conversation context, approved intent, and edit input. Draft tone adapts to channel (formal for email, short for WhatsApp) and counterparty (configured per user).
4. **Review** — Agent reviews draft, can edit again, then approves with UDĚLAT. Mila sends.

### 3.4 Deduplication

One deal should not produce duplicate action cards across pipeline runs. If an action was proposed in a previous brief and the agent hasn't acted on it, it carries forward — not duplicated. If new information changes the proposed action, the card updates.


## 4. Priority Ranking

Based on the WSJF (Weighted Shortest Job First) framework, adapted for real estate. The ranking formula and the scheduling constraint are separate systems.

### 4.1 Brief Priority Formula

**Score = (nVal × sellerMult) + (urgency × daysIgnored^1.5) + W**

Three additive terms — deal importance + time pressure + scheduling weight:

Where:

- **nVal:** deal value normalized to the agent's typical range, producing meaningful separation across their full deal spectrum. A small deal for this agent scores low; a large deal scores high. Hard floor of 1 — no deal ever drops to 0. The normalization method is a Layer 3 implementation detail — what matters is that the output produces a usable ranked order.
- **sellerMult:** multiplier applied to seller-side deals. Sellers are harder to find than buyers. Configured per agent.
- **urgency (0–10):** AI-assigned based on when the action is due. Urgency is about scheduling — when something needs to happen. It is not about conversation health (that's lead protection, §5). Multiplied against daysIgnored^1.5 — urgency amplifies the aging curve.
- **W:** scheduling immovability (1–10 or 100), added flat to the priority score. A hard-to-move event with W=7 outranks an otherwise equivalent event with W=1. See §4.2 for the full W scale. W serves double duty: it contributes to ranking AND determines how strongly an event resists being moved by the scheduler.

**Urgency scale:**

| U | Meaning |
|---|---------|
| 10 | Due within 1 hour. Do NOW. |
| 9 | Due within 8 business hours. Do NOW or ASAP. |
| 8 | Due end of business tomorrow. |
| 7 | Due in 2 business days. |
| 6 | Due in 3 business days. |
| 5 | Due in 5 business days. Try before EOD Friday. |
| 4 | Due next week. Try for EOD Friday or next Wednesday. |
| 3 | Due within 2 weeks. Deadline exists but not yet visible. |
| 2 | (unused) |
| 1 | No time pressure. |

**Display thresholds:**
- 9–10: "MUSÍŠ to udělat TEĎ" (must do now)
- 7–8: "Měl bys to udělat dnes" (should do today)
- 5–6: "Měl bys to udělat brzy" (should do soon)

**Instant alert trigger:** urgency > 8.
- **daysIgnored^1.5:** non-linear escalation. A conversation ignored for 2 days is mildly elevated. Ignored for 7 days escalates sharply. This drives lead protection behavior (see §5).

These factors are independent. A small urgent deal beats a large routine one. A todo with today's deadline beats a high-value deal that can wait.

### 4.2 Slot Defense (W — Immovability)

W serves dual purpose: it is added flat to the priority score AND determines how strongly an existing calendar event resists being moved by the scheduler.

- **1–10:** movable to hard-to-move. A casual viewing might be a 3. A client meeting with a specific requested time might be a 7.
- **100:** effectively immovable. Court dates, notary appointments, personal commitments (doctor, kids' concert, partner's flight). The gap between 10 and 100 is intentional — it creates a hard tier.

W applies to non-deal events too. The agent's life doesn't stop for work. W is never null — every event has a value.

### 4.3 Conflict Resolution

When Mila needs to schedule something and a conflict exists:

- She compares the new action's priority against the existing event's W.
- At urgency 9–10, Mila will suggest moving even a W=100 event.
- She always presents both sides. The agent decides. Mila never silently moves or drops anything.

The test case: a W=100 personal event against an nVal-max deal with a single possible time slot. An impossible situation. Mila surfaces the conflict, presents both sides, and the agent chooses. This is by design.

## 5. Lead Protection

Mila scans every deal for signs of going stale. Escalation is progressive:

- **2–5 days silent:** gentle flag. "You haven't replied to Bob about the Vinohradská viewing."
- **5–14 days silent:** urgent. Priority boosted via daysIgnored^1.5. This lead is slipping.
- **14+ days silent:** last chance. If this deal is saveable, now is the time.

These thresholds are configurable per agent during onboarding. The daysIgnored factor in the priority formula ensures stale deals naturally rise in the rankings without manual intervention.

Mila caps automatic follow-up proposals at 3 per deal. After three unanswered nudges, the deal still appears in lead tracking but Mila stops generating new follow-up actions — the agent must decide whether to re-engage or let it go.

## 6. Brief Assembly

### 6.1 Brief Types

- **AM brief:** covers the full day. Prioritized action cards, calendar overview, AI-generated headline summarizing priorities. Default 7:00, configurable. Prepares the agent before their main work block.
- **PM brief:** what's still hanging from morning, plus preview of tomorrow. Default 11:30, configurable. Prepares the agent for the afternoon. Whether this is a default or user-configurable option is TBD.
- **Instant alerts:** triggered when any action's urgency > 8. Same action card format, immediate email delivery. If the agent doesn't act, it reappears in the next brief.

### 6.2 Brief Content

Each brief email contains:

- AI-generated headline summarizing the day's priorities
- Today's calendar at a glance
- Ranked action cards, highest priority first
- Each card: deal context, proposed action, UDĚLAT / UPRAVIT / UDĚLÁM SÁM buttons

## 7. Calendar & Scheduling

### 7.1 Calendar Sync

Mila syncs Google Calendar on each pipeline run. The calendar serves as both input (what's already booked, where the agent is) and output (holds, confirmed events, invites).

### 7.2 Slot Finding

When generating a SCHEDULE action, Mila:

- Identifies available slots based on agent's working hours and existing calendar
- Respects CP-stated times: if the counterparty said "Tuesday at 9," Mila books Tuesday at 9. If there's a conflict, she reports it — she doesn't silently pick a different time.
- Calculates travel time between locations (Google Maps) and builds travel buffers into the calendar
- Considers the full day: won't schedule a 10am in Dejvice and a 10:45 in Černý Most

### 7.3 Batch Optimization

Before assembling the morning brief, Mila looks at all pending scheduling actions and assigns slots in one pass — highest priority first, respecting CP availability, agent availability, travel, and conflicts. No double-booking.

### 7.4 Hold Events

Each proposed meeting gets a tentative calendar hold to prevent double-booking while the agent reviews. Approved → confirmed + invite sent. Rejected → cleared.

### 7.5 Inbound Invitations

When Mila detects an incoming calendar invitation, she creates a SCHEDULE action — never auto-accepts. The action card shows the invitation details, checks the agent's calendar for conflicts, and suggests accept, reject, or propose a new time. The agent decides.

## 8. Execution

When the agent approves an action:

- **REPLY:** Mila generates the draft (if not already generated via the edit workflow), sends the email or WhatsApp message.
- **SCHEDULE:** Hold becomes confirmed. Invite sent to counterparty. Travel buffer booked.
- **TODO:** Logged with due date.

The agent can also dismiss (remove from queue), defer (reappear in next brief), or blacklist a counterparty.

## 9. Channels

### 9.1 Email (Live)

- Polls Gmail on per-user cron (QStash)
- Reads inbound and outbound — understands who sent what, what they're asking, and what the agent already said back
- Sends via Gmail on agent's behalf when actions are approved

### 9.2 WhatsApp (Built, Not Yet Live)

- Architecturally designed to ingest WhatsApp messages into the same deal-level conversation model as email
- Incoming messages arrive via a standalone WhatsApp daemon and are stored, processed on next pipeline run
- Group chat support: Mila identifies individual senders within group conversations
- Built and integrated into the pipeline. Not yet tested or deployed to production.

### 9.3 Calendar (Live)

- Google Calendar sync on each pipeline run
- Both input and output (see §7)

## 10. Per-Agent Configuration

Configured during onboarding consultation, not self-serve.

- **Identity:** name, company, role
- **Business context:** specialization, market, typical deal range (used for nVal normalization)
- **AI persona:** how Mila communicates to the agent vs. to counterparties, tone per channel
- **Working hours:** days, hours, timezone
- **Brief schedule:** morning and afternoon times
- **Meeting defaults:** duration, buffer between meetings
- **Locations:** home, office (for travel time calculation)
- **Lead protection:** silence thresholds for escalation tiers
- **High-value signals:** keywords that flag a conversation as important
- **Seller multiplier:** configured to the agent's market
- **Counterparty tone preferences**

## 11. Data & Privacy

- All data isolated per agent — every query filtered by user_id
- GDPR compliant: full data export, full data deletion, audit trail
- OAuth tokens encrypted
- No data shared between agents
