import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { auditRequest } from '../services/auditB';

interface Order {
  id: number;
  userId: number;
  total: number;
}

const orders: Order[] = [
  { id: 100, userId: 1, total: 42.5 },
  { id: 101, userId: 2, total: 13.37 },
];

export const ordersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
    return sendSuccess(reply, { items: orders, audit: auditRequest(request) });
  });
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const order = orders.find((o) => o.id === Number(request.params.id));
    if (!order) return sendError(reply, 'Order not found', 404);
    return sendSuccess(reply, order);
  });
};
