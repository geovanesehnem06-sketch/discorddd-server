import { FastifyPluginAsync } from 'fastify';
export declare const wsHandler: FastifyPluginAsync;
export declare function sendToUser(userId: string, data: unknown): void;
export declare function broadcastToChannel(channelId: string, data: unknown, excludeUserId?: string): void;
