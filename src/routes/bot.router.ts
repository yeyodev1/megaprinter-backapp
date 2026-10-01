import { Router } from "express";
import { getBotStats, getConversation, listBotEvents, listConversations, resetConversation } from "../controllers/botAdmin.controller";
import { requireAdmin } from "../middlewares/admin.middleware";

// Panel del bot. Fuera de /whatsapp-bot/ a proposito: esas rutas no llevan CORS ni JWT.
const router = Router();

router.get("/stats", requireAdmin, getBotStats);
router.get("/events", requireAdmin, listBotEvents);
router.get("/conversations", requireAdmin, listConversations);
router.get("/conversations/:phone", requireAdmin, getConversation);
router.delete("/conversations/:phone", requireAdmin, resetConversation);

export default router;
