import crypto from "crypto";
import { Request, Response } from "express";
import { OrderModel } from "../models/order.model";
import { ProductModel } from "../models/product.model";
import { WhatsAppSessionModel } from "../models/whatsappSession.model";
import { notifyNewOrder } from "../services/email.service";
import { geminiEnabled } from "../services/gemini.service";
import { attachReceipt, bankDetails, describeImage, downloadReceipt, isAcceptedReceipt } from "../services/transfer.service";
import { BotProduct, catalogOverview } from "../services/whatsappBot/catalog";
import { aiExtract, heuristicExtract } from "../services/whatsappBot/extractor";
import {
  BotDeps,
  BotState,
  CreatedOrder,
  FALLBACK_MESSAGE,
  OrderSummary,
  ReceiptOutcome,
  TurnResult,
  createInitialState,
  decideRoute,
  handleTurn,
} from "../services/whatsappBot/router";

/**
 * BOT DE WHATSAPP (BuilderBot Cloud).
 *
 * Contrato igual al de Boloncity: todas las rutas responden HTTP 200 con
 * `{ success, intencion, route, message, step, decision, ... }`. BuilderBot
 * envia `{message}` al cliente y, si se quiere, enruta con Rules por
 * `intencion`. Ver docs/whatsapp-bot.md.
 */

const SUPPORT_PHONE = () => (process.env.BOT_SUPPORT_PHONE || "").trim();
const storeUrl = () => (process.env.PUBLIC_WEB_URL || "https://megaprinter.ec").replace(/\/$/, "");
const cardEnabled = () => Boolean(process.env.PAYPHONE_TOKEN && process.env.PAYPHONE_STORE_ID);

// ─── Lectura del body de BuilderBot ──────────────────────────────────────────

/** Una variable de BuilderBot que no se reemplazo llega literal: "{body}", "{from}". */
const PLACEHOLDER = /^\{\s*[\w.\-]+\s*\}$/;

function clean(value: unknown) {
  if (value == null || typeof value === "object") return "";
  const text = String(value).trim();
  return PLACEHOLDER.test(text) ? "" : text;
}

/**
 * Telefono E.164 de Ecuador ("+593991234567"). WhatsApp puede mandar el JID
 * completo ("593991234567:12@s.whatsapp.net"). Un "…@lid" es un id de
 * privacidad, no un telefono: se usa como sesion ("lid:<digitos>").
 */
export function toE164(value: unknown) {
  const text = clean(value);
  if (!text) return "";
  if (/@lid\b/i.test(text) || /^lid:\d+$/.test(text)) {
    const lid = text.replace(/^lid:/, "").replace(/[:@].*$/, "").replace(/\D/g, "");
    return lid ? `lid:${lid}` : "";
  }
  const digits = text.replace(/[:@].*$/, "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("593")) return `+${digits}`;
  if (/^0\d{9}$/.test(digits)) return `+593${digits.slice(1)}`;
  if (/^9\d{8}$/.test(digits)) return `+593${digits}`;
  return `+${digits}`;
}

const isLid = (phone: string) => phone.startsWith("lid:");

/** Formatos en que pudo quedar guardado el telefono (la web lo guarda como lo escribe el cliente). */
export function phoneVariants(phone: string) {
  if (!phone || isLid(phone)) return [];
  const digits = phone.replace(/\D/g, "");
  if (!digits.startsWith("593")) return [phone, digits];
  const local = digits.slice(3);
  return [phone, digits, `0${local}`, local, `+593 ${local}`, `+593 0${local}`];
}

/** Fuera de produccion, BOT_TEST_PHONE reemplaza el telefono (pruebas por Telegram o Postman). */
function readPhone(body: any) {
  const testPhone = process.env.VERCEL_ENV !== "production" ? toE164(process.env.BOT_TEST_PHONE) : "";
  return testPhone || toE164(clean(body?.phone) || clean(body?.from) || clean(body?.telefono));
}

const ASSISTANT_ROLES = /^(assistant|model|bot|system|asistente|ia|ai)$/i;
const ROLE_LINE = /^\s*(user|usuario|cliente|human|humano|customer|assistant|asistente|model|bot|system|ia|ai)\s*:\s*(.*)$/i;

function historyContent(value: any): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(historyContent).filter(Boolean).join("\n").trim();
  for (const key of ["text", "content", "message", "body", "value"]) {
    if (typeof value?.[key] === "string") return value[key].trim();
  }
  return "";
}

/**
 * Ultimo mensaje del CLIENTE dentro de `{history}` (flow que solo manda el
 * historial). Acepta arreglo de `{role, content}`, ese arreglo como JSON o
 * texto con lineas "user: …" / "assistant: …".
 */
export function latestUserMessage(history: unknown): string {
  if (history == null) return "";
  let value: any = history;
  if (typeof value === "string") {
    const text = clean(value);
    if (!text) return "";
    try {
      value = JSON.parse(text);
    } catch {
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (!lines.some((line) => ROLE_LINE.test(line))) return lines.length === 1 ? lines[0] : "";
      let last = "";
      let current: { assistant: boolean; parts: string[] } | null = null;
      for (const line of lines) {
        const match = line.match(ROLE_LINE);
        if (match) {
          if (current && !current.assistant) last = current.parts.join("\n");
          current = { assistant: ASSISTANT_ROLES.test(match[1]), parts: [match[2]] };
        } else if (current) current.parts.push(line);
      }
      if (current && !current.assistant) last = current.parts.join("\n");
      return last.trim();
    }
  }
  const items = Array.isArray(value)
    ? value
    : (["messages", "history", "conversation", "data"].map((key) => value?.[key]).find(Array.isArray) as any[]) || [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (ASSISTANT_ROLES.test(String(item?.role ?? item?.sender ?? item?.type ?? "user"))) continue;
    const content = historyContent(item?.content ?? item?.parts ?? item?.text ?? item?.body ?? item);
    if (content) return content;
  }
  return "";
}

/** Ultimos turnos del {history} de BuilderBot como texto "Cliente: … / Bot: …" (vacio si no llega). */
export function builderBotHistory(value: unknown, maxEntries = 12): string {
  let data: any = value;
  if (typeof data === "string") {
    const text = clean(data);
    if (!text) return "";
    try {
      data = JSON.parse(text);
    } catch {
      return text.split(/\r?\n/).filter((line) => line.trim()).slice(-maxEntries).join("\n").slice(-3000);
    }
  }
  const items = Array.isArray(data)
    ? data
    : (["messages", "history", "conversation", "data"].map((key) => data?.[key]).find(Array.isArray) as any[]) || [];
  return items
    .slice(-maxEntries)
    .map((item: any) => {
      const content = historyContent(item?.content ?? item?.parts ?? item?.text ?? item?.body ?? item);
      if (!content) return "";
      const assistant = ASSISTANT_ROLES.test(String(item?.role ?? item?.sender ?? item?.type ?? "user"));
      return `${assistant ? "Bot" : "Cliente"}: ${content.slice(0, 400)}`;
    })
    .filter(Boolean)
    .join("\n")
    .slice(-3000);
}

function rawText(body: any) {
  return [body?.rawMessage, body?.rawMess, body?.body, body?.message, body?.mensaje].map(clean).find(Boolean) || latestUserMessage(body?.history);
}

/** BuilderBot manda los eventos sin texto como "_event_media__<uuid>", "_event_document__…". */
const EVENT = /^_event_(\w*?)__/i;

function readMessage(body: any) {
  const text = rawText(body);
  return EVENT.test(text) ? "" : text.slice(0, 1500);
}

/** URL del archivo (comprobante). BuilderBot la expone como {urlTempFile}; se aceptan otros nombres. */
export function readMediaUrl(body: any) {
  const keys = ["urlTempFile", "tempFile", "fileUrl", "mediaUrl", "imageUrl", "url"];
  const candidates = [...keys.map((key) => body?.[key]), ...keys.map((key) => body?.data?.[key])];
  return candidates.map(clean).find((value) => /^https?:\/\//i.test(value)) || "";
}

const hasMediaEvent = (body: any) => /media|image|document|file|imagen/i.test(rawText(body).match(EVENT)?.[1] || "");

// ─── Dependencias reales del router ──────────────────────────────────────────

let catalogCache: { at: number; products: BotProduct[] } | null = null;

export async function loadCatalog(): Promise<BotProduct[]> {
  if (catalogCache && Date.now() - catalogCache.at < 60_000) return catalogCache.products;
  const docs = await ProductModel.find({ active: true }).populate("category", "name").sort({ category: 1, price: 1 }).lean();
  const products: BotProduct[] = docs.map((doc: any) => ({
    id: String(doc._id),
    name: doc.name,
    price: doc.price,
    originalPrice: doc.originalPrice ?? null,
    category: doc.category?.name || (doc.kind === "service" ? "Servicio técnico" : "Otros"),
    kind: doc.kind,
    description: doc.description || "",
    specs: (doc.specifications || []).map((spec: any) => `${spec.label}: ${spec.value}`).join("; "),
  }));
  catalogCache = { at: Date.now(), products };
  return products;
}

const sourceFor = (method: BotState["paymentMethod"]) => (method === "card" ? "payphone" : method === "transfer" ? "transfer" : "whatsapp");

async function createBotOrder(phone: string, state: BotState): Promise<CreatedOrder> {
  // Precios vigentes de Mongo: el carrito solo aporta ids y cantidades.
  const products = await ProductModel.find({ _id: { $in: state.cart.map((line) => line.productId) }, active: true }).lean();
  const byId = new Map(products.map((product: any) => [String(product._id), product]));
  const items = state.cart
    .filter((line) => byId.has(line.productId))
    .map((line) => ({ name: byId.get(line.productId)!.name, price: byId.get(line.productId)!.price, quantity: line.quantity }));
  if (!items.length) throw new Error("Ningun producto del carrito sigue activo");

  const totalAmount = Math.round(items.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100) / 100;
  const source = sourceFor(state.paymentMethod);
  const order = await OrderModel.create({
    customerName: state.customerName,
    customerEmail: state.customerEmail,
    customerPhone: isLid(phone) ? "WhatsApp (número oculto)" : phone,
    address: state.address,
    items,
    totalAmount,
    source,
    channel: "whatsapp_bot",
    whatsappPhone: isLid(phone) ? "" : phone,
    status: source === "whatsapp" ? "whatsapp" : "pending",
    ...(source === "transfer" ? { transfer: { status: "awaiting_receipt" } } : {}),
  });

  void notifyNewOrder(order, "WhatsApp (bot)");

  return {
    orderId: String(order._id),
    orderNumber: order.orderNumber || String(order._id),
    total: totalAmount,
    paymentLink: source === "payphone" ? `${storeUrl()}/pagar/${order.paymentToken}` : "",
  };
}

/** Pedido por transferencia que espera comprobante: el de la conversacion o el ultimo del telefono. */
async function transferOrderFor(phone: string, orderId: string) {
  const open = { source: "transfer", status: "pending", "transfer.status": { $in: ["awaiting_receipt", "rejected", "in_review"] } };
  if (orderId) {
    const order = await OrderModel.findOne({ _id: orderId, ...open });
    if (order) return order;
  }
  const variants = phoneVariants(phone);
  if (!variants.length) return null;
  return OrderModel.findOne({ ...open, $or: [{ whatsappPhone: { $in: variants } }, { customerPhone: { $in: variants } }] }).sort({ createdAt: -1 });
}

async function receiveReceipt(phone: string, orderId: string, mediaUrl: string): Promise<ReceiptOutcome> {
  try {
    const file = await downloadReceipt(mediaUrl);
    if (!isAcceptedReceipt(file.mimeType)) return { status: "unsupported" };
    const order = await transferOrderFor(phone, orderId);
    // Sin pedido por transferencia pendiente, la IA mira que es: un comprobante
    // suelto, la foto de un producto ("¿tienen esta?") u otra cosa.
    if (!order) return { status: "no_order", image: (await describeImage(file)) || undefined };
    const { analysis } = await attachReceipt(order, file, "whatsapp");
    return {
      status: "stored",
      orderNumber: order.orderNumber || String(order._id),
      total: order.totalAmount,
      detectedAmount: analysis?.detectedAmount ?? null,
      amountMatches: analysis?.amountMatches ?? null,
      isReceipt: analysis?.isReceipt ?? null,
    };
  } catch (error) {
    console.error("[whatsapp-bot] no se pudo guardar el comprobante:", error instanceof Error ? error.message : error);
    return { status: "error" };
  }
}

async function findOrders(phone: string, orderNumber?: string): Promise<OrderSummary[]> {
  const filter = orderNumber
    ? { orderNumber }
    : phoneVariants(phone).length
      ? { $or: [{ whatsappPhone: { $in: phoneVariants(phone) } }, { customerPhone: { $in: phoneVariants(phone) } }] }
      : null;
  if (!filter) return [];
  const orders = await OrderModel.find(filter).sort({ createdAt: -1 }).limit(5).lean();
  return orders.map((order: any) => ({
    id: String(order._id),
    orderNumber: order.orderNumber || String(order._id).slice(-6).toUpperCase(),
    status: order.status,
    source: order.source,
    total: order.totalAmount,
    transferStatus: order.transfer?.status || "",
    paymentLink: order.source === "payphone" && order.status === "pending" && order.paymentToken ? `${storeUrl()}/pagar/${order.paymentToken}` : "",
    createdAt: order.createdAt,
  }));
}

async function buildDeps(phone: string): Promise<BotDeps> {
  return {
    loadCatalog,
    extract: geminiEnabled() ? aiExtract : heuristicExtract,
    createOrder: (state) => createBotOrder(phone, state),
    receiveReceipt: (orderId, mediaUrl) => receiveReceipt(phone, orderId, mediaUrl),
    findOrders: (orderNumber) => findOrders(phone, orderNumber),
    bank: await bankDetails(),
    cardEnabled: cardEnabled(),
    supportPhone: SUPPORT_PHONE(),
    storeUrl: storeUrl(),
  };
}

// ─── Turno con candado y reintentos ──────────────────────────────────────────

const TURN_LOCK_MS = 45_000;
const TURN_WAIT_MS = 25_000;
const RETRY_WINDOW_MS = 5_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Toma el candado del telefono (y crea la sesion si no existe) de forma atomica. */
async function acquireTurnLock(phone: string): Promise<any | null> {
  const deadline = Date.now() + TURN_WAIT_MS;
  for (;;) {
    const now = new Date();
    try {
      const session = await WhatsAppSessionModel.findOneAndUpdate(
        { phone, $or: [{ turnLockUntil: null }, { turnLockUntil: { $lt: now } }] },
        { $set: { turnLockUntil: new Date(now.getTime() + TURN_LOCK_MS) } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
      if (session) return session;
    } catch (error: any) {
      // E11000: la sesion existe con el candado tomado (el upsert intento crear otra).
      if (error?.code !== 11000) throw error;
    }
    if (Date.now() > deadline) return null;
    await sleep(250);
  }
}

const turnHash = (message: string, mediaUrl: string) => crypto.createHash("sha1").update(`${message}|${mediaUrl}`).digest("hex");

const isResetKeyword = (message: string) => message.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "") === "reiniciatodo";

type TurnOutcome = TurnResult & { duplicated?: boolean };

async function runTurn(body: any): Promise<TurnOutcome | null> {
  const phone = readPhone(body);
  if (!phone) {
    console.warn("[whatsapp-bot] mensaje sin telefono valido. Revisa que el nodo HTTP mande phone = {from}", JSON.stringify(body).slice(0, 300));
    return null;
  }
  const arrivedAt = Date.now();
  const message = readMessage(body);
  const mediaUrl = readMediaUrl(body);

  if (isResetKeyword(message)) {
    await WhatsAppSessionModel.replaceOne({ phone }, { phone, history: [], state: null }, { upsert: true });
    const state = createInitialState();
    return { state, reply: "Listo, reinicié la conversación 🔄 ¿Qué estás buscando?", route: "conversation", intent: "conversar", step: "idle", decision: "R0:reinicio" };
  }

  const session = await acquireTurnLock(phone);
  if (!session) {
    const state = createInitialState();
    return { state, reply: "Estoy terminando de procesar tu mensaje anterior. Dame unos segundos 🙏", route: "conversation", intent: "conversar", step: state.stage, decision: "R0:ocupado" };
  }

  let released = false;
  try {
    // BuilderBot reintenta si la respuesta tarda: el mismo mensaje dentro de 5 s
    // (o mientras se procesaba) recibe la misma respuesta y no crea otra orden.
    const hash = turnHash(message, mediaUrl);
    const lastAt = session.lastMessageAt ? new Date(session.lastMessageAt).getTime() : 0;
    if (session.lastResponse && session.lastMessageHash === hash && (arrivedAt <= lastAt || arrivedAt - lastAt < RETRY_WINDOW_MS)) {
      await WhatsAppSessionModel.updateOne({ phone }, { $set: { turnLockUntil: null } });
      released = true;
      return { ...(session.lastResponse as TurnResult), decision: "R0:duplicado", duplicated: true };
    }

    const previous = { ...createInitialState(), ...(session.state || {}) } as BotState;
    const history = [...(session.history || [])];
    // Contexto para la IA: el {history} de BuilderBot si llega (incluye lo que
    // escribio un asesor a mano); si no, el historial guardado por telefono.
    const recent =
      builderBotHistory(body?.history) ||
      history
        .slice(-8)
        .map((entry: any) => `${entry.role === "user" ? "Cliente" : "Bot"}: ${String(entry.content).slice(0, 400)}`)
        .join("\n");

    const result = await handleTurn(
      previous,
      { message, mediaUrl: mediaUrl || undefined, mediaWithoutUrl: !mediaUrl && hasMediaEvent(body), history: recent },
      await buildDeps(phone),
    );

    const userEntry = message || (mediaUrl ? "[archivo adjunto]" : "");
    if (userEntry) history.push({ role: "user", content: userEntry.slice(0, 2000), createdAt: new Date() });
    history.push({ role: "assistant", content: result.reply.slice(0, 2000), createdAt: new Date() });

    await WhatsAppSessionModel.updateOne(
      { phone },
      {
        $set: {
          state: JSON.parse(JSON.stringify(result.state)),
          history: history.slice(-30),
          lastMessageHash: hash,
          lastMessageAt: new Date(),
          lastResponse: JSON.parse(JSON.stringify(result)),
          turnLockUntil: null,
        },
      },
    );
    released = true;
    console.log(`[whatsapp-bot] ${phone} ${result.decision} → paso ${result.step}`);
    return result;
  } finally {
    if (!released) await WhatsAppSessionModel.updateOne({ phone }, { $set: { turnLockUntil: null } }).catch(() => {});
  }
}

// ─── Respuestas ──────────────────────────────────────────────────────────────

const NO_PHONE_MESSAGE = "No logré leer tu número de WhatsApp 🙏 Escríbenos de nuevo en un momento.";
const ERROR_MESSAGE = "Dame un segundito 🙏 Se me cruzaron los cables con ese mensaje, ¿me lo repites?";

export const BOT_FALLBACK = {
  success: false,
  intencion: "conversar",
  route: "conversation",
  message: "Tuve un problema procesando tu mensaje. ¿Me lo repites?",
  missingData: [],
};

function toBotResponse(result: TurnResult | null) {
  if (!result) return { ...BOT_FALLBACK, message: NO_PHONE_MESSAGE, readyToCheckout: false };
  return {
    success: true,
    // Para las Rules de BuilderBot: conversar | menu | dudas | consultar_pedido | orden_creada | comprobante_recibido.
    intencion: result.intent,
    telefonoSoporte: SUPPORT_PHONE(),
    route: result.route,
    // Nunca vacio: BuilderBot mandaria un mensaje en blanco.
    message: result.reply || FALLBACK_MESSAGE,
    step: result.step,
    decision: result.decision,
    readyToCheckout: result.step === "confirm",
    orderNumber: result.orderNumber || "",
    paymentMethod: result.paymentMethod || result.state.paymentMethod || "",
    paymentLink: result.paymentLink || "",
    total: result.total ?? null,
    cart: result.state.cart.map((line) => ({ productId: line.productId, name: line.name, quantity: line.quantity, price: line.price })),
    missingData: [],
  };
}

const input = (req: Request) => ({ ...(req.query || {}), ...(req.body || {}) });

/**
 * POST /whatsapp-bot/brain — FLUJO PRINCIPAL. Solo DECIDE a que flujo va el
 * mensaje (`route`); no responde al cliente ni toca el pedido. En BuilderBot:
 * "Enviar al cliente" APAGADO y una Rule por cada `route`.
 */
export async function whatsappBotDecide(req: Request, res: Response) {
  try {
    const body = input(req);
    const phone = readPhone(body);
    const message = readMessage(body);
    const mediaUrl = readMediaUrl(body);
    if (!phone) return res.json({ success: false, route: "conversation", decision: "sin telefono", message: "" });
    if (isResetKeyword(message)) return res.json({ success: true, route: "conversation", decision: "reinicio", message: "" });

    const session: any = await WhatsAppSessionModel.findOne({ phone }, { state: 1 }).lean();
    const { route, reason } = decideRoute(session?.state, { message, mediaUrl }, {
      bank: Boolean(await bankDetails()),
      cardEnabled: cardEnabled(),
    });
    console.log(`[whatsapp-bot] ${phone} decide → ${route} (${reason})`);
    res.json({ success: true, route, decision: reason, step: session?.state?.stage || "idle", message: "" });
  } catch (error) {
    console.error("[whatsapp-bot] error en brain:", error);
    // Ante cualquier falla, a conversacion: ese flujo siempre responde algo.
    res.json({ success: false, route: "conversation", decision: "error", message: "" });
  }
}

/**
 * Endpoints de los flujos destino (/conversation, /checkout, /catalog,
 * /search-order, /human). Todos procesan el mensaje completo y responden en
 * `message`: el turno es la unica fuente de verdad, la ruta solo elige la puerta.
 */
export async function whatsappBotTurn(req: Request, res: Response) {
  try {
    res.json(toBotResponse(await runTurn(input(req))));
  } catch (error) {
    console.error("[whatsapp-bot] error en el turno:", error);
    res.json({ ...BOT_FALLBACK, message: ERROR_MESSAGE });
  }
}

/** POST /whatsapp-bot/transfer-receipt: foto o PDF del comprobante (flujo de imagen/documento). */
export async function whatsappBotTransferReceipt(req: Request, res: Response) {
  const body = input(req);
  // Sin archivo pero con texto ("¿cuanto era?"): se atiende como conversacion normal.
  if (!readMediaUrl(body) && !readMessage(body)) {
    return res.json({ ...BOT_FALLBACK, success: false, message: "No logré abrir tu archivo 😕 ¿Me reenvías la foto del comprobante?" });
  }
  return whatsappBotTurn(req, res);
}

/** GET|POST /whatsapp-bot/catalog: con mensaje corre el turno; sin mensaje, solo el resumen. */
export async function whatsappBotCatalog(req: Request, res: Response) {
  try {
    const body = input(req);
    if (readMessage(body) && readPhone(body)) return whatsappBotTurn(req, res);
    res.json({ success: true, intencion: "menu", route: "catalog", message: catalogOverview(await loadCatalog(), storeUrl()), missingData: [] });
  } catch (error) {
    console.error("[whatsapp-bot] error en catalog:", error);
    res.json({ ...BOT_FALLBACK, message: ERROR_MESSAGE });
  }
}
