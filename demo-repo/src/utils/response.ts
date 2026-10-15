import type { Response } from 'express';

/** Standard success envelope. */
export function sendSuccess(res: Response, data: unknown, statusCode = 200) {
  return res.status(statusCode).json({ ok: true, data });
}

/** Standard error envelope. */
export function sendError(res: Response, message: string, statusCode = 400) {
  return res.status(statusCode).json({ ok: false, error: message });
}
