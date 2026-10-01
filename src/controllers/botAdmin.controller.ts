import { NextFunction, Request, Response } from "express";
import { BotEventModel } from "../models/botEvent.model";
import { OrderModel } from "../models/order.model";
import { WhatsAppSessionModel } from "../models/whatsappSession.model";
import { phoneVariants } from "./whatsappBot.controller";

/**
 * Panel del bot (/admin/bot): conversaciones en vivo, la bitacora de cada paso
 * y metricas. Solo lectura, salvo reiniciar una conversacion.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rutas que significan "lo atiende una persona": el bot queda silenciado en BuilderBot. */
const HUMAN_ROUTES = ["human", "checkoutAdvisor"];
const HUMAN_WINDOW_MS = 60 * 60 * 1000;

const cartTotal = (cart: any[] = []) =>
  Math.round(cart.reduce((sum, line) => sum + (Number(line.price) || 0) * (Number(line.quantity) || 0), 0) * 100) / 100;

/** GET /api/bot/conversations?search= — conversaciones recientes, la mas activa primero. */
export async function listConversations(req: Request, res: Response, next: NextFunction) {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const filter = search
      ? {
          $or: [
            { phone: { $regex: search.replace(/[^\d+]/g, "") || "^$" } },
            { "state.customerName": { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
            { "state.orderNumber": { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
          ],
        }
      : {};
    const sessions: any[] = await WhatsAppSessionModel.find(filter, { phone: 1, state: 1, history: { $slice: -1 }, updatedAt: 1 })
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();

    // Ultimo paso de cada telefono en la bitacora (ruta y si hubo error).
    const lastEvents: any[] = await BotEventModel.aggregate([
      { $match: { phone: { $in: sessions.map((session) => session.phone) } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$phone", route: { $first: "$route" }, kind: { $first: "$kind" }, endpoint: { $first: "$endpoint" }, at: { $first: "$createdAt" } } },
    ]);
    const lastByPhone = new Map(lastEvents.map((event) => [event._id, event]));
    const humanSince = await BotEventModel.aggregate([
      { $match: { phone: { $in: sessions.map((session) => session.phone) }, kind: "turn", route: { $in: HUMAN_ROUTES }, createdAt: { $gte: new Date(Date.now() - HUMAN_WINDOW_MS) } } },
      { $group: { _id: "$phone", at: { $max: "$createdAt" } } },
    ]);
    const humanByPhone = new Map(humanSince.map((entry: any) => [entry._id, entry.at]));

    res.json(
      sessions.map((session) => {
        const state = session.state || {};
        const last = session.history?.[0];
        const event = lastByPhone.get(session.phone);
        return {
          phone: session.phone,
          customerName: state.customerName || "",
          stage: state.stage || "idle",
          paymentMethod: state.paymentMethod || null,
          orderNumber: state.orderNumber || "",
          cartCount: (state.cart || []).reduce((sum: number, line: any) => sum + (Number(line.quantity) || 0), 0),
          cartTotal: cartTotal(state.cart),
          lastMessage: last ? { role: last.role, content: last.content, hasMedia: Boolean(last.mediaUrl) } : null,
          lastRoute: event?.route || "",
          lastError: event?.kind === "error",
          withHuman: humanByPhone.has(session.phone),
          updatedAt: session.updatedAt,
        };
      }),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /api/bot/conversations/:phone — estado, chat, bitacora y pedidos de un telefono. */
export async function getConversation(req: Request, res: Response, next: NextFunction) {
  try {
    const phone = String(req.params.phone);
    const [session, events, orders]: any[] = await Promise.all([
      WhatsAppSessionModel.findOne({ phone }, { phone: 1, state: 1, history: 1, updatedAt: 1, createdAt: 1 }).lean(),
      BotEventModel.find({ phone }).sort({ createdAt: -1 }).limit(150).lean(),
      phoneVariants(phone).length
        ? OrderModel.find(
            { $or: [{ whatsappPhone: { $in: phoneVariants(phone) } }, { customerPhone: { $in: phoneVariants(phone) } }] },
            { orderNumber: 1, status: 1, source: 1, channel: 1, totalAmount: 1, "transfer.status": 1, createdAt: 1 },
          )
            .sort({ createdAt: -1 })
            .limit(10)
            .lean()
        : [],
    ]);
    if (!session && !events.length) return res.status(404).json({ error: "No hay conversación con ese número" });

    const state = session?.state || {};
    res.json({
      phone,
      state: {
        stage: state.stage || "idle",
        cart: state.cart || [],
        cartTotal: cartTotal(state.cart),
        options: state.options || [],
        customerName: state.customerName || "",
        customerEmail: state.customerEmail || "",
        address: state.address || "",
        paymentMethod: state.paymentMethod || null,
        orderNumber: state.orderNumber || "",
      },
      history: session?.history || [],
      events,
      orders,
      updatedAt: session?.updatedAt || events[0]?.createdAt || null,
      createdAt: session?.createdAt || null,
    });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/bot/conversations/:phone — reinicia la conversacion (carrito y paso). Los pedidos no se tocan. */
export async function resetConversation(req: Request, res: Response, next: NextFunction) {
  try {
    await WhatsAppSessionModel.deleteOne({ phone: String(req.params.phone) });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

/** GET /api/bot/events?limit=&before= — actividad reciente de todos los numeros. */
export async function listBotEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = Math.min(Number(req.query.limit) || 60, 200);
    const before = typeof req.query.before === "string" ? new Date(req.query.before) : null;
    const filter = before && !Number.isNaN(before.getTime()) ? { createdAt: { $lt: before } } : {};
    res.json(await BotEventModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean());
  } catch (error) {
    next(error);
  }
}

/** GET /api/bot/stats — metricas de las ultimas 24 horas. */
export async function getBotStats(_req: Request, res: Response, next: NextFunction) {
  try {
    const since = new Date(Date.now() - DAY_MS);
    const [phones, byRoute, errors, turns, orders] = await Promise.all([
      BotEventModel.distinct("phone", { createdAt: { $gte: since } }),
      BotEventModel.aggregate([
        { $match: { createdAt: { $gte: since }, kind: "decision" } },
        { $group: { _id: "$route", count: { $sum: 1 } } },
      ]),
      BotEventModel.countDocuments({ createdAt: { $gte: since }, kind: "error" }),
      BotEventModel.aggregate([
        { $match: { createdAt: { $gte: since }, kind: "turn", duplicated: false } },
        { $group: { _id: null, count: { $sum: 1 }, avgMs: { $avg: "$durationMs" }, human: { $sum: { $cond: [{ $in: ["$route", HUMAN_ROUTES] }, 1, 0] } } } },
      ]),
      OrderModel.aggregate([
        { $match: { channel: "whatsapp_bot", createdAt: { $gte: since } } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$totalAmount" } } },
      ]),
    ]);
    res.json({
      conversations: phones.length,
      messages: turns[0]?.count || 0,
      avgResponseMs: Math.round(turns[0]?.avgMs || 0),
      toHuman: turns[0]?.human || 0,
      errors,
      orders: orders[0]?.count || 0,
      ordersTotal: Math.round((orders[0]?.total || 0) * 100) / 100,
      routes: Object.fromEntries(byRoute.map((entry: any) => [entry._id || "conversation", entry.count])),
    });
  } catch (error) {
    next(error);
  }
}
