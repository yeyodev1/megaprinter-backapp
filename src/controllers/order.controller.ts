import { Request, Response, NextFunction } from "express";
import { PAYPHONE_APPROVED, applyPayphoneResult, confirmPayphoneTransaction } from "../services/payphone.service";
import { ORDER_SOURCES, ORDER_STATUSES, OrderModel, OrderSource, OrderStatus } from "../models/order.model";
import { AdminRequest } from "../middlewares/admin.middleware";
import { notifyOrderCreated, notifyStatusChange, notifyTransferRejected, recordStatus } from "../services/orderNotifications.service";
import cloudinary from "../config/cloudinary";
import { UploadApiResponse } from "cloudinary";
import { activeBankAccounts, allBankAccounts, attachReceipt, isAcceptedReceipt, transferEnabled } from "../services/transfer.service";


interface IncomingItem {
  name: string;
  price: number;
  quantity: number;
}

/** Redondeo a centavos: sumar flotantes deja totales tipo 1289.9999999998. */
const toCents = (value: number) => Math.round(value * 100) / 100;

/**
 * Normaliza y valida las lineas del pedido. El total NO se toma del cliente:
 * antes se guardaba `totalAmount` tal cual llegaba en el body, asi que un
 * pedido de $1000 podia registrarse (y cobrarse) por $1.
 */
function parseItems(raw: unknown): IncomingItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const items: IncomingItem[] = [];

  for (const entry of raw) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    const price = Number(entry?.price);
    const quantity = Math.floor(Number(entry?.quantity));

    if (!name || !Number.isFinite(price) || price < 0) return null;
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 99) return null;

    items.push({ name, price, quantity });
  }

  return items;
}

const computeTotal = (items: IncomingItem[]) =>
  toCents(items.reduce((sum, item) => sum + item.price * item.quantity, 0));

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export function getPayphoneConfig(_req: Request, res: Response) {
  const token = process.env.PAYPHONE_TOKEN;
  const storeId = process.env.PAYPHONE_STORE_ID;

  if (!token || !storeId) {
    return res.status(503).json({ error: "Payphone no está configurado" });
  }

  // El SDK de navegador de Payphone necesita estas dos credenciales para
  // renderizar su caja de pago.
  return res.json({ token, storeId });
}

export async function confirmPayphonePayment(req: Request, res: Response, next: NextFunction) {
  const { id, clientTransactionId } = req.body ?? {};

  if (!id || !clientTransactionId) {
    return res.status(400).json({ error: "Faltan datos de confirmación de Payphone" });
  }
  if (!process.env.PAYPHONE_TOKEN) {
    return res.status(503).json({ error: "Payphone no está configurado" });
  }

  try {
    // Tambien por intentos anteriores: el cliente pudo pagar en un link viejo.
    const order = await OrderModel.findOne({ $or: [{ clientTransactionId }, { clientTransactionIds: clientTransactionId }] });
    if (!order) {
      return res.status(404).json({ error: "No encontramos el pedido de esa transacción" });
    }

    // Idempotencia: Payphone puede reintentar el retorno, el cliente recargar la
    // pagina o el bot haber confirmado antes cuando escribio "pagado".
    if (["paid", "processing", "shipped", "delivered"].includes(order.status)) {
      return res.json({
        statusCode: PAYPHONE_APPROVED,
        transactionStatus: "Approved",
        message: "El pago ya estaba confirmado",
        orderNumber: order.orderNumber,
        channel: order.channel,
        token: order.paymentToken,
      });
    }

    const data = await confirmPayphoneTransaction(Number(id), clientTransactionId);
    const result = await applyPayphoneResult(order, data, clientTransactionId);
    if (result === "mismatch") {
      return res.status(409).json({
        error: "El monto confirmado no coincide con el pedido. Contáctanos para revisarlo.",
      });
    }

    // La pagina de confirmacion muestra el pedido y el boton para volver a WhatsApp.
    return res.json({ ...data, orderNumber: order.orderNumber, channel: order.channel, token: order.paymentToken });
  } catch (error) {
    next(error);
  }
}

export async function createOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      customerName,
      customerEmail,
      customerPhone,
      address,
      source,
      clientTransactionId,
    } = req.body ?? {};

    const items = parseItems(req.body?.items);

    if (!customerName || !customerEmail || !customerPhone || !items) {
      return res.status(400).json({ error: "Faltan datos obligatorios del pedido" });
    }
    if (!isEmail(String(customerEmail))) {
      return res.status(400).json({ error: "El correo electrónico no es válido" });
    }
    if (!ORDER_SOURCES.includes(source)) {
      return res.status(400).json({ error: "Origen de pedido no válido" });
    }
    if (source === "transfer" && !(await transferEnabled())) {
      return res.status(400).json({ error: "El pago por transferencia no está disponible" });
    }

    const totalAmount = computeTotal(items);
    const paymentSource = source as OrderSource;

    const order = await OrderModel.create({
      customerName: String(customerName).trim(),
      customerEmail: String(customerEmail).trim().toLowerCase(),
      customerPhone: String(customerPhone).trim(),
      address: address ? String(address).trim() : "",
      items,
      totalAmount,
      source: paymentSource,
      channel: "web",
      clientTransactionId: clientTransactionId || "",
      status: paymentSource === "whatsapp" ? "whatsapp" : "pending",
      ...(paymentSource === "transfer" ? { transfer: { status: "awaiting_receipt" } } : {}),
    });

    const whatsappNumber = process.env.WHATSAPP_NUMBER || "593998028318";

    // La notificacion por correo no debe bloquear la respuesta: si Resend esta
    // caido el cliente igual necesita su enlace de WhatsApp.
    notifyOrderCreated(order, "Tienda web");

    const itemsText = items.map((item) => `${item.name} (x${item.quantity})`).join(", ");
    const waText = encodeURIComponent(
      `Hola Megaprinter! Soy ${order.customerName}. Deseo confirmar mi pedido ${order.orderNumber}:\n` +
        `- Productos: ${itemsText}\n` +
        `- Total: $${totalAmount.toFixed(2)}\n` +
        `- Dirección: ${order.address || "Guayaquil"}\n` +
        `- Correo: ${order.customerEmail}`,
    );

    return res.status(201).json({
      success: true,
      message: "Pedido procesado con éxito",
      orderId: order.id,
      orderNumber: order.orderNumber,
      // Enlace privado de pago (/pagar/:token) para transferencias y Payphone.
      paymentToken: order.paymentToken,
      totalAmount,
      whatsappLink: `https://wa.me/${whatsappNumber}?text=${waText}`,
    });
  } catch (error) {
    next(error);
  }
}

export async function listOrders(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const skip = Math.max(Number(req.query.skip) || 0, 0);

    res.json(await OrderModel.find().sort({ createdAt: -1 }).skip(skip).limit(limit));
  } catch (error) {
    next(error);
  }
}

export async function updateOrderStatus(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const status = req.body?.status as OrderStatus;
    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Estado de pedido no válido" });
    }

    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Pedido no encontrado" });
    if (order.status === status) return res.json(order);

    order.status = status;
    recordStatus(order, status, req.admin?.email || "");
    await order.save();
    // Cada etapa le llega al cliente por correo; "pagado" tambien avisa al equipo.
    notifyStatusChange(order, status, req.admin?.email || "");

    res.json(order);
  } catch (error) {
    next(error);
  }
}

/**
 * Guia de envio (multipart: carrier, trackingNumber, guide = archivo opcional).
 * Guardarla pasa el pedido a "Enviado" y le manda la guia al cliente.
 */
export async function updateShipping(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Pedido no encontrado" });
    const carrier = typeof req.body?.carrier === "string" ? req.body.carrier.trim().slice(0, 80) : "";
    const trackingNumber = typeof req.body?.trackingNumber === "string" ? req.body.trackingNumber.trim().slice(0, 80) : "";
    if (!carrier && !trackingNumber && !req.file) {
      return res.status(400).json({ error: "Escribe el transportista o el número de guía, o sube el archivo de la guía" });
    }

    let guideUrl = order.shipping?.guideUrl || "";
    if (req.file) {
      const file = req.file;
      const upload = await new Promise<UploadApiResponse>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "megaprinter/guides", public_id: `${order.orderNumber || order.id}-${Date.now()}`, resource_type: file.mimetype === "application/pdf" ? "raw" : "image" },
          (error, result) => (error || !result ? reject(error || new Error("Cloudinary upload failed")) : resolve(result)),
        );
        stream.end(file.buffer);
      });
      guideUrl = upload.secure_url;
    }

    order.set("shipping", {
      carrier: carrier || order.shipping?.carrier || "",
      trackingNumber: trackingNumber || order.shipping?.trackingNumber || "",
      guideUrl,
      shippedAt: order.shipping?.shippedAt || new Date(),
    });
    const moved = order.status !== "shipped" && order.status !== "delivered";
    if (moved) {
      order.status = "shipped";
      recordStatus(order, "shipped", req.admin?.email || "");
    }
    await order.save();
    // Con la guia nueva o actualizada, el cliente recibe el correo de "va en camino".
    notifyStatusChange(order, "shipped", req.admin?.email || "");
    res.json(order);
  } catch (error) {
    next(error);
  }
}

// ─── Seguimiento publico (/pedido) ────────────────────────────────────────────

/** Lo que el cliente ve de su pedido: sin correo, telefono ni direccion. */
function trackingView(order: any) {
  return {
    orderNumber: order.orderNumber || String(order._id).slice(-6).toUpperCase(),
    token: order.paymentToken,
    customerName: String(order.customerName || "").split(/\s+/)[0],
    createdAt: order.createdAt,
    items: (order.items || []).map((item: any) => ({ name: item.name, price: item.price, quantity: item.quantity })),
    totalAmount: order.totalAmount,
    status: order.status,
    source: order.source,
    channel: order.channel || "web",
    transferStatus: order.transfer?.status || null,
    statusHistory: (order.statusHistory || []).map((entry: any) => ({ status: entry.status, at: entry.at })),
    shipping: order.shipping?.carrier || order.shipping?.trackingNumber || order.shipping?.guideUrl ? order.shipping : null,
  };
}

const lookups = new Map<string, number[]>();
/** Limite simple: 20 busquedas por minuto por IP (evita recorrer pedidos ajenos). */
function tooManyLookups(ip: string) {
  const now = Date.now();
  const recent = (lookups.get(ip) || []).filter((at) => now - at < 60_000);
  recent.push(now);
  lookups.set(ip, recent);
  return recent.length > 20;
}

/** GET /api/orders/track?q=MP-00012 | correo@cliente.com */
export async function trackOrders(req: Request, res: Response, next: NextFunction) {
  try {
    if (tooManyLookups(String(req.ip || req.headers["x-forwarded-for"] || "anon"))) {
      return res.status(429).json({ error: "Demasiadas búsquedas. Intenta en un minuto." });
    }
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const codeMatch = query.match(/^(?:mp)?-?\s*(\d{1,6})$/i);
    let orders: any[] = [];
    if (codeMatch) {
      orders = await OrderModel.find({ orderNumber: `MP-${codeMatch[1].padStart(5, "0")}` }).lean();
    } else if (isEmail(query)) {
      orders = await OrderModel.find({ customerEmail: query.toLowerCase() }).sort({ createdAt: -1 }).limit(10).lean();
    } else {
      return res.status(400).json({ error: "Escribe tu código de pedido (MP-00012) o el correo con el que compraste" });
    }
    res.json(orders.map(trackingView));
  } catch (error) {
    next(error);
  }
}

/** GET /api/orders/track/:token — detalle desde el enlace del correo. */
export async function trackOrderByToken(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await findByToken(req.params.token);
    if (!order) return res.status(404).json({ error: "No encontramos este pedido" });
    res.json(trackingView(order));
  } catch (error) {
    next(error);
  }
}

// ─── Enlace de pago (/pagar/:token) ──────────────────────────────────────────

const findByToken = (token: unknown) =>
  typeof token === "string" && token.length >= 16 ? OrderModel.findOne({ paymentToken: token }) : null;

/** Datos publicos del pedido para la pagina de pago (sin correo ni telefono). */
async function publicOrder(order: any) {
  const receipts = order.transfer?.receipts || [];
  return {
    orderNumber: order.orderNumber || String(order._id),
    customerName: order.customerName,
    items: order.items.map((item: any) => ({ name: item.name, price: item.price, quantity: item.quantity })),
    totalAmount: order.totalAmount,
    status: order.status,
    source: order.source,
    createdAt: order.createdAt,
    transfer:
      order.source === "transfer"
        ? {
            status: order.transfer?.status || "awaiting_receipt",
            receiptsCount: receipts.length,
            lastReceiptAt: receipts.at(-1)?.receivedAt || null,
            note: order.transfer?.status === "rejected" ? order.transfer?.note || "" : "",
          }
        : null,
    // Cuenta elegida; si aun no eligio banco, las cuentas activas para que elija.
    bank: order.source === "transfer" && order.transfer?.account?.accountNumber ? order.transfer.account : null,
    banks: order.source === "transfer" && !order.transfer?.account?.accountNumber ? await accountsForExistingOrder() : [],
  };
}

/** Un pedido ya creado puede pagarse aunque luego se apaguen las transferencias. */
async function accountsForExistingOrder() {
  const active = await activeBankAccounts();
  return active.length ? active : allBankAccounts();
}

export async function getTransferConfig(_req: Request, res: Response, next: NextFunction) {
  try {
    const accounts = await activeBankAccounts();
    res.json({ enabled: accounts.length > 0, accounts });
  } catch (error) {
    next(error);
  }
}

export async function getPaymentOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await findByToken(req.params.token);
    if (!order) return res.status(404).json({ error: "No encontramos este pedido" });
    res.json(await publicOrder(order));
  } catch (error) {
    next(error);
  }
}

/**
 * Nuevo intento de pago con tarjeta para un pedido ya creado (enlace del bot).
 * Cada intento usa un clientTransactionId nuevo: Payphone no acepta repetirlo
 * y /pay-response confirma el pedido con ese id.
 */
export async function createPaymentIntent(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await findByToken(req.params.token);
    if (!order) return res.status(404).json({ error: "No encontramos este pedido" });
    if (order.source !== "payphone") return res.status(409).json({ error: "Este pedido no se paga con tarjeta" });
    if (["paid", "processing", "shipped", "delivered"].includes(order.status)) {
      return res.status(409).json({ error: "Este pedido ya está pagado" });
    }

    if (order.clientTransactionId) {
      order.clientTransactionIds = [...(order.clientTransactionIds || []), order.clientTransactionId].slice(-20);
    }
    order.clientTransactionId = `MEGA-${Date.now()}`;
    // Un intento rechazado deja el pedido cancelado; reintentar lo reabre.
    if (order.status === "cancelled") order.status = "pending";
    await order.save();

    res.json({
      clientTransactionId: order.clientTransactionId,
      amount: order.totalAmount,
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone,
    });
  } catch (error) {
    next(error);
  }
}

/** El cliente elige a que banco transferir desde su enlace de pago. */
export async function choosePaymentBank(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await findByToken(req.params.token);
    if (!order) return res.status(404).json({ error: "No encontramos este pedido" });
    if (order.source !== "transfer") return res.status(409).json({ error: "Este pedido no se paga por transferencia" });
    if (order.status !== "pending") return res.status(409).json({ error: "Este pedido ya no espera pago" });
    const account = (await accountsForExistingOrder()).find((item) => item.id === String(req.body?.accountId || ""));
    if (!account) return res.status(400).json({ error: "Elige uno de los bancos disponibles" });
    order.set("transfer.account", account);
    await order.save();
    res.json(await publicOrder(order));
  } catch (error) {
    next(error);
  }
}

/** Comprobante subido desde la pagina de pago (multipart, campo "receipt"). */
export async function uploadPaymentReceipt(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await findByToken(req.params.token);
    if (!order) return res.status(404).json({ error: "No encontramos este pedido" });
    if (order.source !== "transfer") return res.status(409).json({ error: "Este pedido no se paga por transferencia" });
    if (order.status !== "pending" || order.transfer?.status === "approved") {
      return res.status(409).json({ error: "Este pedido ya no espera comprobante" });
    }
    const file = req.file;
    if (!file || !isAcceptedReceipt(file.mimetype)) {
      return res.status(400).json({ error: "Sube una foto (JPG, PNG, WEBP) o un PDF del comprobante" });
    }

    await attachReceipt(order, { buffer: file.buffer, mimeType: file.mimetype }, "web");
    res.status(201).json(await publicOrder(order));
  } catch (error) {
    next(error);
  }
}

// ─── Revision de transferencias (panel) ──────────────────────────────────────

/** El equipo aprueba o rechaza el comprobante. Aprobar marca el pedido como pagado. */
export async function reviewTransfer(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const decision = req.body?.decision;
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : "";
    if (decision !== "approve" && decision !== "reject") {
      return res.status(400).json({ error: "Decisión no válida" });
    }

    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Pedido no encontrado" });
    if (order.source !== "transfer") return res.status(409).json({ error: "Este pedido no es por transferencia" });
    if (decision === "approve" && !order.transfer?.receipts?.length) {
      return res.status(409).json({ error: "El pedido aún no tiene comprobante" });
    }
    if (decision === "reject" && !note) {
      return res.status(400).json({ error: "Escribe el motivo del rechazo: el cliente lo verá" });
    }

    order.set("transfer.status", decision === "approve" ? "approved" : "rejected");
    order.set("transfer.reviewedBy", req.admin?.email || "");
    order.set("transfer.reviewedAt", new Date());
    order.set("transfer.note", note);
    const becamePaid = decision === "approve" && order.status === "pending";
    if (becamePaid) {
      order.status = "paid";
      recordStatus(order, "paid", req.admin?.email || "");
    }
    await order.save();
    if (becamePaid) notifyStatusChange(order, "paid", req.admin?.email || "");
    if (decision === "reject") notifyTransferRejected(order, note);

    res.json(order);
  } catch (error) {
    next(error);
  }
}
