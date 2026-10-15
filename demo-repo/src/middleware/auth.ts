import type { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils/response';

/**
 * API-key guard. Note: `req.get(...)` is a header read, NOT a route
 * registration — route extractors must not misclassify it.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.get('x-api-key');
  if (apiKey !== 'secret-token') {
    return sendError(res, 'Unauthorized', 401);
  }
  next();
}
