import { Router } from "express";
import multer from "multer";
import {
  confirmPayphonePayment,
  createOrder,
  createPaymentIntent,
  getPaymentOrder,
  getPayphoneConfig,
  getTransferConfig,
  choosePaymentBank,
  listOrders,
  reviewTransfer,
  updateOrderStatus,
  uploadPaymentReceipt,
} from "../controllers/order.controller";
import {
  whatsappBotCatalog,
  whatsappBotDecide,
  whatsappBotTransferReceipt,
  whatsappBotTurn,
} from "../controllers/whatsappBot.controller";
import { requireAdmin } from "../middlewares/admin.middleware";
import { CustomError } from "../errors/customError.error";

const router = Router();

const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (/^image\/(jpe?g|png|webp|heic|heif)$|^application\/pdf$/i.test(file.mimetype)) return callback(null, true);
    callback(new CustomError("Sube una foto (JPG, PNG, WEBP) o un PDF del comprobante", 415));
  },
});

router.post("/", createOrder);
router.get("/", requireAdmin, listOrders);
router.patch("/:id/status", requireAdmin, updateOrderStatus);
router.patch("/:id/transfer", requireAdmin, reviewTransfer);
router.get("/payphone/config", getPayphoneConfig);
router.post("/payphone/confirm", confirmPayphonePayment);
router.get("/transfer/config", getTransferConfig);

// Enlace privado de pago: lo abre el cliente desde el bot o tras el checkout web.
router.get("/pay/:token", getPaymentOrder);
router.post("/pay/:token/intent", createPaymentIntent);
router.post("/pay/:token/bank", choosePaymentBank);
router.post("/pay/:token/receipt", receiptUpload.single("receipt"), uploadPaymentReceipt);

// Bot de WhatsApp (BuilderBot). Siempre responden 200; ver docs/whatsapp-bot.md.
// Flujo principal: solo decide la ruta (no responde al cliente).
router.all("/whatsapp-bot/brain", whatsappBotDecide);
router.all("/whatsapp-bot/router", whatsappBotDecide);
// Flujos destino: procesan el mensaje y responden en `message`.
router.all("/whatsapp-bot/conversation", whatsappBotTurn);
router.all("/whatsapp-bot/checkout", whatsappBotTurn);
router.all("/whatsapp-bot/search-order", whatsappBotTurn);
router.all("/whatsapp-bot/human", whatsappBotTurn);
router.all("/whatsapp-bot/assistant", whatsappBotTurn);
router.all("/whatsapp-bot/catalog", whatsappBotCatalog);
router.all("/whatsapp-bot/media", whatsappBotTransferReceipt);
router.all("/whatsapp-bot/transfer-receipt", whatsappBotTransferReceipt);

export default router;
