import { escapeHtml, notifyNewOrder, sendEmail, storeRecipients } from "./email.service";

/**
 * CORREOS DE CADA PEDIDO.
 *
 * Un solo lugar decide qué correo sale en cada momento:
 * - Cliente: pedido recibido, pago confirmado, en preparación, enviado (con
 *   guía), entregado, cancelado, comprobante rechazado.
 * - Equipo (team@megaprinter.ec): pedido nuevo y pago confirmado.
 * Ninguno bloquea ni rompe el flujo si Resend falla.
 */

const webUrl = () => (process.env.PUBLIC_WEB_URL || "https://megaprinter.ec").replace(/\/$/, "");
export const trackingUrl = (order: any) => `${webUrl()}/pedido/${order.paymentToken}`;
const payUrl = (order: any) => `${webUrl()}/pagar/${order.paymentToken}`;
const money = (value: number) => `$${Number(value || 0).toFixed(2)}`;
const firstName = (name: string) => escapeHtml(String(name || "").trim().split(/\s+/)[0] || "");
const code = (order: any) => escapeHtml(order.orderNumber || String(order._id).slice(-6).toUpperCase());

function layout(title: string, body: string, cta?: { label: string; url: string }) {
  return `
  <div style="background:#f4f4f2;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#1d1d1f">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e6e3">
      <div style="background:#0c0c0e;padding:18px 24px;color:#ffffff;font-size:18px;font-weight:bold">
        <span style="color:#00a3e0">Mega</span>printer
      </div>
      <div style="padding:24px">
        <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">${title}</h1>
        ${body}
        ${cta ? `<p style="margin:24px 0 8px"><a href="${cta.url}" style="display:inline-block;background:#00a3e0;color:#0c0c0e;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:10px">${escapeHtml(cta.label)}</a></p>` : ""}
      </div>
      <div style="padding:16px 24px;background:#fafaf8;color:#85868c;font-size:12px">
        Megaprinter · Tecnología y soporte técnico en Ecuador · ¿Dudas? Responde este correo o escríbenos por WhatsApp.
      </div>
    </div>
  </div>`;
}

function itemsTable(order: any) {
  const rows = (order.items || [])
    .map(
      (item: any) =>
        `<tr><td style="padding:6px 0">${Number(item.quantity)} × ${escapeHtml(item.name)}</td><td style="padding:6px 0;text-align:right">${money(item.price * item.quantity)}</td></tr>`,
    )
    .join("");
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:12px 0">${rows}
    <tr><td style="padding:8px 0;border-top:1px solid #e6e6e3;font-weight:bold">Total</td><td style="padding:8px 0;border-top:1px solid #e6e6e3;text-align:right;font-weight:bold">${money(order.totalAmount)}</td></tr></table>`;
}

function bankBlock(account: any) {
  if (!account?.accountNumber) return "";
  return `<div style="background:#eaf8fd;border:1px solid #d4f0fb;border-radius:10px;padding:12px 16px;font-size:14px;margin:12px 0">
    <strong>${escapeHtml(account.bank)}</strong><br>Cuenta ${escapeHtml(account.accountType || "")} N.º <strong>${escapeHtml(account.accountNumber)}</strong><br>
    A nombre de ${escapeHtml(account.accountHolder || "")}${account.holderId ? ` · ${escapeHtml(account.holderId)}` : ""}</div>`;
}

const p = (text: string) => `<p style="margin:0 0 10px;font-size:15px;line-height:1.5">${text}</p>`;

/** Pedido recibido: al cliente (con lo que sigue) y al equipo. */
export function notifyOrderCreated(order: any, channelLabel: string) {
  void notifyNewOrder(order, channelLabel);
  if (!order.customerEmail) return;

  let next = "";
  let cta: { label: string; url: string } | undefined = { label: "Ver mi pedido", url: trackingUrl(order) };
  if (order.source === "payphone") {
    next = p("Para completar tu compra, paga con tarjeta en el link seguro de Payphone. Cuando lo hagas, te confirmamos por aquí.");
    cta = { label: `Pagar ${money(order.totalAmount)}`, url: payUrl(order) };
  } else if (order.source === "transfer") {
    next = order.transfer?.account?.accountNumber
      ? p(`Transfiere <strong>${money(order.totalAmount)}</strong> a esta cuenta y envíanos la foto del comprobante por WhatsApp o desde tu enlace de pago:`) + bankBlock(order.transfer.account)
      : p(`Elige tu banco y sube el comprobante de la transferencia por <strong>${money(order.totalAmount)}</strong> desde tu enlace de pago.`);
    cta = { label: "Subir comprobante", url: payUrl(order) };
  } else {
    next = p("Una persona de nuestro equipo te contacta para coordinar el pago y la entrega.");
  }

  void sendEmail(
    order.customerEmail,
    `Recibimos tu pedido ${order.orderNumber || ""} 🎉`.trim(),
    layout(`Hola ${firstName(order.customerName)}, recibimos tu pedido ${code(order)}`, itemsTable(order) + next + p(`Puedes ver el estado de tu pedido cuando quieras en <a href="${trackingUrl(order)}">${webUrl()}/pedido</a> con tu correo o el código <strong>${code(order)}</strong>.`), cta),
  );
}

const STATUS_COPY: Record<string, { subject: string; title: string; body: (order: any) => string }> = {
  paid: {
    subject: "Pago confirmado ✅",
    title: "Tu pago está confirmado ✅",
    body: (order) => p(`Recibimos tu pago de <strong>${money(order.totalAmount)}</strong>. Ya estamos preparando tu pedido y te avisamos cuando salga.`),
  },
  processing: {
    subject: "Estamos preparando tu pedido 📦",
    title: "Tu pedido está en preparación 📦",
    body: () => p("Nuestro equipo está alistando tu pedido. Te avisamos apenas salga con su guía de envío."),
  },
  shipped: {
    subject: "Tu pedido va en camino 🚚",
    title: "Tu pedido va en camino 🚚",
    body: (order) => {
      const shipping = order.shipping || {};
      return (
        p("Tu pedido ya salió. Estos son los datos del envío:") +
        `<div style="background:#f4f4f2;border-radius:10px;padding:12px 16px;font-size:14px;margin:12px 0">
          ${shipping.carrier ? `Transportista: <strong>${escapeHtml(shipping.carrier)}</strong><br>` : ""}
          ${shipping.trackingNumber ? `N.º de guía: <strong>${escapeHtml(shipping.trackingNumber)}</strong><br>` : ""}
          ${shipping.guideUrl ? `<a href="${shipping.guideUrl}">Descargar la guía</a>` : ""}
        </div>`
      );
    },
  },
  delivered: {
    subject: "Pedido entregado 🙌",
    title: "Tu pedido fue entregado 🙌",
    body: () => p("Gracias por comprar en Megaprinter. Si necesitas algo con tu equipo, aquí estamos."),
  },
  cancelled: {
    subject: "Tu pedido fue cancelado",
    title: "Tu pedido fue cancelado",
    body: () => p("Si fue un error o quieres retomarlo, respóndenos este correo o escríbenos por WhatsApp."),
  },
};

/** Cambio de etapa: correo al cliente y, si se pagó, aviso al equipo. */
export function notifyStatusChange(order: any, status: string, by = "") {
  const copy = STATUS_COPY[status];
  if (copy && order.customerEmail) {
    void sendEmail(
      order.customerEmail,
      `${copy.subject} · ${order.orderNumber || "Megaprinter"}`,
      layout(`Hola ${firstName(order.customerName)}, ${copy.title.charAt(0).toLowerCase()}${copy.title.slice(1)}`, copy.body(order) + itemsTable(order), { label: "Ver mi pedido", url: trackingUrl(order) }),
    );
  }
  if (status === "paid") {
    const method = order.source === "payphone" ? "tarjeta (Payphone)" : order.source === "transfer" ? `transferencia${order.transfer?.account?.bank ? ` · ${order.transfer.account.bank}` : ""}` : order.source;
    void sendEmail(
      storeRecipients(),
      `💰 Pago confirmado ${order.orderNumber || ""}: prepara el pedido`,
      layout(
        `Pago confirmado: ${code(order)}`,
        p(`<strong>${escapeHtml(order.customerName)}</strong> pagó <strong>${money(order.totalAmount)}</strong> por ${escapeHtml(method)}${by ? ` (confirmado por ${escapeHtml(by)})` : ""}.`) +
          p(`📧 ${escapeHtml(order.customerEmail)} · 📞 ${escapeHtml(order.customerPhone)} · 📍 ${escapeHtml(order.address || "Sin dirección")}`) +
          itemsTable(order),
        { label: "Abrir en el panel", url: `${webUrl()}/admin/orders?search=${encodeURIComponent(order.orderNumber || "")}` },
      ),
      order.customerEmail,
    );
  }
}

/** Comprobante rechazado: el cliente sabe por qué y puede subir otro. */
export function notifyTransferRejected(order: any, note: string) {
  if (!order.customerEmail) return;
  void sendEmail(
    order.customerEmail,
    `Revisa tu comprobante · ${order.orderNumber || "Megaprinter"}`,
    layout(
      `Hola ${firstName(order.customerName)}, no pudimos validar tu comprobante`,
      p(`Motivo: <strong>${escapeHtml(note)}</strong>`) + p("Puedes subir uno nuevo desde tu enlace de pago o mandarlo por WhatsApp."),
      { label: "Subir otro comprobante", url: payUrl(order) },
    ),
  );
}

/** Deja la etapa en el historial del pedido (no guarda: el que llama hace save). */
export function recordStatus(order: any, status: string, by = "") {
  const history = [...(order.statusHistory || []), { status, at: new Date(), by }];
  if (typeof order.set === "function") order.set("statusHistory", history);
  else order.statusHistory = history;
}
