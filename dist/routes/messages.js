import { authenticate } from '../middleware/auth.js';
export const messageRoutes = async (app) => {
    app.get('/', { preHandler: authenticate }, async () => {
        return { messages: [] };
    });
};
//# sourceMappingURL=messages.js.map