import { BotEventModel } from "../models/botEvent.model";
import { ServiceTicketModel } from "../models/serviceTicket.model";
import { WhatsAppSessionModel } from "../models/whatsappSession.model";
import { crmEnabled, firstAgentReply } from "./crm.service";
import { escapeHtml, sendEmail, storeRecipients } from "./email.service";

/**
 * Reporte diario de atencion por WhatsApp: cuanta gente escribio, cuanta
 * resolvio el bot, quien pidio una persona y si alguien le respondio.
 *
 * "Respondido" sale del CRM de BuilderBot (mensaje de una persona del equipo
 * despues del traspaso). Sin CRM se usa una señal del bot: si el cliente siguio
 * escribiendo 15+ min despues de pedir asesor, se marca "posible sin atender".
 */

// Ecuador no tiene horario de verano: UTC-5 fijo.
const OFFSET_MS = 5 * 60 * 60 * 1000;
const NOT_UNDERSTOOD = /^R9:(no_entendido|eleccion_no_entendida)$|^R8:(sin_resultados|fuera_de_tema)$/;
const INSISTS_AFTER_MS = 15 * 60 * 1000;

export type HandoffStatus = "atendido" | "sin_atender" | "posible_sin_atender" | "sin_confirmar";

export interface AttentionReport {
  date: string;
  crm: boolean;
  totals: {
    conversations: number;
    messages: number;
    botOnly: number;
    handoffs: number;
    attended: number;
    unattended: number;
    unknown: number;
    tickets: number;
    orders: number;
    notUnderstood: number;
    avgResponseMinutes: number | null;
  };
  handoffs: Array<{ phone: string; name: string; at: string; reason: string; status: HandoffStatus; responseMinutes: number | null; followUps: number; lastMessage: string }>;
  notUnderstood: Array<{ phone: string; name: string; at: string; message: string; reply: string }>;
  hourly: number[];
}

/** "YYYY-MM-DD" de hoy en Ecuador (o de hace `daysAgo` dias). */
export function ecuadorDate(daysAgo = 0) {
  return new Date(Date.now() - OFFSET_MS - daysAgo * 86400000).toISOString().slice(0, 10);
}

function dayRange(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d) + OFFSET_MS);
  return { start, end: new Date(start.getTime() + 86400000) };
}

export async function buildAttentionReport(date = ecuadorDate()): Promise<AttentionReport> {
  const { start, end } = dayRange(date);
  const events: any[] = await BotEventModel.find({ kind: "turn", duplicated: { $ne: true }, createdAt: { $gte: start, $lt: end } })
    .sort({ createdAt: 1 })
    .lean();
  // +5939900000xx son simulaciones de prueba, no clientes.
  const phones = [...new Set(events.map((event) => event.phone))].filter((phone) => !/^\+?5939900000\d\d$/.test(phone));
  const sessions: any[] = await WhatsAppSessionModel.find({ phone: { $in: phones } }, { phone: 1, "state.customerName": 1 }).lean();
  const nameOf = new Map(sessions.map((session) => [session.phone, session.state?.customerName || ""]));
  const tickets = await ServiceTicketModel.countDocuments({ createdAt: { $gte: start, $lt: end } });

  const hourly = Array(24).fill(0);
  const handoffs: AttentionReport["handoffs"] = [];
  const notUnderstood: AttentionReport["notUnderstood"] = [];
  let orders = 0;

  for (const phone of phones) {
    const mine = events.filter((event) => event.phone === phone);
    for (const event of mine) {
      hourly[new Date(new Date(event.createdAt).getTime() - OFFSET_MS).getUTCHours()] += 1;
      if (event.decision === "R7:orden_creada") orders += 1;
      if (NOT_UNDERSTOOD.test(event.decision)) {
        notUnderstood.push({ phone, name: nameOf.get(phone) || "", at: new Date(event.createdAt).toISOString(), message: event.message, reply: event.reply.slice(0, 200) });
      }
    }
    const handoff = mine.find((event) => event.route === "human");
    if (!handoff) continue;
    const at = new Date(handoff.createdAt);
    const after = mine.filter((event) => new Date(event.createdAt) > at);
    const insisted = after.some((event) => new Date(event.createdAt).getTime() - at.getTime() >= INSISTS_AFTER_MS);
    const reply = await firstAgentReply(phone, at, new Date(Math.min(end.getTime() + 86400000, Date.now())));
    const status: HandoffStatus = reply ? (reply.at ? "atendido" : "sin_atender") : insisted ? "posible_sin_atender" : "sin_confirmar";
    handoffs.push({
      phone,
      name: nameOf.get(phone) || "",
      at: at.toISOString(),
      reason: handoff.message,
      status,
      responseMinutes: reply?.at ? Math.round((reply.at.getTime() - at.getTime()) / 60000) : null,
      followUps: after.length,
      lastMessage: (after.at(-1) || handoff).message,
    });
  }

  const responseTimes = handoffs.map((item) => item.responseMinutes).filter((value): value is number => value != null);
  return {
    date,
    crm: crmEnabled(),
    totals: {
      conversations: phones.length,
      messages: events.length,
      botOnly: phones.length - handoffs.length,
      handoffs: handoffs.length,
      attended: handoffs.filter((item) => item.status === "atendido").length,
      unattended: handoffs.filter((item) => item.status === "sin_atender" || item.status === "posible_sin_atender").length,
      unknown: handoffs.filter((item) => item.status === "sin_confirmar").length,
      tickets,
      orders,
      notUnderstood: notUnderstood.length,
      avgResponseMinutes: responseTimes.length ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) : null,
    },
    handoffs: handoffs.sort((a, b) => b.at.localeCompare(a.at)),
    notUnderstood: notUnderstood.sort((a, b) => b.at.localeCompare(a.at)),
    hourly,
  };
}

const STATUS_LABEL: Record<HandoffStatus, string> = {
  atendido: "✅ Atendido",
  sin_atender: "🔴 Sin atender",
  posible_sin_atender: "🟠 Siguió escribiendo, posible sin atender",
  sin_confirmar: "⚪ Sin confirmar",
};

const time = (iso: string) => new Date(iso).toLocaleTimeString("es-EC", { timeZone: "America/Guayaquil", hour: "2-digit", minute: "2-digit" });

/** Correo del resumen diario para quienes atienden y el equipo. */
export async function sendAttentionReportEmail(date = ecuadorDate(1)) {
  const report = await buildAttentionReport(date);
  const t = report.totals;
  const web = (process.env.PUBLIC_WEB_URL || "https://megaprinter.ec").replace(/\/$/, "");
  const handoffRows = report.handoffs
    .map(
      (item) =>
        `<tr><td style="padding:6px 8px">${time(item.at)}</td><td style="padding:6px 8px"><b>${escapeHtml(item.name || item.phone)}</b><br><span style="color:#777">${escapeHtml(item.phone)}</span></td><td style="padding:6px 8px">${escapeHtml(item.reason.slice(0, 120))}</td><td style="padding:6px 8px">${STATUS_LABEL[item.status]}${item.responseMinutes != null ? ` · ${item.responseMinutes} min` : ""}</td><td style="padding:6px 8px"><a href="https://wa.me/${item.phone.replace(/\D/g, "")}">Abrir chat</a></td></tr>`,
    )
    .join("");
  const notUnderstoodRows = report.notUnderstood
    .slice(0, 15)
    .map((item) => `<li>${time(item.at)} · ${escapeHtml(item.name || item.phone)}: "${escapeHtml(item.message.slice(0, 140))}"</li>`)
    .join("");
  const stat = (value: string | number, label: string, color = "#0c0c0e") =>
    `<td style="padding:12px;border:1px solid #e5e5e5;border-radius:8px;text-align:center"><div style="font-size:24px;font-weight:800;color:${color}">${value}</div><div style="font-size:13px;color:#555">${label}</div></td>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:760px">
<h2 style="margin:0 0 4px">📊 Atención por WhatsApp · ${escapeHtml(date)}</h2>
<p style="margin:0 0 16px;color:#555">Resumen de lo que pasó ayer con Mila y el equipo.</p>
<table cellspacing="6" style="width:100%"><tr>
${stat(t.conversations, "Personas escribieron")}${stat(t.botOnly, "Resolvió el bot")}${stat(t.handoffs, "Pidieron asesor")}
</tr><tr>
${stat(t.attended, "Asesor respondió", "#0f9d58")}${stat(t.unattended, "Sin atender", t.unattended ? "#d92b3a" : "#0c0c0e")}${stat(t.avgResponseMinutes != null ? `${t.avgResponseMinutes} min` : "—", "Tiempo de respuesta")}
</tr><tr>
${stat(t.tickets, "Tickets de servicio")}${stat(t.orders, "Pedidos por el bot")}${stat(t.notUnderstood, "Mensajes que no entendió")}
</tr></table>
${report.crm ? "" : `<p style="color:#a37800">⚠️ El CRM de BuilderBot aún no está conectado: "sin atender" se estima por si el cliente siguió escribiendo.</p>`}
<h3>🙋 Quienes pidieron una persona</h3>
${handoffRows ? `<table style="width:100%;border-collapse:collapse;font-size:14px"><tr style="background:#f3f3f1;text-align:left"><th style="padding:6px 8px">Hora</th><th style="padding:6px 8px">Cliente</th><th style="padding:6px 8px">Dijo</th><th style="padding:6px 8px">Estado</th><th></th></tr>${handoffRows}</table>` : "<p>Nadie pidió asesor.</p>"}
${notUnderstoodRows ? `<h3>🤔 Lo que Mila no entendió</h3><ul>${notUnderstoodRows}</ul>` : ""}
<p><a href="${web}/admin/atencion?date=${date}">Ver el reporte completo en el panel</a></p></div>`;
  const list = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);
  const to = list(process.env.REPORT_EMAIL || "marilexich23@gmail.com,selenamendoza100@gmail.com,jhnnmurillo@gmail.com");
  const result = await sendEmail(to, `📊 Atención WhatsApp ${date}: ${t.conversations} personas, ${t.handoffs} pidieron asesor, ${t.unattended} sin atender`, html, undefined, storeRecipients().filter((email) => !to.includes(email)));
  return { report, email: result };
}
