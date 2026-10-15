import type { Request } from 'express';
import { shortHash } from '../utils/hash';
import { formatAuditLine } from './auditB';

/** Extracts stable request metadata. Forms an import cycle with auditB. */
export function describeRequest(req: Request): string[] {
  const agent = String(req.headers['user-agent'] ?? 'unknown');
  return [req.method, shortHash(agent)];
}

/** Builds an audit tag for a request (delegates formatting to auditB). */
export function auditTag(req: Request): string {
  return formatAuditLine(describeRequest(req));
}
