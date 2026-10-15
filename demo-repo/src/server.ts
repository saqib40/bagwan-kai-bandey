import { startServer } from './app';

const port = Number(process.env.PORT ?? 4000);
await startServer(port);
console.log(`listening on http://localhost:${port}`);
