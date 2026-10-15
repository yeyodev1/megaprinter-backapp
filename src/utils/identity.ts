/**
 * Normalizacion de los datos con los que se entra al panel. El tecnico puede
 * escribir su WhatsApp como "099 123 4567", "+593 99 123 4567" o "593991234567":
 * todo termina en el mismo formato guardado (+5939XXXXXXXX).
 */

export const normalizeEmail = (value: unknown) => String(value ?? "").trim().toLowerCase();

export function normalizePhone(value: unknown) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  // Celulares de Ecuador: 09XXXXXXXX, 9XXXXXXXX, 5939XXXXXXXX o 59309XXXXXXXX.
  if (/^0?9\d{8}$/.test(digits)) return `+593${digits.slice(-9)}`;
  if (/^5930?9\d{8}$/.test(digits)) return `+593${digits.slice(-9)}`;
  // Numero de otro pais: se guarda con + tal cual.
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : "";
}

/** Cedula (10 digitos), RUC o pasaporte: sin espacios ni guiones, en mayusculas. */
export const normalizeCedula = (value: unknown) => String(value ?? "").replace(/[\s.-]/g, "").toUpperCase();

export const isValidCedula = (value: string) => /^[0-9A-Z]{6,13}$/.test(value);

export const isEcuadorMobile = (value: string) => /^\+5939\d{8}$/.test(value);
