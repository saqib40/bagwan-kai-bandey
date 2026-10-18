import type { FastifyRequest, FastifyReply } from 'fastify';
import { sendError } from '../utils/response';

/** Require auth preHandler (pure Fastify). */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers['x-api-key'];
  if (apiKey !== 'secret-token') {
    return sendError(reply, 'Unauthorized', 401);
  }
}
