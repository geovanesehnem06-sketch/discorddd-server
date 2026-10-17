import { FastifyRequest, FastifyReply } from 'fastify';
declare module 'fastify' {
    interface FastifyRequest {
        user?: {
            userId: string;
            email: string;
        };
    }
}
export declare function signAccessToken(userId: string, email: string): string;
export declare function signRefreshToken(userId: string): string;
export declare function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<undefined>;
