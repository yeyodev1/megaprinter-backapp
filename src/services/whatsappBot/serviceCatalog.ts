import { BotProduct, normalize, searchProducts } from "./catalog";

/**
 * SERVICIO TECNICO: equipo, problema y precio sugerido.
 *
 * Primero se busca en los servicios cargados en el catalogo (kind "service");
 * si no hay uno que encaje, se usa una tabla referencial del mercado de
 * Guayaquil/Ecuador (USD, mano de obra, sin repuestos). El diagnostico es sin
 * costo y el tecnico confirma el precio: el bot siempre lo aclara.
 */

export const DEVICES = [
  { key: "impresora", label: "Impresora", emoji: "🖨️", words: ["impresora", "impresoras", "multifuncion", "plotter", "epson", "canon", "brother", "ricoh", "kyocera"] },
  { key: "laptop", label: "Laptop", emoji: "💻", words: ["laptop", "laptops", "portatil", "notebook", "macbook"] },
  { key: "pc", label: "PC o all in one", emoji: "🖥️", words: ["pc", "computadora", "computador", "cpu", "escritorio", "all in one", "aio", "torre"] },
  { key: "monitor", label: "Monitor", emoji: "🖥️", words: ["monitor", "monitores"] },
  { key: "camara", label: "Cámaras de seguridad", emoji: "📹", words: ["camara", "camaras", "dvr", "nvr", "cctv"] },
] as const;

export type DeviceKey = (typeof DEVICES)[number]["key"];

export function detectDevice(text: string): DeviceKey | "" {
  const value = ` ${normalize(text)} `;
  return DEVICES.find((device) => device.words.some((word) => value.includes(` ${word} `)))?.key || "";
}

export const deviceLabel = (key: string) => DEVICES.find((device) => device.key === key)?.label || key || "Equipo";
export const deviceEmoji = (key: string) => DEVICES.find((device) => device.key === key)?.emoji || "🛠️";

interface PriceRule {
  device: DeviceKey | "*";
  key: string;
  label: string;
  words: string[];
  min: number;
  max: number;
}

const RULES: PriceRule[] = [
  { device: "impresora", key: "cabezal", label: "Limpieza de cabezal (no imprime bien)", words: ["cabezal", "no imprime", "raya", "rayas", "manchas", "colores", "en blanco", "imprime mal", "borroso", "falta color"], min: 20, max: 35 },
  { device: "impresora", key: "almohadillas", label: "Reseteo de almohadillas", words: ["almohadilla", "almohadillas", "parpadea", "luces", "reset", "resetear"], min: 10, max: 20 },
  { device: "impresora", key: "atasco", label: "Atasco de papel o rodillos", words: ["atasca", "atasco", "no jala", "no coge", "no toma", "rodillo", "rodillos"], min: 15, max: 35 },
  { device: "impresora", key: "tinta_continua", label: "Instalación de tinta continua", words: ["tinta continua", "sistema de tinta"], min: 25, max: 40 },
  { device: "impresora", key: "no_enciende", label: "No enciende (fuente o tarjeta)", words: ["no enciende", "no prende", "no arranca", "tarjeta", "fuente"], min: 35, max: 90 },
  { device: "impresora", key: "mantenimiento", label: "Mantenimiento y limpieza", words: ["mantenimiento", "limpieza", "limpiar", "revision", "revisar"], min: 15, max: 25 },
  { device: "laptop", key: "pantalla", label: "Cambio de pantalla (más el repuesto)", words: ["pantalla", "display", "rota", "rajada", "lineas"], min: 60, max: 150 },
  { device: "laptop", key: "teclado", label: "Cambio de teclado", words: ["teclado", "teclas"], min: 35, max: 70 },
  { device: "laptop", key: "bateria", label: "Batería o carga", words: ["bateria", "no carga", "cargador", "carga"], min: 30, max: 80 },
  { device: "laptop", key: "no_enciende", label: "No enciende (placa)", words: ["no enciende", "no prende", "no arranca", "placa", "se mojo", "agua"], min: 50, max: 150 },
  { device: "*", key: "datos", label: "Recuperación de información", words: ["recuperar", "informacion", "archivos", "fotos", "datos"], min: 40, max: 120 },
  { device: "*", key: "formateo", label: "Formateo e instalación de Windows", words: ["formatear", "formateo", "windows", "virus", "lenta", "lento", "se traba", "se cuelga", "pantallazo"], min: 25, max: 40 },
  { device: "*", key: "upgrade", label: "Instalación de SSD o RAM (más la pieza)", words: ["ssd", "ram", "memoria", "disco", "ampliar", "mejorar"], min: 10, max: 20 },
  { device: "pc", key: "no_enciende", label: "No enciende (fuente o placa)", words: ["no enciende", "no prende", "no arranca", "fuente", "placa"], min: 35, max: 90 },
  { device: "*", key: "mantenimiento", label: "Mantenimiento interno y limpieza", words: ["mantenimiento", "limpieza", "calienta", "ventilador", "ruido", "polvo"], min: 20, max: 35 },
  { device: "monitor", key: "monitor", label: "Revisión de monitor", words: ["no enciende", "pantalla", "lineas", "parpadea", "no da imagen"], min: 30, max: 80 },
  { device: "camara", key: "instalacion", label: "Instalación de cámaras (por cámara)", words: ["instalar", "instalacion", "poner", "colocar"], min: 25, max: 40 },
  { device: "camara", key: "camara_revision", label: "Revisión del sistema de cámaras", words: ["no graba", "no se ve", "sin imagen", "app", "celular", "revision"], min: 20, max: 35 },
];

const DEFAULTS: Record<DeviceKey, { label: string; min: number; max: number }> = {
  impresora: { label: "Revisión de impresora", min: 15, max: 35 },
  laptop: { label: "Revisión de laptop", min: 20, max: 60 },
  pc: { label: "Revisión de PC", min: 15, max: 50 },
  monitor: { label: "Revisión de monitor", min: 30, max: 80 },
  camara: { label: "Revisión de cámaras", min: 20, max: 40 },
};

export interface ServiceEstimate {
  category: string;
  label: string;
  priceMin: number | null;
  priceMax: number | null;
  priceSource: "catalogo" | "referencial" | "por_cotizar";
}

/** Precio sugerido para un equipo y su problema. */
export function estimateService(device: string, issue: string, catalog: BotProduct[] = []): ServiceEstimate {
  const services = catalog.filter((item) => item.kind === "service");
  const fromCatalog = services.length ? searchProducts(services, `${deviceLabel(device)} ${issue}`, 1)[0] : undefined;
  if (fromCatalog) {
    return { category: fromCatalog.name, label: fromCatalog.name, priceMin: fromCatalog.price, priceMax: fromCatalog.price, priceSource: "catalogo" };
  }
  const value = ` ${normalize(issue)} `;
  const rule = RULES.find((item) => (item.device === "*" || item.device === device) && item.words.some((word) => value.includes(` ${word}`)));
  if (rule) return { category: rule.key, label: rule.label, priceMin: rule.min, priceMax: rule.max, priceSource: "referencial" };
  const fallback = DEFAULTS[device as DeviceKey];
  if (fallback) return { category: "revision", label: fallback.label, priceMin: fallback.min, priceMax: fallback.max, priceSource: "referencial" };
  return { category: "otro", label: "Revisión", priceMin: null, priceMax: null, priceSource: "por_cotizar" };
}

export const priceText = (estimate: ServiceEstimate) =>
  estimate.priceMin === null
    ? "te cotizamos después del diagnóstico"
    : estimate.priceMin === estimate.priceMax
      ? `desde *$${estimate.priceMin.toFixed(2)}*`
      : `*$${estimate.priceMin} – $${estimate.priceMax}*`;
