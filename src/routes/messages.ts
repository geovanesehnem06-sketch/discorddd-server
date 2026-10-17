import { FastifyPluginAsync } from 'fastify';
import { authenticate } from '../middleware/auth.js';

export const messageRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: authenticate }, async () => {
    return { messages: [] };
  });
};