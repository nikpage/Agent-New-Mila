# Mila — Functional Specification

---

## 1. Periodic Monitoring

Mila polls all communication channels on a schedule — no real-time streaming.

- **Email:** Polls Gmail on cron (per-user QStash schedules). Reads inbound and outbound. Understands who sent what, what they're asking, and what the user already said back.
- **WhatsApp:** Incoming messages arrive via connected WhatsApp daemon and are stored. Processed on next pipeline run.
- **Calendar:** Syncs Google Calendar on each pipeline run. Knows where the user is, when they're free, what's coming up.

Pipeline runs on per-user cron schedules (QStash) and can also be triggered manually via API. There's also a tracking pixel in brief emails — when the user opens the brief, it triggers a fresh pipeline run so actions are up to date when they click.

---

## 2. Understanding Conversations

Every message gets threaded into the right conversation — even across channels. An email from Jan Novotny about the Vinohrady property and a WhatsApp from the same person about the same deal land in the same conversation.

- Messages are enriched: key facts extracted (who, what property, what stage, what money)
- Conversations are summarized: current state, risks, next steps
- Semantic search matches messages to conversations when thread IDs don't work (different channels, forwarded emails, new subject lines)

---

## 3. Proactive Action Proposals

For every conversation that needs attention, Mila proposes specific actions. Not "you should follow up" — specific: "I'll confirm the 45M purchase price to Jan Novotny and agree to the notary meeting at 9:00 tomorrow. Click UDĚLAT and I send the email."

Three action types:

- **REPLY** — Mila prepares a message to send (email or WhatsApp). User approves or edits, then Mila sends it.
- **SCHEDULE** — Mila finds the right time, blocks the calendar, and prepares an invite. User approves, Mila sends the invite.
- **TODO** — Something the user has to do themselves (gather documents, call a lawyer). Mila describes exactly what and why.

One conversation can produce multiple actions: confirm the deal (REPLY), block the notary appointment (SCHEDULE), gather documents for the meeting (TODO).

---

## 4. Priority Ranking

Not everything is equally urgent. Mila ranks every action by four factors:

- **Deal value** — bigger deals surface higher, scaled to the user's normal range so a 2M agent and a 50M agent both get useful rankings
- **Urgency** — how soon this needs a response (deadline today vs. routine follow-up)
- **Time ignored** — how long the conversation has been sitting without action, escalates fast
- **Immovability** — can this be moved? A viewing is flexible. A court date is not.

These are independent. A small urgent deal beats a big routine one. A todo with a deadline today beats a 50M deal that can wait until next week.

---

## 5. Lead Protection

The core anti-churn mechanism. Mila scans every conversation for signs of going stale:

- **2-5 days silent** — gentle check-in. "You haven't replied to Bob about the Vinohradská viewing."
- **5-14 days silent** — urgent follow-up. Priority boosted. This lead is slipping.
- **14+ days silent** — last chance. If this one's saveable, now is the time.

Mila catches cooling leads before the user even notices they've gone quiet. This is the one-deal-per-year that pays for everything.

---

## 6. Calendar & Scheduling

Mila doesn't just find a free slot. She thinks about the whole day.

- **Location-aware:** Knows where each meeting is. Won't schedule a 10am in Dejvice and a 10:45 in Černý Most. Calculates real driving time via Google Maps and builds travel buffers into the calendar.
- **Batch optimization:** Before sending the morning brief, Mila looks at ALL pending meetings and assigns slots in one pass — highest priority first, respecting CP availability, user availability, travel, and conflicts. No double-booking.
- **CP-stated times respected:** If the counterparty said "Tuesday at 9," Mila books Tuesday at 9. If there's a conflict, she reports it — she doesn't silently pick a different time.
- **Hold events:** Each proposed meeting gets a tentative calendar hold. Prevents double-booking while the user reviews. Approved → confirmed + invite sent. Rejected → cleared.
- **Conflict resolution:** When two things overlap, Mila compares priority. She may suggest moving the lower-priority event — but the user always decides. She never auto-moves confirmed meetings.

---

## 7. Morning Brief

Every morning (and optionally afternoon), the user gets one email:

- AI-generated headline summarizing the day's priorities
- Today's calendar at a glance
- Ranked action cards, most urgent first
- Each card: who, what's at stake, what Mila proposes, and three buttons — UDĚLAT (approve), UPRAVIT (edit), UDĚLÁM SÁM (handle it myself)

That's the user's entire interaction. One email. A few taps. Done.

---

## 8. Instant Alerts

When something truly can't wait for the morning brief — urgency 9 or 10 — Mila sends an immediate notification. Same format, same action buttons. If the user doesn't act, it reappears in the next brief.

---

## 9. Draft Generation

Mila doesn't write drafts upfront. When the user clicks approve, she generates the email or WhatsApp message on demand using:

- Full conversation context
- The approved intent
- Any notes the user added
- The right tone for the channel (formal for email, short for WhatsApp)
- The right tone for the counterparty (configured per user)

---

## 10. Per-Client Configuration

Each client gets Mila configured for their specific business:

- Identity, company, role
- Business context: specialization, market, typical deal range
- AI persona: how Mila talks to the user vs. to counterparties
- Working hours, working days, timezone
- Meeting defaults: duration, buffer between meetings
- Lead tracking thresholds: when to nudge, when to escalate
- High-value signals: keywords that flag a conversation as important
- Home and office locations for travel calculation

No self-serve. Configured during onboarding consultation.

---

## 11. Execution

When the user approves an action:

- **REPLY:** Mila generates and sends the email/WhatsApp message
- **SCHEDULE:** Hold becomes confirmed, invite sent to counterparty, travel buffer booked
- **TODO:** Logged to user's task list with due date

The user can edit before sending. They can also dismiss, defer, or blacklist a counterparty.

---

## 12. Data & Privacy

- All data isolated per user (every query filtered by user_id)
- GDPR compliant: full data export, full data deletion, audit trail
- OAuth tokens encrypted
- No data shared between clients
