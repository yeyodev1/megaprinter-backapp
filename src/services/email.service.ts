import axios from "axios";

/**
 * Correo al equipo de Megaprinter via Resend. Nunca lanza: un correo caido no
 * debe tumbar un pedido ni la respuesta del bot.
 */
export async function sendStoreEmail(subject: string, html: string, replyTo?: string) {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) return;

  const emailTo = process.env.EMAIL_TO || "megaprinter@bakano.ec";
  const emailFrom = process.env.EMAIL_FROM || "Megaprinter Web <onboarding@resend.dev>";

  try {
    await axios.post(
      "https://api.resend.com/emails",
      { from: emailFrom, to: [emailTo], ...(replyTo ? { reply_to: replyTo } : {}), subject, html },
      { headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    console.error("Resend email error:", error?.response?.data || error?.message);
  }
}

export const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

interface OrderForEmail {
  orderNumber?: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  address?: string | null;
  items: Array<{ name?: string | null; price?: number | null; quantity?: number | null }>;
  totalAmount: number;
  source: string;
}

const SOURCE_LABEL: Record<string, string> = {
  payphone: "Tarjeta (Payphone)",
  transfer: "Transferencia bancaria",
  whatsapp: "Por coordinar con un asesor",
};

/** Aviso al equipo de un pedido nuevo (web o bot). */
export function notifyNewOrder(order: OrderForEmail, channelLabel: string) {
  const itemsList = order.items
    .map((item) => `- ${escapeHtml(item.name)} (x${item.quantity}): $${((item.price || 0) * (item.quantity || 0)).toFixed(2)}`)
    .join("<br>");

  return sendStoreEmail(
    `Nuevo pedido ${order.orderNumber || ""} de ${order.customerName} - $${order.totalAmount.toFixed(2)}`.replace(/\s+/g, " "),
    `
      <h2>Nuevo pedido / cotización - Megaprinter</h2>
      <p><strong>Pedido:</strong> ${escapeHtml(order.orderNumber || "-")} · ${escapeHtml(channelLabel)}</p>
      <p><strong>Pago:</strong> ${escapeHtml(SOURCE_LABEL[order.source] || order.source)}</p>
      <p><strong>Cliente:</strong> ${escapeHtml(order.customerName)}</p>
      <p><strong>Correo:</strong> ${escapeHtml(order.customerEmail)}</p>
      <p><strong>Teléfono / WhatsApp:</strong> ${escapeHtml(order.customerPhone)}</p>
      <p><strong>Dirección:</strong> ${escapeHtml(order.address || "No especificada")}</p>
      <h3>Productos / servicios:</h3>
      <p>${itemsList}</p>
      <h3>Total: $${order.totalAmount.toFixed(2)}</h3>
    `,
    order.customerEmail,
  );
}
