import { authenticate } from '../middleware/auth.js';
export const userRoutes = async (app) => {
    app.get('/me', { preHandler: authenticate }, async (request) => {
        return { userId: request.user.userId };
    });
};
//# sourceMappingURL=users.js.map