import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { AdminRequest, actorName } from "../middlewares/admin.middleware";
import { TICKET_STATUSES, ServiceTicketModel } from "../models/serviceTicket.model";
import { UserModel } from "../models/user.model";
import { AlertModel } from "../models/alert.model";
import { summarizeTicket } from "../services/tickets.service";

/** GET /api/tickets?status=&type=&mine=1 */
export async function listTickets(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const filter: Record<string, unknown> = {};
    if (typeof req.query.status === "string" && req.query.status) filter.status = req.query.status;
    if (typeof req.query.type === "string" && req.query.type) filter.type = req.query.type;
    if (req.query.mine === "1" && req.admin?.id) filter.assignedToId = req.admin.id;
    res.json(await ServiceTicketModel.find(filter).sort({ createdAt: -1 }).limit(300).lean());
  } catch (error) {
    next(error);
  }
}

/** GET /api/tickets/assignees — accesos activos a los que un admin puede asignar tickets. */
export async function listAssignees(_req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const users = await UserModel.find({ active: { $ne: false } }).select("name role").sort({ role: -1, name: 1 }).lean();
    res.json(users.map((user) => ({ id: String(user._id), name: user.name, role: user.role || "admin" })));
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/tickets/:id { status?, note?, finalPrice?, assignedToId?, assignedTo? }
 * El tecnico puede mover el estado, dejar notas y tomar o soltar el ticket para
 * si mismo. Precio final y asignar a otra persona quedan para los admins.
 */
export async function updateTicket(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const ticket = await ServiceTicketModel.findById(req.params.id);
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });
    const by = actorName(req);
    const isAdmin = req.admin?.role === "admin";
    const { status, note, finalPrice, assignedTo, assignedToId } = req.body ?? {};
    if (status !== undefined) {
      if (!TICKET_STATUSES.includes(status)) return res.status(400).json({ error: "Estado no válido" });
      if (status !== ticket.status) {
        ticket.status = status;
        ticket.statusHistory.push({ status, by, at: new Date() });
      }
    }
    if (typeof note === "string" && note.trim()) ticket.notes.push({ text: note.trim().slice(0, 1000), by, at: new Date() });
    if (finalPrice !== undefined) {
      if (!isAdmin) return res.status(403).json({ error: "Solo un administrador puede cambiar el precio final" });
      const value = finalPrice === null || finalPrice === "" ? null : Number(finalPrice);
      if (value !== null && (!Number.isFinite(value) || value < 0)) return res.status(400).json({ error: "Precio no válido" });
      ticket.finalPrice = value;
    }

    if (assignedToId !== undefined) {
      const current = ticket.assignedToId ? String(ticket.assignedToId) : "";
      const target = assignedToId ? String(assignedToId) : "";
      if (!isAdmin && target !== req.admin?.id && !(target === "" && current === req.admin?.id)) {
        return res.status(403).json({ error: "Solo puedes tomar o soltar tus propios tickets" });
      }
      if (target !== current) {
        let name = "";
        if (target) {
          if (!Types.ObjectId.isValid(target)) return res.status(400).json({ error: "Técnico no válido" });
          const assignee = await UserModel.findOne({ _id: target, active: { $ne: false } }).select("name").lean();
          if (!assignee) return res.status(400).json({ error: "Ese técnico no existe o está desactivado" });
          name = assignee.name;
        }
        ticket.set("assignedToId", target || null);
        ticket.assignedTo = name;
        ticket.assignHistory.push({ to: name, by, at: new Date() });
      }
    } else if (typeof assignedTo === "string" && isAdmin) {
      // Compatibilidad: nombre en texto libre, sin acceso vinculado.
      const name = assignedTo.trim().slice(0, 120);
      if (name !== ticket.assignedTo) {
        ticket.assignedTo = name;
        ticket.set("assignedToId", null);
        ticket.assignHistory.push({ to: name, by, at: new Date() });
      }
    }
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
