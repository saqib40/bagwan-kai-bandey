import express from 'express';
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

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  return sendSuccess(res, { items: orders, audit: auditRequest(req) });
});

router.get('/:id', requireAuth, (req, res) => {
  const order = orders.find((o) => o.id === Number(req.params.id));
  if (!order) return sendError(res, 'Order not found', 404);
  return sendSuccess(res, order);
});

export const ordersRouter = router;
