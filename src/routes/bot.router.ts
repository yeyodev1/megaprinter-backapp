import { Router } from "express";
import { getBotStats, getConversation, listBotEvents, listConversations, resetConversation } from "../controllers/botAdmin.controller";
import {
  createLesson,
  deleteLesson,
  getLearning,
  getPersona,
  listPhotos,
  runLearningNow,
  savePersona,
  updateLesson,
  updatePhoto,
} from "../controllers/botLearning.controller";
import { requireAdmin } from "../middlewares/admin.middleware";

// Panel del bot. Fuera de /whatsapp-bot/ a proposito: esas rutas no llevan CORS ni JWT.
const router = Router();

router.get("/stats", requireAdmin, getBotStats);
router.get("/events", requireAdmin, listBotEvents);
router.get("/conversations", requireAdmin, listConversations);
router.get("/conversations/:phone", requireAdmin, getConversation);
router.delete("/conversations/:phone", requireAdmin, resetConversation);

// Aprendizaje diario (Sistema → Aprendizaje).
router.get("/learning", requireAdmin, getLearning);
router.post("/learning/run", requireAdmin, runLearningNow);
router.post("/learning/lessons", requireAdmin, createLesson);
router.patch("/learning/lessons/:id", requireAdmin, updateLesson);
router.delete("/learning/lessons/:id", requireAdmin, deleteLesson);

// La vista: fotos de clientes que el equipo confirma o corrige.
router.get("/learning/photos", requireAdmin, listPhotos);
router.patch("/learning/photos/:id", requireAdmin, updatePhoto);

// Personalidad de Mila: que decir, que no decir y el tono.
router.get("/persona", requireAdmin, getPersona);
router.put("/persona", requireAdmin, savePersona);

export default router;
