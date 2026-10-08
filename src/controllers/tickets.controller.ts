import { NextFunction, Request, Response } from "express";
import { AdminRequest } from "../middlewares/admin.middleware";
import { TICKET_STATUSES, ServiceTicketModel } from "../models/serviceTicket.model";
import { AlertModel } from "../models/alert.model";
import { summarizeTicket } from "../services/tickets.service";

/** GET /api/tickets?status=&type= */
export async function listTickets(req: Request, res: Response, next: NextFunction) {
  try {
    const filter: Record<string, unknown> = {};
    if (typeof req.query.status === "string" && req.query.status) filter.status = req.query.status;
    if (typeof req.query.type === "string" && req.query.type) filter.type = req.query.type;
    res.json(await ServiceTicketModel.find(filter).sort({ createdAt: -1 }).limit(300).lean());
  } catch (error) {
    next(error);
  }
}

/** PATCH /api/tickets/:id { status?, note?, finalPrice?, assignedTo? } */
export async function updateTicket(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const ticket = await ServiceTicketModel.findById(req.params.id);
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });
    const by = req.admin?.email || "";
    const { status, note, finalPrice, assignedTo } = req.body ?? {};
    if (status !== undefined) {
      if (!TICKET_STATUSES.includes(status)) return res.status(400).json({ error: "Estado no válido" });
      if (status !== ticket.status) {
        ticket.status = status;
        ticket.statusHistory.push({ status, by, at: new Date() });
      }
    }
    if (typeof note === "string" && note.trim()) ticket.notes.push({ text: note.trim().slice(0, 1000), by, at: new Date() });
    if (finalPrice !== undefined) {
      const value = finalPrice === null || finalPrice === "" ? null : Number(finalPrice);
      if (value !== null && (!Number.isFinite(value) || value < 0)) return res.status(400).json({ error: "Precio no válido" });
      ticket.finalPrice = value;
    }
    if (typeof assignedTo === "string") ticket.assignedTo = assignedTo.trim().slice(0, 120);
    await ticket.save();
    res.json(ticket);
  } catch (error) {
    next(error);
  }
}

/** POST /api/tickets/:id/summary — (re)genera el resumen con IA. */
export async function summarizeTicketHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!(await ServiceTicketModel.exists({ _id: req.params.id }))) return res.status(404).json({ error: "Ticket no encontrado" });
    const ticket = await summarizeTicket(String(req.params.id));
    if (!ticket) return res.status(503).json({ error: "La IA no respondió. Intenta de nuevo en un momento." });
    res.json(ticket);
  } catch (error) {
    next(error);
  }
}

/** GET /api/alerts?limit= → { unread, alerts } */
export async function listAlerts(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = Math.min(Number(req.query.limit) || 40, 100);
    const [alerts, unread] = await Promise.all([
      AlertModel.find().sort({ createdAt: -1 }).limit(limit).lean(),
      AlertModel.countDocuments({ read: false }),
    ]);
    res.json({ unread, alerts });
  } catch (error) {
    next(error);
  }
}

/** POST /api/alerts/read { ids?: string[] } — sin ids marca todas. */
export async function markAlertsRead(req: Request, res: Response, next: NextFunction) {
  try {
    const ids: unknown = req.body?.ids;
    const filter = Array.isArray(ids) && ids.length ? { _id: { $in: ids.filter((id) => typeof id === "string") } } : { read: false };
    await AlertModel.updateMany(filter, { $set: { read: true } });
    res.json({ unread: await AlertModel.countDocuments({ read: false }) });
  } catch (error) {
    next(error);
  }
}
