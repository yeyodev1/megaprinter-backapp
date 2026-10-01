import { Router } from "express";
import multer from "multer";
import {
  confirmPayphonePayment,
  createOrder,
  createPaymentIntent,
  getPaymentOrder,
  getPayphoneConfig,
  getTransferConfig,
  listOrders,
  reviewTransfer,
  updateOrderStatus,
  uploadPaymentReceipt,
} from "../controllers/order.controller";
import {
  whatsappBotBrain,
  whatsappBotCatalog,
  whatsappBotSearchOrder,
  whatsappBotTransferReceipt,
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
router.post("/pay/:token/receipt", receiptUpload.single("receipt"), uploadPaymentReceipt);

// Bot de WhatsApp (BuilderBot). Siempre responden 200; ver docs/whatsapp-bot.md.
router.all("/whatsapp-bot/brain", whatsappBotBrain);
router.all("/whatsapp-bot/assistant", whatsappBotBrain);
router.all("/whatsapp-bot/transfer-receipt", whatsappBotTransferReceipt);
router.all("/whatsapp-bot/catalog", whatsappBotCatalog);
router.all("/whatsapp-bot/search-order", whatsappBotSearchOrder);

export default router;
