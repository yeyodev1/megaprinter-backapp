import { Router } from "express";
import { listAlerts, listAssignees, listTickets, markAlertsRead, summarizeTicketHandler, updateTicket } from "../controllers/tickets.controller";
import { requireAdmin, requireStaff } from "../middlewares/admin.middleware";

// El tablero lo usan admins y tecnicos; asignar a otra persona y las alertas, solo admins.
export const ticketsRouter = Router();
ticketsRouter.get("/", requireStaff, listTickets);
ticketsRouter.get("/assignees", requireAdmin, listAssignees);
ticketsRouter.patch("/:id", requireStaff, updateTicket);
ticketsRouter.post("/:id/summary", requireStaff, summarizeTicketHandler);

export const alertsRouter = Router();
alertsRouter.get("/", requireAdmin, listAlerts);
alertsRouter.post("/read", requireAdmin, markAlertsRead);
