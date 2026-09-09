import { Router } from "express";
import { createUser, currentUser, deleteUser, listUsers, login } from "../controllers/auth.controller";
import { requireAdmin } from "../middlewares/admin.middleware";

const router = Router();
router.post("/login", login);
router.get("/me", requireAdmin, currentUser);
router.get("/users", requireAdmin, listUsers);
router.delete("/users/:id", requireAdmin, deleteUser);
router.post("/users", requireAdmin, createUser);
export default router;
