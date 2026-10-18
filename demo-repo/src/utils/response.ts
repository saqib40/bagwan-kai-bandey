import type { FastifyReply } from 'fastify';

export function sendSuccess(reply: FastifyReply, data: unknown, statusCode = 200) {
  return reply.code(statusCode).send({ ok: true, data });
}

export function sendError(reply: FastifyReply, message: string, statusCode = 400) {
  return reply.code(statusCode).send({ ok: false, error: message });
}
