import { ServiceTicketModel } from "../models/serviceTicket.model";
import { WhatsAppSessionModel } from "../models/whatsappSession.model";
import { geminiJson } from "./gemini.service";
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
  chatPhone?: string;
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
    chatPhone: data.chatPhone || "",
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

  // Resumen con IA sin hacer esperar al cliente; si falla, el panel lo genera al abrir el ticket.
  void summarizeTicket(String(ticket._id)).catch((error) => console.error("[tickets] resumen:", error?.message || error));

  return ticket;
}

const SUMMARY_PROMPT = `Eres asistente del equipo de Megaprinter (tienda de tecnología y servicio técnico en Ecuador).
Te paso un ticket que registró el bot de WhatsApp y la conversación con el cliente. Resume para el asesor que lo va a atender.
Devuelve SOLO JSON: {"summary":"...","wants":"...","classification":"...","needsAttention":true|false,"reason":"..."}
- summary: qué busca el cliente y su situación, en 1 o 2 frases cortas, con marca, modelo, color o código si los dio.
- wants: lo que quiere que hagamos, empezando con verbo (ej. "Cotizar la tinta cyan T748XXL", "Revisar su impresora que no imprime").
- classification: "servicio_tecnico" (reparar/mantener un equipo), "suministros" (tintas, tóner, cartuchos, repuestos), "compra" (quiere comprar un producto del catálogo), "seguimiento" (pregunta por algo que ya dejó, compró o pidió antes) o "no_claro" (no se entiende qué necesita).
- needsAttention: true si es "no_claro", "seguimiento", si el cliente está molesto o si el bot lo clasificó mal. Si no, false.
- reason: si needsAttention es true, en pocas palabras por qué. Si no, "".
No inventes datos que no estén en el ticket ni en la conversación. Español neutro, sin emojis.`;

interface TicketSummaryAI {
  summary?: string;
  wants?: string;
  classification?: string;
  needsAttention?: boolean;
  reason?: string;
}

const CLASSES = ["servicio_tecnico", "suministros", "compra", "seguimiento", "no_claro"];

/**
 * Resumen de que busca y que quiere el cliente. Si la IA no sabe clasificarlo o
 * pide atencion y el ticket sigue "nuevo", pasa a "Necesita atencion".
 */
export async function summarizeTicket(ticketId: string) {
  const ticket = await ServiceTicketModel.findById(ticketId);
  if (!ticket) return null;
  const phone = ticket.chatPhone || ticket.customerPhone;
  const session = phone ? await WhatsAppSessionModel.findOne({ phone }, { history: { $slice: -30 } }).lean() : null;
  const chat = (session?.history || [])
    .map((entry: any) => `${entry.role === "user" ? "Cliente" : "Bot"}: ${String(entry.content || "").slice(0, 600)}`)
    .join("\n");
  const ai = await geminiJson<TicketSummaryAI>({
    system: SUMMARY_PROMPT,
    text: `TICKET ${ticket.ticketNumber}\nTipo según el bot: ${ticket.type}\nEquipo: ${ticket.device || "-"}\nLo que contó: ${ticket.issue}\nCliente: ${ticket.customerName}\n\nCONVERSACIÓN (más reciente al final):\n${chat || "(no disponible)"}`,
    maxOutputTokens: 500,
    timeoutMs: 15000,
  });
  if (!ai?.summary) return null;
  const classification = CLASSES.includes(ai.classification || "") ? ai.classification! : "no_claro";
  const needsAttention = Boolean(ai.needsAttention) || classification === "no_claro";
  ticket.summary = {
    text: String(ai.summary).slice(0, 600),
    wants: String(ai.wants || "").slice(0, 300),
    classification,
    needsAttention,
    reason: needsAttention ? String(ai.reason || "No queda claro qué necesita").slice(0, 200) : "",
    at: new Date(),
  } as any;
  if (needsAttention && ticket.status === "nuevo") {
    ticket.status = "atencion";
    ticket.statusHistory.push({ status: "atencion", by: "IA", at: new Date() });
  }
  await ticket.save();
  return ticket;
}
