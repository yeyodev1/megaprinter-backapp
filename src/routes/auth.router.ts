import { Router } from "express";
import {
  createTechnician,
  createUser,
  currentUser,
  deleteUser,
  listTechnicians,
  listUsers,
  login,
  resetTechnicianPassword,
  updateTechnician,
} from "../controllers/auth.controller";
import { requireAdmin, requireStaff } from "../middlewares/admin.middleware";

const router = Router();
router.post("/login", login);
router.get("/me", requireStaff, currentUser);
router.get("/users", requireAdmin, listUsers);
router.delete("/users/:id", requireAdmin, deleteUser);
router.post("/users", requireAdmin, createUser);
// Tecnicos: solo entran al tablero de tickets; los gestiona un admin.
router.get("/technicians", requireAdmin, listTechnicians);
router.post("/technicians", requireAdmin, createTechnician);
router.patch("/technicians/:id", requireAdmin, updateTechnician);
router.post("/technicians/:id/password", requireAdmin, resetTechnicianPassword);
export default router;
