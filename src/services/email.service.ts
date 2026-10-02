import axios from "axios";

const emailFrom = () => process.env.EMAIL_FROM || "Megaprinter Web <onboarding@resend.dev>";

/**
 * Correos del equipo: team@megaprinter.ec siempre, mas EMAIL_TO si existe
 * (separados por coma).
 */
export const storeRecipients = () => [
  ...new Set(["team@megaprinter.ec", ...(process.env.EMAIL_TO || "").split(",")].map((value) => value.trim().toLowerCase()).filter(Boolean)),
];

/**
 * Envio via Resend. Nunca lanza: un correo caido no debe tumbar un pedido ni
 * la respuesta del bot. OJO: con el remitente de prueba (onboarding@resend.dev)
 * Resend solo entrega al dueño de la cuenta; para llegar a clientes hay que
 * verificar el dominio y poner EMAIL_FROM (ej. "Megaprinter <pedidos@megaprinter.ec>").
 */
export async function sendEmail(
  to: string | string[],
  subject: string,
  html: string,
  replyTo?: string,
): Promise<{ ok: boolean; error?: string }> {
  const resendApiKey = process.env.RESEND_API_KEY;
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { ok: false, error: "Sin destinatario" };
  if (!resendApiKey) return { ok: false, error: "Falta RESEND_API_KEY" };
  try {
    await axios.post(
      "https://api.resend.com/emails",
      { from: emailFrom(), to: recipients, ...(replyTo ? { reply_to: replyTo } : {}), subject, html },
      { headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" }, timeout: 10000 },
    );
    return { ok: true };
  } catch (error: any) {
    const detail = String(error?.response?.data?.message || error?.message || error).slice(0, 300);
    console.error(`[correo] no se pudo enviar "${subject}" a ${recipients.join(", ")}: ${detail}`);
    return { ok: false, error: detail };
  }
}

/** Correo al equipo de Megaprinter. */
export const sendStoreEmail = (subject: string, html: string, replyTo?: string) => sendEmail(storeRecipients(), subject, html, replyTo);

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

/** Correo al equipo de un pedido nuevo (web o bot). */
export function newOrderEmail(order: OrderForEmail, channelLabel: string) {
  const itemsList = order.items
    .map((item) => `- ${escapeHtml(item.name)} (x${item.quantity}): $${((item.price || 0) * (item.quantity || 0)).toFixed(2)}`)
    .join("<br>");

  return {
    subject: `Nuevo pedido ${order.orderNumber || ""} de ${order.customerName} - $${order.totalAmount.toFixed(2)}`.replace(/\s+/g, " "),
    html: `
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
  };
}
