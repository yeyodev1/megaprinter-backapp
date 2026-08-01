import { Router } from "express";
import { createUser, listUsers, login } from "../controllers/auth.controller";
import { requireAdmin } from "../middlewares/admin.middleware";

const router = Router();
router.post("/login", login);
router.get("/users", requireAdmin, listUsers);
router.post("/users", requireAdmin, createUser);
export default router;
