// app/api/ingest/route.ts

// Inside the ingestion loop in app/api/ingest/route.ts
const command = parseEmailCommand(email.bodyPlain);
if (command.command) {
  await executeUserCommand(userId, command, user.google_oauth_tokens);
}
