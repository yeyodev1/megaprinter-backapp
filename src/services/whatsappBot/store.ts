/**
 * Datos fijos de la tienda (mismos que megaprinter-frontapp/src/config/brand.ts).
 * El bot los responde con reglas y se los pasa a la IA para que nunca invente
 * sucursales, horarios ni redes (en produccion llego a decir "dos sucursales en Quito").
 */
export const STORE = {
  city: "Guayaquil",
  locations: ["Tungurahua 103 y Padre Solano", "Tungurahua 205 y Luis Urdaneta"],
  hours: [
    "Lunes a viernes: 08:30 – 19:00",
    "Sábados: 09:00 – 17:00",
    "Domingos: 10:00 – 14:00 (solo en Tungurahua 205)",
  ],
  instagram: "@megaprinter.ec",
  instagramUrl: "https://www.instagram.com/megaprinter.ec/",
  email: "info@megaprinter.ec",
};

export const storeInfoText = () =>
  [
    `Estamos en *${STORE.city}* 📍`,
    ...STORE.locations.map((location) => `• ${location}`),
    "",
    "🕒 *Horarios*",
    ...STORE.hours.map((line) => `• ${line}`),
  ].join("\n");

/** Resumen en una linea para el prompt de la IA. */
export const storeFactsForPrompt = () =>
  `Tienda en ${STORE.city}: ${STORE.locations.join(" / ")}. Horarios: ${STORE.hours.join("; ")}. Instagram ${STORE.instagram} (${STORE.instagramUrl}). Correo ${STORE.email}. No hay otras sucursales.`;
