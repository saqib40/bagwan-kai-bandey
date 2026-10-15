import express from 'express';
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

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  return sendSuccess(res, { items: users, audit: auditRequest(req) });
});

router.get('/:id', requireAuth, (req, res) => {
  const user = users.find((u) => u.id === Number(req.params.id));
  if (!user) return sendError(res, 'User not found', 404);
  return sendSuccess(res, user);
});

router.post('/', requireAuth, (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  if (!name) return sendError(res, 'name is required', 400);
  const user: User = { id: users.length + 1, name };
  users.push(user);
  return sendSuccess(res, user, 201);
});

export const usersRouter = router;
