import { Router } from "express";
import { getPaymentSettings, getStoreSettings, getStorePublic, updatePaymentSettings, updateStoreSettings } from "../controllers/settings.controller";
import { requireAdmin } from "../middlewares/admin.middleware";

const router = Router();

router.get("/payments", requireAdmin, getPaymentSettings);
router.put("/payments", requireAdmin, updatePaymentSettings);
// Sucursales: la web las lee sin sesion; solo un admin las cambia.
router.get("/store/public", getStorePublic);
router.get("/store", requireAdmin, getStoreSettings);
router.put("/store", requireAdmin, updateStoreSettings);

export default router;
