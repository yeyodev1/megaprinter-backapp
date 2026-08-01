import { Router } from "express";
import { confirmPayphonePayment, createOrder, getPayphoneConfig, listOrders } from "../controllers/order.controller";
import { requireAdmin } from "../middlewares/admin.middleware";

const router = Router();

router.post("/", createOrder);
router.get("/", requireAdmin, listOrders);
router.get("/payphone/config", getPayphoneConfig);
router.post("/payphone/confirm", confirmPayphonePayment);

export default router;
