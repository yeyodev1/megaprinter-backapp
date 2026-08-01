import { Request, Response, NextFunction } from "express";
import axios from "axios";
import { OrderModel } from "../models/order.model";

export function getPayphoneConfig(_req: Request, res: Response) {
  const token = process.env.PAYPHONE_TOKEN;
  const storeId = process.env.PAYPHONE_STORE_ID;

  if (!token || !storeId) {
    return res.status(503).json({ error: "Payphone is not configured" });
  }

  // Payphone's official browser SDK requires these two credentials to render its payment box.
  return res.json({ token, storeId });
}

export async function confirmPayphonePayment(req: Request, res: Response, next: NextFunction) {
  const { id, clientTransactionId } = req.body;
  const token = process.env.PAYPHONE_TOKEN;

  if (!id || !clientTransactionId || !token) {
    return res.status(400).json({ error: "Missing Payphone confirmation data" });
  }

  try {
    const response = await axios.post(
      "https://paymentbox.payphonetodoesposible.com/api/confirm",
      { id: Number(id), clientTxId: clientTransactionId },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );

    await OrderModel.findOneAndUpdate(
      { clientTransactionId },
      {
        status: response.data.statusCode === 3 ? "paid" : "cancelled",
        payphoneTransactionId: response.data.transactionId,
      }
    );

    return res.json(response.data);
  } catch (error) {
    next(error);
  }
}

export async function createOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { customerName, customerEmail, customerPhone, address, items, totalAmount, source, clientTransactionId } = req.body;

    if (!customerName || !customerEmail || !customerPhone || !items || !totalAmount || !["payphone", "whatsapp"].includes(source)) {
      return res.status(400).json({ error: "Missing required order fields" });
    }

    const order = await OrderModel.create({
      customerName, customerEmail, customerPhone, address, items, totalAmount, source,
      clientTransactionId: clientTransactionId || "", status: source === "whatsapp" ? "whatsapp" : "pending",
    });

    const emailTo = process.env.EMAIL_TO || "megaprinter@bakano.ec";
    const resendApiKey = process.env.RESEND_API_KEY;
    const whatsappNumber = process.env.WHATSAPP_NUMBER || "593998028318";

    // 1. Send Email via Resend
    if (resendApiKey) {
      try {
        const itemsList = items
          .map((i: any) => `- ${i.name} (x${i.quantity}): $${(i.price * i.quantity).toFixed(2)}`)
          .join("<br>");

        const emailHtml = `
          <h2>Nuevo Pedido / Cotización - Megaprinter</h2>
          <p><strong>Cliente:</strong> ${customerName}</p>
          <p><strong>Correo:</strong> ${customerEmail}</p>
          <p><strong>Teléfono / WhatsApp:</strong> ${customerPhone}</p>
          <p><strong>Dirección:</strong> ${address || "No especificada"}</p>
          <h3>Productos / Servicios:</h3>
          <p>${itemsList}</p>
          <h3>Total: $${Number(totalAmount).toFixed(2)}</h3>
        `;

        await axios.post(
          "https://api.resend.com/emails",
          {
            from: "Megaprinter Web <onboarding@resend.dev>",
            to: [emailTo],
            subject: `Nuevo Pedido de ${customerName} - $${Number(totalAmount).toFixed(2)}`,
            html: emailHtml,
          },
          {
            headers: {
              Authorization: `Bearer ${resendApiKey}`,
              "Content-Type": "application/json",
            },
          }
        );
      } catch (emailErr: any) {
        console.error("Resend email error:", emailErr?.response?.data || emailErr.message);
      }
    }

    // Generate WhatsApp direct link
    const itemsText = items.map((i: any) => `${i.name} (x${i.quantity})`).join(", ");
    const waText = encodeURIComponent(
      `Hola Megaprinter! Soy ${customerName}. Deseo confirmar mi pedido:\n- Productos: ${itemsText}\n- Total: $${Number(totalAmount).toFixed(2)}\n- Dirección: ${address || 'Guayaquil'}\n- Correo: ${customerEmail}`
    );
    const whatsappLink = `https://wa.me/${whatsappNumber}?text=${waText}`;

    return res.status(200).json({
      success: true,
      message: "Pedido procesado con éxito",
      orderId: order.id,
      whatsappLink,
    });
  } catch (error) {
    next(error);
  }
}

export async function listOrders(req: Request, res: Response, next: NextFunction) {
  try { res.json(await OrderModel.find().sort({ createdAt: -1 }).limit(200)); } catch (error) { next(error); }
}
