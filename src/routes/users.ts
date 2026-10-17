import { FastifyPluginAsync } from 'fastify';
import { authenticate } from '../middleware/auth.js';

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', { preHandler: authenticate }, async (request) => {
    return { userId: request.user!.userId };
  });
};