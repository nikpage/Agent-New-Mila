// features/ingestion/types.ts

export interface IngestedEmail {
  id: string;
  threadId: string;
  universalId: string;
  from: string;
  to: string;
  subject: string;
  bodyPlain: string;
  bodyHtml: string;
  receivedAt: string;
}
