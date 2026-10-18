import type { Request } from 'express';
import { describeRequest } from './auditA';

/** Joins audit parts into a single tag. */
export function formatAuditLine(parts: string[]): string {
  return parts.join(':');
}

/** Public entrypoint used by routes. Forms an import cycle with auditA. */
export function auditRequest(req: Request): string {
  return `audit:${formatAuditLine(describeRequest(req))}`;
}
