import { Router } from "express";
import { listAlerts, listTickets, markAlertsRead, updateTicket } from "../controllers/tickets.controller";
import { requireAdmin } from "../middlewares/admin.middleware";

export const ticketsRouter = Router();
ticketsRouter.get("/", requireAdmin, listTickets);
ticketsRouter.patch("/:id", requireAdmin, updateTicket);

export const alertsRouter = Router();
alertsRouter.get("/", requireAdmin, listAlerts);
alertsRouter.post("/read", requireAdmin, markAlertsRead);
