import { Request, Response, NextFunction } from "express";
import axios from "axios";
import { ORDER_STATUSES, OrderModel, OrderStatus } from "../models/order.model";

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
    if (!["payphone", "whatsapp"].includes(source)) {
      return res.status(400).json({ error: "Origen de pedido no válido" });
    }

    const totalAmount = computeTotal(items);

    const order = await OrderModel.create({
      customerName: String(customerName).trim(),
      customerEmail: String(customerEmail).trim().toLowerCase(),
      customerPhone: String(customerPhone).trim(),
      address: address ? String(address).trim() : "",
      items,
      totalAmount,
      source,
      clientTransactionId: clientTransactionId || "",
      status: source === "whatsapp" ? "whatsapp" : "pending",
    });

    const whatsappNumber = process.env.WHATSAPP_NUMBER || "593998028318";

    // La notificacion por correo no debe bloquear la respuesta: si Resend esta
    // caido el cliente igual necesita su enlace de WhatsApp.
    void notifyByEmail(order.customerName, order.customerEmail, order.customerPhone, order.address, items, totalAmount);

    const itemsText = items.map((item) => `${item.name} (x${item.quantity})`).join(", ");
    const waText = encodeURIComponent(
      `Hola Megaprinter! Soy ${order.customerName}. Deseo confirmar mi pedido:\n` +
        `- Productos: ${itemsText}\n` +
        `- Total: $${totalAmount.toFixed(2)}\n` +
        `- Dirección: ${order.address || "Guayaquil"}\n` +
        `- Correo: ${order.customerEmail}`,
    );

    return res.status(201).json({
      success: true,
      message: "Pedido procesado con éxito",
      orderId: order.id,
      totalAmount,
      whatsappLink: `https://wa.me/${whatsappNumber}?text=${waText}`,
    });
  } catch (error) {
    next(error);
  }
}

async function notifyByEmail(
  customerName: string,
  customerEmail: string,
  customerPhone: string,
  address: string,
  items: IncomingItem[],
  totalAmount: number,
) {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) return;

  const emailTo = process.env.EMAIL_TO || "megaprinter@bakano.ec";
  const emailFrom = process.env.EMAIL_FROM || "Megaprinter Web <onboarding@resend.dev>";

  const itemsList = items
    .map((item) => `- ${item.name} (x${item.quantity}): $${(item.price * item.quantity).toFixed(2)}`)
    .join("<br>");

  try {
    await axios.post(
      "https://api.resend.com/emails",
      {
        from: emailFrom,
        to: [emailTo],
        reply_to: customerEmail,
        subject: `Nuevo pedido de ${customerName} - $${totalAmount.toFixed(2)}`,
        html: `
          <h2>Nuevo pedido / cotización - Megaprinter</h2>
          <p><strong>Cliente:</strong> ${customerName}</p>
          <p><strong>Correo:</strong> ${customerEmail}</p>
          <p><strong>Teléfono / WhatsApp:</strong> ${customerPhone}</p>
          <p><strong>Dirección:</strong> ${address || "No especificada"}</p>
          <h3>Productos / servicios:</h3>
          <p>${itemsList}</p>
          <h3>Total: $${totalAmount.toFixed(2)}</h3>
        `,
      },
      { headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    console.error("Resend email error:", error?.response?.data || error?.message);
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
