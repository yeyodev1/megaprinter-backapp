import { Request, Response, NextFunction } from "express";
import axios from "axios";
import { ORDER_SOURCES, ORDER_STATUSES, OrderModel, OrderSource, OrderStatus } from "../models/order.model";
import { AdminRequest } from "../middlewares/admin.middleware";
import { notifyNewOrder } from "../services/email.service";
import { attachReceipt, bankDetails, isAcceptedReceipt, transferAccount, transferEnabled } from "../services/transfer.service";

const PAYPHONE_CONFIRM_URL = "https://paymentbox.payphonetodoesposible.com/api/confirm";
const PAYPHONE_APPROVED = 3;

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
  const token = process.env.PAYPHONE_TOKEN;

  if (!id || !clientTransactionId) {
    return res.status(400).json({ error: "Faltan datos de confirmación de Payphone" });
  }
  if (!token) {
    return res.status(503).json({ error: "Payphone no está configurado" });
  }

  try {
    const order = await OrderModel.findOne({ clientTransactionId });
    if (!order) {
      return res.status(404).json({ error: "No encontramos el pedido de esa transacción" });
    }

    // Idempotencia: Payphone puede reintentar el retorno y el usuario puede
    // recargar la pagina de confirmacion. Sin esto se volvia a llamar a la API
    // externa en cada recarga.
    if (order.status === "paid") {
      return res.json({
        statusCode: PAYPHONE_APPROVED,
        transactionStatus: "Approved",
        message: "El pago ya estaba confirmado",
      });
    }

    const { data } = await axios.post(
      PAYPHONE_CONFIRM_URL,
      { id: Number(id), clientTxId: clientTransactionId },
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        timeout: 20000,
      },
    );

    const approved = data?.statusCode === PAYPHONE_APPROVED;

    // Payphone devuelve el monto en centavos. Se compara con lo que realmente
    // se guardo del pedido: sin esta verificacion una transaccion de $1 podia
    // marcar como pagada una orden de $1000.
    const confirmedAmount = Number(data?.amount);
    const expectedAmount = Math.round(order.totalAmount * 100);
    const amountMatches =
      !Number.isFinite(confirmedAmount) || confirmedAmount === expectedAmount;

    if (approved && !amountMatches) {
      order.status = "pending";
      await order.save();
      console.error(
        `[payphone] monto no coincide para ${clientTransactionId}: esperado ${expectedAmount}, recibido ${confirmedAmount}`,
      );
      return res.status(409).json({
        error: "El monto confirmado no coincide con el pedido. Contáctanos para revisarlo.",
      });
    }

    order.status = approved ? "paid" : "cancelled";
    order.payphoneTransactionId = data?.transactionId;
    await order.save();

    return res.json(data);
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
    void notifyNewOrder(order, "Tienda web");

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

export async function updateOrderStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const status = req.body?.status as OrderStatus;
    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Estado de pedido no válido" });
    }

    const order = await OrderModel.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true, runValidators: true },
    );
    if (!order) return res.status(404).json({ error: "Pedido no encontrado" });

    res.json(order);
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
    bank: order.source === "transfer" ? await transferAccount() : null,
  };
}

export async function getTransferConfig(_req: Request, res: Response, next: NextFunction) {
  try {
    const bank = await bankDetails();
    res.json({ enabled: bank !== null, bank });
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
    if (["paid", "processing", "delivered"].includes(order.status)) {
      return res.status(409).json({ error: "Este pedido ya está pagado" });
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
    if (decision === "approve" && order.status === "pending") order.status = "paid";
    await order.save();

    res.json(order);
  } catch (error) {
    next(error);
  }
}
