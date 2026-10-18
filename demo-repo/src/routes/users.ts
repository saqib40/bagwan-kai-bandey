import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { auditRequest } from '../services/auditB';

interface User {
  id: number;
  name: string;
}

const users: User[] = [
  { id: 1, name: 'Ada Lovelace' },
  { id: 2, name: 'Alan Turing' },
];

export const usersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
    return sendSuccess(reply, { items: users, audit: auditRequest(request) });
  });
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const user = users.find((u) => u.id === Number(request.params.id));
    if (!user) return sendError(reply, 'User not found', 404);
    return sendSuccess(reply, user);
  });
  fastify.post<{ Body: { name?: string } }>('/', { preHandler: requireAuth }, async (request, reply) => {
    const name = request.body?.name;
    if (!name) return sendError(reply, 'name is required', 400);
    const user: User = { id: users.length + 1, name };
    users.push(user);
    return sendSuccess(reply, user, 201);
  });
};
