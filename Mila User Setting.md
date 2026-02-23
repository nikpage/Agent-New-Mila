# User Settings Configuration Guide

This document outlines all available configuration options for Mila users.  
These settings are stored as a JSON object in the `users` table under the `settings` column.

---

## Configuration Fields

| Field | Type | Description | Default |
|---|---|---|---|
| working_hours_start | Number | Start of work day (0–23) | 9 |
| working_hours_end | Number | End of work day (0–23) | 17 |
| working_days | Array | Days of the week (1=Mon, 7=Sun) | [1,2,3,4,5] |
| timezone | String | IANA Timezone (e.g., "America/New_York") | "Europe/Prague" |
| morning_brief_time | String | Time for daily brief (HH:MM) | "08:00" |
| default_meeting_duration | Number | Default meeting length in minutes | 30 |
| default_meeting_type | String | online, phone, office, walking | "online" |
| meeting_buffer_minutes | Number | Buffer time between meetings (min) | 15 |
| travel_mode | String | driving, walking, transit, bicycling | "driving" |
| home_location | String | Full address for travel calculations | "" |
| office_location | String | Full address for travel calculations | "" |
| offer_multiplier_seller | Number | Priority boost for seller leads (e.g., 1.5) | 1.5 |
| offer_multiplier_buyer | Number | Priority boost for buyer leads (e.g., 1.0) | 1.0 |
| priority_multiplier_vip | Number | Priority boost for VIP contacts (e.g., 2.0) | 2.0 |
| kc_factor | Number | Fibonacci-based constant that normalizes dollar values in priority scoring. Higher = less impact of raw CZK on score. (e.g., 13, 21) | 13 |
| default_delegate_email | String | Email address to delegate tasks to | null |
| todo_auto_due_days | Number | Default due date offset (days) | 1 |
| ai_tone_user | String | Tone for messages to the user | "professional and concise" |
| ai_tone_cp | String | Tone for messages to counterparties | "polite and formal" |
| user_alias | String | Name Mila uses to address the user | "User" |

---

## Example JSON Configuration

Copy and paste this into the `settings` column in Supabase to apply a custom configuration.

```json
{
  "timezone": "America/Los_Angeles",
  "working_hours_start": 8,
  "working_hours_end": 18,
  "working_days": [1, 2, 3, 4, 5],
  "default_meeting_duration": 45,
  "default_meeting_type": "phone",
  "meeting_buffer_minutes": 10,
  "travel_mode": "driving",
  "home_location": "123 Main St, Beverly Hills, CA",
  "office_location": "456 Market St, San Francisco, CA",
  "offer_multiplier_seller": 2.0,
  "offer_multiplier_buyer": 1.2,
  "priority_multiplier_vip": 3.0,
  "kc_factor": 21,
  "default_delegate_email": "assistant@agency.com",
  "todo_auto_due_days": 2,
  "ai_tone_user": "friendly and casual",
  "ai_tone_cp": "professional and persuasive",
  "user_alias": "Boss"
}

## How to Apply Settings

Log in to Supabase Dashboard.
Navigate to Table Editor -> users.
Locate the user row you wish to configure.
Double-click the settings column (it may be null or empty).
Paste the JSON configuration.
Click Save.
The changes take effect immediately on the next API request.
