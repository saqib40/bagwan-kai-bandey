import Fastify from 'fastify';
import { usersRoutes } from './routes/users';
import { ordersRoutes } from './routes/orders';

/** App factory: builds the Fastify app without binding a port. */
export function createApp() {
  const app = Fastify();
  app.register(usersRoutes, { prefix: '/users' });
  app.register(ordersRoutes, { prefix: '/orders' });
  return app;
}

/** Boots the app on the given port. Owned here so server.ts stays framework-agnostic. */
export async function startServer(port: number) {
  const app = createApp();
  await app.listen({ port });
  return app;
}
