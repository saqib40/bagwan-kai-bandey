import { shortHash } from '../utils/hash';
import { formatAuditLine } from './auditB';

export interface AuditableRequest {
  method?: string;
  headers: Record<string, unknown>;
}

export function describeRequest(req: AuditableRequest): string[] {
  const agent = String(req.headers?.['user-agent'] ?? 'unknown');
  return [req.method ?? 'GET', shortHash(agent)];
}

export function auditTag(req: AuditableRequest): string {
  return formatAuditLine(describeRequest(req));
}
