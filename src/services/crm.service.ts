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
      headers: { "X-Tenant-ID": TENANT(), "X-API-Key": process.env.BUILDERBOT_CRM_API_KEY!, "x-api-key": process.env.BUILDERBOT_CRM_API_KEY! },
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

const contactCache = new Map<string, { at: number; id: string | null }>();

/** Id del contacto del CRM para un telefono (cache de 10 min). */
export async function crmContactId(phone: string): Promise<string | null> {
  const cached = contactCache.get(phone);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.id;
  let id: string | null = null;
  // Primero filtrando; si el CRM ignora el filtro, se revisan las primeras paginas.
  for (const params of [{ phone: digits(phone) }, { search: digits(phone) }, { q: digits(phone) }]) {
    const found = rows(await crmGet("/contacts", { ...params, limit: 50 })).find((contact) => samePhone(contact.phone || contact.phone_number || contact.wa_id, phone));
    if (found) {
      id = String(found.id || found._id);
      break;
    }
  }
  contactCache.set(phone, { at: Date.now(), id });
  return id;
}

const messageDate = (message: any) => new Date(message.created_at || message.createdAt || message.timestamp || message.date || 0);

/**
 * Mensaje de una PERSONA del equipo (no del cliente ni del bot). El CRM marca
 * quien escribio con distintos campos segun la version; se aceptan los comunes.
 */
export function isAgentMessage(message: any) {
  const from = String(message.sender_type || message.senderType || message.author_type || message.role || message.direction || message.type || "").toLowerCase();
  if (/bot|system|automat/.test(from) || message.is_bot === true) return false;
  if (/agent|user|human|operator|staff|asesor/.test(from)) return true;
  return Boolean(message.agent_id || message.assignee_id || message.user_id || message.sender_id) && !/contact|customer|incoming|inbound/.test(from);
}

/**
 * Primera respuesta de una persona del equipo despues de `since`.
 * null = no se pudo saber (sin llave o CRM caido); { at: null } = nadie respondio.
 */
export async function firstAgentReply(phone: string, since: Date, until: Date): Promise<{ at: Date | null } | null> {
  if (!crmEnabled()) return null;
  const contactId = await crmContactId(phone);
  if (!contactId) return null;
  const conversations = rows(await crmGet("/conversations", { contact_id: contactId, limit: 20 }));
  let first: Date | null = null;
  for (const conversation of conversations) {
    const messages = rows(await crmGet(`/conversations/${conversation.id || conversation._id}/messages`, { limit: 200 }));
    for (const message of messages) {
      const at = messageDate(message);
      if (at >= since && at <= until && isAgentMessage(message) && (!first || at < first)) first = at;
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
