import axios from "axios";

/**
 * Cliente minimo de Gemini (REST, sin SDK), igual que en Sorbito y Boloncity.
 * Devuelve el JSON que pide el prompt o `null` si no hay llave, si tarda o si
 * la respuesta no se puede leer: quien llama siempre tiene un plan B.
 */

export const geminiEnabled = () => Boolean(process.env.GEMINI_API_KEY);

const geminiModel = () => process.env.GEMINI_MODEL || "gemini-2.5-flash";

interface GeminiJsonRequest {
  system: string;
  text: string;
  image?: { mimeType: string; base64: string };
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export async function geminiJson<T = any>(request: GeminiJsonRequest): Promise<T | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const parts: any[] = [{ text: request.text }];
  if (request.image) parts.push({ inline_data: { mime_type: request.image.mimeType, data: request.image.base64 } });

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent?key=${encodeURIComponent(key)}`,
      {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          maxOutputTokens: request.maxOutputTokens ?? 800,
          // Sin "thinking": cada segundo cuenta contra el timeout de BuilderBot.
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      { timeout: request.timeoutMs ?? 12000 },
    );
    const text: string =
      response.data?.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("") || "";
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    return json ? (JSON.parse(json) as T) : null;
  } catch (error: any) {
    console.error("[gemini] fallo la llamada:", error?.response?.data?.error?.message || error?.message || error);
    return null;
  }
}
