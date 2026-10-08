import { Router } from "express";
import { listAlerts, listTickets, markAlertsRead, summarizeTicketHandler, updateTicket } from "../controllers/tickets.controller";
import { requireAdmin } from "../middlewares/admin.middleware";

export const ticketsRouter = Router();
ticketsRouter.get("/", requireAdmin, listTickets);
ticketsRouter.patch("/:id", requireAdmin, updateTicket);
ticketsRouter.post("/:id/summary", requireAdmin, summarizeTicketHandler);

export const alertsRouter = Router();
alertsRouter.get("/", requireAdmin, listAlerts);
alertsRouter.post("/read", requireAdmin, markAlertsRead);
