import axios from "axios";

/**
 * Fotos de productos como IMAGEN de WhatsApp (no como link), por la API de
 * mensajes del bot en BuilderBot Cloud: POST /api/v2/{proyecto}/messages con
 * messages.mediaUrl. Solo se usa al responder un mensaje del cliente (dentro de
 * la ventana de 24 h), nunca para escribir primero.
 *
 * Credenciales en env (nunca en el codigo):
 *   BUILDERBOT_BOT_API_KEY  → llave del proyecto (bb-…), Ajustes > Desarrollador (REST)
 *   BUILDERBOT_PROJECT_ID   → id del bot (por defecto el de Megaprinter)
 *
 * Nunca lanza: devuelve las fotos que NO salieron (sin llave, todas). Esas van
 * como link dentro del mensaje para que el cliente igual las vea.
 */

const PROJECT = () => process.env.BUILDERBOT_PROJECT_ID || "62156346-df34-41ee-844c-666010c06787";

export const photosEnabled = () => Boolean(process.env.BUILDERBOT_BOT_API_KEY);

/** BuilderBot quiere el numero sin "+" ni sufijo de WhatsApp. */
const toNumber = (phone: string) => phone.replace(/@.*$/, "").replace(/\D/g, "");

type Photo = { url: string; caption: string };

export async function sendProductPhotos(phone: string, images: Photo[]): Promise<Photo[]> {
  if (!photosEnabled() || !images.length || !toNumber(phone)) return images;
  const startedAt = Date.now();
  // En orden (la foto 1 antes que la 2) y con tope de tiempo: BuilderBot espera la respuesta del flujo.
  for (const [index, image] of images.entries()) {
    if (Date.now() - startedAt > 12000) return images.slice(index);
    try {
      await axios.post(
        `https://app.builderbot.cloud/api/v2/${PROJECT()}/messages`,
        { messages: { content: image.caption, mediaUrl: image.url }, number: toNumber(phone), checkIfExists: false },
        { headers: { "x-api-builderbot": process.env.BUILDERBOT_BOT_API_KEY }, timeout: 8000 },
      );
    } catch (error: any) {
      console.error(`[bot] ${phone} 📷 foto no enviada:`, error?.response?.status, error?.response?.data || error?.message);
      return images.slice(index);
    }
  }
  return [];
}
