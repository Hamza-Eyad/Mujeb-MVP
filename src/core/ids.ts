import { randomUUID } from 'node:crypto';

export type SessionId = string;
export type TurnId = string;

export function newSessionId(): SessionId {
  return `ses_${randomUUID()}`;
}

export function newTurnId(): TurnId {
  return `turn_${randomUUID()}`;
}
