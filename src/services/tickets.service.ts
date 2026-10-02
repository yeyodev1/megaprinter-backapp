import { ServiceTicketModel } from "../models/serviceTicket.model";
import { createAlert } from "./alerts.service";
import { escapeHtml, sendEmail, storeRecipients } from "./email.service";
import { ServiceEstimate, deviceLabel } from "./whatsappBot/serviceCatalog";

const webUrl = () => (process.env.PUBLIC_WEB_URL || "https://megaprinter.ec").replace(/\/$/, "");

interface NewTicket {
  type: "servicio_tecnico" | "suministros";
  channel: "whatsapp_bot" | "web" | "panel";
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  device: string;
  issue: string;
  estimate: ServiceEstimate | null;
}

/** Crea el ticket, alerta en el panel y avisa al equipo por correo (si falla, alerta y sigue). */
export async function createServiceTicket(data: NewTicket) {
  const ticket = await ServiceTicketModel.create({
    type: data.type,
    channel: data.channel,
    customerName: data.customerName,
    customerPhone: data.customerPhone,
    customerEmail: data.customerEmail || "",
    device: data.device,
    issue: data.issue,
    category: data.estimate?.label || "",
    priceMin: data.estimate?.priceMin ?? null,
    priceMax: data.estimate?.priceMax ?? null,
    priceSource: data.estimate?.priceSource || "por_cotizar",
    statusHistory: [{ status: "nuevo", by: data.channel === "whatsapp_bot" ? "Bot" : "Panel", at: new Date() }],
  });

  const kind = data.type === "suministros" ? "Suministros" : "Servicio técnico";
  const price = data.estimate?.priceMin != null ? ` · ref. $${data.estimate.priceMin}–$${data.estimate.priceMax}` : "";
  const link = `/admin/tickets?ticket=${encodeURIComponent(ticket.ticketNumber || "")}`;
  createAlert("ticket_new", `🛠️ ${kind} ${ticket.ticketNumber}: ${data.customerName || data.customerPhone}`, `${data.type === "servicio_tecnico" ? `${deviceLabel(data.device)} · ` : ""}${data.issue}${price}`, link);

  void (async () => {
    const result = await sendEmail(
      storeRecipients(),
      `🛠️ ${kind} ${ticket.ticketNumber} · ${data.customerName || data.customerPhone}`,
      `<h2>${kind}: ${escapeHtml(ticket.ticketNumber)}</h2>
       <p><strong>Cliente:</strong> ${escapeHtml(data.customerName)} · ${escapeHtml(data.customerPhone)}</p>
       ${data.type === "servicio_tecnico" ? `<p><strong>Equipo:</strong> ${escapeHtml(deviceLabel(data.device))}</p>` : ""}
       <p><strong>Detalle:</strong> ${escapeHtml(data.issue)}</p>
       ${price ? `<p><strong>Precio referencial mostrado:</strong> $${data.estimate!.priceMin}–$${data.estimate!.priceMax} (${escapeHtml(data.estimate!.label)})</p>` : ""}
       <p>El cliente espera que un asesor tome el chat de WhatsApp.</p>
       <p><a href="${webUrl()}${link}">Abrir el ticket en el panel</a></p>`,
    );
    if (!result.ok) createAlert("email_failed", `Correo no enviado: ticket ${ticket.ticketNumber}`, `El ticket sigue registrado. Motivo: ${result.error || "desconocido"}`, link);
  })();

  return ticket;
}
