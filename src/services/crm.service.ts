import axios from "axios";

/**
 * Cliente del CRM de BuilderBot (Public API). Se usa para saber si una persona
 * del equipo respondio a quien pidio asesor y para el reporte diario.
 *
 * Credenciales en env (nunca en el codigo):
 *   BUILDERBOT_CRM_API_KEY  → la "API Key" del panel Public API del CRM
 *   BUILDERBOT_CRM_TENANT   → X-Tenant-ID (por defecto el de Megaprinter)
 *   BUILDERBOT_CRM_URL      → base URL (por defecto la del tenant)
 *
 * Nunca lanza: sin llave o con el CRM caido devuelve null y el reporte sigue
 * con los datos del bot.
 */

const TENANT = () => process.env.BUILDERBOT_CRM_TENANT || "62156346-df34-41ee-844c-666010c06787";
const BASE = () => (process.env.BUILDERBOT_CRM_URL || `https://${TENANT()}.crm.builderbot.cloud/api/v1`).replace(/\/$/, "");

export const crmEnabled = () => Boolean(process.env.BUILDERBOT_CRM_API_KEY);

async function crmGet<T = any>(path: string, params: Record<string, unknown> = {}): Promise<T | null> {
  if (!crmEnabled()) return null;
  try {
    const { data } = await axios.get(`${BASE()}${path}`, {
      params,
      headers: { "X-Tenant-ID": TENANT(), Authorization: `Bearer ${process.env.BUILDERBOT_CRM_API_KEY}` },
      timeout: 10000,
    });
    return data as T;
  } catch (error: any) {
    console.error(`[crm] GET ${path} fallo:`, error?.response?.status, error?.response?.data?.error?.message || error?.message);
    return null;
  }
}

/** Lista de la respuesta, venga como arreglo o envuelta ({ data }, { items }, { contacts }…). */
const rows = (payload: any): any[] => {
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", "items", "results", "contacts", "conversations", "messages", "leads"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.data?.[key])) return payload.data[key];
  }
  return [];
};

const digits = (value: unknown) => String(value || "").replace(/\D/g, "");
const samePhone = (a: unknown, b: unknown) => {
  const x = digits(a);
  const y = digits(b);
  return Boolean(x && y) && (x === y || x.slice(-9) === y.slice(-9));
};

let contactsCache: { at: number; byPhone: Map<string, string> } | null = null;

/** Telefono (ultimos 9 digitos) → id de contacto. El CRM no filtra por telefono: se pagina todo (cache 10 min). */
async function contactsByPhone() {
  if (contactsCache && Date.now() - contactsCache.at < 10 * 60 * 1000) return contactsCache.byPhone;
  const byPhone = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < 40; page += 1) {
    const payload: any = await crmGet("/contacts", { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!payload) break;
    for (const contact of rows(payload)) if (digits(contact.phone)) byPhone.set(digits(contact.phone).slice(-9), String(contact.id));
    cursor = payload.next_cursor || undefined;
    if (!cursor) break;
  }
  contactsCache = { at: Date.now(), byPhone };
  return byPhone;
}

export async function crmContactId(phone: string): Promise<string | null> {
  return (await contactsByPhone()).get(digits(phone).slice(-9)) || null;
}

/** Clave para comparar textos del bot con los del CRM (sin emojis, espacios ni asteriscos). */
export const textKey = (text: unknown) =>
  String(text || "")
    .normalize("NFD")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .slice(0, 80);

/**
 * El CRM marca como "AGENT" tanto a Mila como a la persona que atiende. Es de
 * una PERSONA si no es un texto que mando el bot (`botTexts`, de la bitacora).
 */
export function isHumanAgentMessage(message: any, botTexts: Set<string>) {
  if (String(message.sender || "").toUpperCase() !== "AGENT" || message.is_private) return false;
  const key = textKey(message.content);
  if (!key) return message.message_type !== "TEXT"; // foto, audio o ubicacion que manda el asesor
  return ![...botTexts].some((bot) => bot.startsWith(key.slice(0, 40)) || key.startsWith(bot.slice(0, 40)));
}

/**
 * Primera respuesta de una persona del equipo entre `since` y `until`.
 * null = no se pudo saber (sin llave, CRM caido o el contacto no esta en el CRM); { at: null } = nadie respondio.
 */
export async function firstAgentReply(phone: string, since: Date, until: Date, botTexts: Set<string>): Promise<{ at: Date | null } | null> {
  if (!crmEnabled()) return null;
  const contactId = await crmContactId(phone);
  if (!contactId) return null;
  const conversations = rows(await crmGet("/conversations", { contact_id: contactId }));
  if (!conversations.length) return null;
  let first: Date | null = null;
  for (const conversation of conversations) {
    const messages = rows(await crmGet(`/conversations/${conversation.id}/messages`, { limit: 500 }));
    for (const message of messages) {
      const at = new Date(message.created_at);
      if (at > since && at <= until && isHumanAgentMessage(message, botTexts) && (!first || at < first)) first = at;
    }
  }
  return { at: first };
}

/** Prueba de conexion para el panel: cuantos contactos y columnas ve la llave. */
export async function crmHealth() {
  if (!crmEnabled()) return { enabled: false, ok: false, message: "Falta BUILDERBOT_CRM_API_KEY en Vercel" };
  const [contacts, columns] = await Promise.all([crmGet("/contacts", { limit: 1 }), crmGet("/leads/columns")]);
  return {
    enabled: true,
    ok: contacts !== null,
    message: contacts !== null ? "Conectado al CRM" : "El CRM rechazó la llave o no responde",
    columns: rows(columns).map((column) => ({ id: String(column.id || column._id), name: String(column.name || "") })),
  };
}
