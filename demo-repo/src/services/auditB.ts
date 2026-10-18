import { describeRequest, type AuditableRequest } from './auditA';

export function formatAuditLine(parts: string[]): string {
  return parts.join(':');
}

export function auditRequest(req: AuditableRequest): string {
  const [method, hash] = describeRequest(req);
  return formatAuditLine([method, hash]);
}
