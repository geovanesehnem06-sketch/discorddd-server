import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { logger } from './lib/logger.js';
import { initDb, testConnection, startAutoSave, end as endDb } from './db/pool.js';
import { authRoutes } from './routes/auth.js';
import { serverRoutes } from './routes/servers.js';
import { channelRoutes } from './routes/channels.js';
import { messageRoutes } from './routes/messages.js';
import { userRoutes } from './routes/users.js';
import { voiceRoutes } from './routes/voice.js';
import { wsHandler } from './ws/handler.js';

const app = Fastify({
  logger: false,
});

await app.register(cors, {
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
});

await app.register(websocket);

app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

await app.register(authRoutes, { prefix: '/api/auth' });
await app.register(userRoutes, { prefix: '/api/users' });
await app.register(serverRoutes, { prefix: '/api/servers' });
await app.register(channelRoutes, { prefix: '/api/channels' });
await app.register(messageRoutes, { prefix: '/api/messages' });
await app.register(voiceRoutes, { prefix: '/api/voice' });
app.register(wsHandler, { path: '/ws' });

const port = Number(process.env.PORT) || 3000;
const host = '0.0.0.0';

try {
  // Initialize SQLite database
  await initDb();
  testConnection();
  startAutoSave();
  logger.info('SQLite database connected and auto-save started');

  await app.listen({ port, host });
  logger.info(`Server running on http://${host}:${port}`);
} catch (err) {
  logger.error(err, 'Failed to start server');
  process.exit(1);
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  await app.close();
  await endDb();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  await app.close();
  await endDb();
  process.exit(0);
});