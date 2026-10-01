import { Router } from "express";
import { getPaymentSettings, updatePaymentSettings } from "../controllers/settings.controller";
import { requireAdmin } from "../middlewares/admin.middleware";

const router = Router();

router.get("/payments", requireAdmin, getPaymentSettings);
router.put("/payments", requireAdmin, updatePaymentSettings);

export default router;
