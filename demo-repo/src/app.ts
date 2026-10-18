import express from 'express';
import { usersRouter } from './routes/users';
import { ordersRouter } from './routes/orders';

/** App factory: builds the app without binding a port (used by tests + dump-routes). */
export function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  app.use('/orders', ordersRouter);
  return app;
}

/** Boots the app on the given port. Owned here so server.ts stays framework-agnostic. */
export async function startServer(port: number) {
  const app = createApp();
  await new Promise<void>((resolve) => app.listen(port, () => resolve()));
  return app;
}
