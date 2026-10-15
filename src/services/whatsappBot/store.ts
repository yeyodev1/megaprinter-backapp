import { StoreSettingsModel } from "../../models/storeSettings.model";

/**
 * Datos de la tienda. Las sucursales (direccion, link de Maps y horarios) las
 * edita el equipo en el panel (Sistema → Sucursales) y viven en Mongo; aqui
 * quedan los valores por defecto (los que paso Johnny el 15-oct-2026) por si la
 * base no responde. El bot las responde con reglas y se las pasa a la IA para
 * que nunca invente sucursales, horarios ni redes (llego a decir "dos sucursales en Quito").
 */
export interface StoreBranch {
  name: string;
  address: string;
  mapsUrl: string;
  hours: Array<{ days: string; time: string }>;
  active: boolean;
}

export interface StoreInfo {
  city: string;
  branches: StoreBranch[];
}

const WEEKDAYS = { days: "Lunes a Viernes", time: "8:30 AM – 7:00 PM" };
const SATURDAY = { days: "Sábado", time: "9:00 AM – 5:00 PM" };

export const DEFAULT_STORE: StoreInfo = {
  city: "Guayaquil",
  branches: [
    {
      name: "Sucursal 1",
      address: "Av. Tungurahua 103, entre Luis Vernaza y Padre Solano",
      mapsUrl: "https://maps.app.goo.gl/whLgVu9tGFrCfpd37",
      hours: [WEEKDAYS, SATURDAY],
      active: true,
    },
    {
      name: "Sucursal 2",
      address: "Av. Tungurahua 205 y Luis Urdaneta",
      mapsUrl: "https://maps.app.goo.gl/RTPBZoKzijt7rzub9",
      hours: [WEEKDAYS, SATURDAY, { days: "Domingo", time: "10:00 AM – 2:00 PM" }],
      active: true,
    },
  ],
};

export const STORE = {
  instagram: "@megaprinter.ec",
  instagramUrl: "https://www.instagram.com/megaprinter.ec/",
  email: "info@megaprinter.ec",
};

let current: StoreInfo = DEFAULT_STORE;
let loadedAt = 0;
const CACHE_MS = 60 * 1000;

/** Sucursales vigentes (las ultimas que se leyeron de la base). */
export const currentStore = () => current;

/** Copia limpia de lo que viene de la base o del panel. */
export function sanitizeStore(input: any): StoreInfo {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const branches = (Array.isArray(input?.branches) ? input.branches : []).map((branch: any) => ({
    name: text(branch?.name),
    address: text(branch?.address),
    mapsUrl: text(branch?.mapsUrl),
    hours: (Array.isArray(branch?.hours) ? branch.hours : [])
      .map((line: any) => ({ days: text(line?.days), time: text(line?.time) }))
      .filter((line: { days: string; time: string }) => line.days || line.time),
    active: branch?.active !== false,
  }));
  return { city: text(input?.city) || DEFAULT_STORE.city, branches };
}

/**
 * Lee las sucursales de Mongo (cache 1 min). Nunca lanza: si la base falla o
 * nadie las ha guardado aun, quedan las por defecto.
 */
export async function loadStore(force = false): Promise<StoreInfo> {
  if (!force && Date.now() - loadedAt < CACHE_MS) return current;
  try {
    const doc: any = await StoreSettingsModel.findById("store").lean();
    const stored = doc ? sanitizeStore(doc) : null;
    current = stored && stored.branches.some((branch) => branch.active) ? stored : DEFAULT_STORE;
    loadedAt = Date.now();
  } catch (error) {
    console.error("[tienda] no se pudieron leer las sucursales:", error instanceof Error ? error.message : error);
  }
  return current;
}

/** Despues de guardar en el panel: el bot usa los datos nuevos al instante (en esta instancia). */
export const setStore = (store: StoreInfo) => {
  current = store.branches.some((branch) => branch.active) ? store : DEFAULT_STORE;
  loadedAt = Date.now();
};

const activeBranches = () => current.branches.filter((branch) => branch.active);

/** Lo que el bot responde cuando piden la direccion o la ubicacion: cada sucursal con su link de Maps y horarios. */
export const storeInfoText = () =>
  activeBranches()
    .map((branch) =>
      [
        `📍 *${branch.name}*`,
        `📌 ${branch.address}, ${current.city}`,
        ...(branch.mapsUrl ? [branch.mapsUrl] : []),
        ...branch.hours.map((line) => `🕒 ${line.days}: ${line.time}`),
      ].join("\n"),
    )
    .join("\n\n");

/** Solo horarios ("a qué hora cierran?"). */
export const storeHoursText = () =>
  [
    "🕒 Nuestros horarios:",
    ...activeBranches().flatMap((branch) => [``, `📍 *${branch.name}* (${branch.address})`, ...branch.hours.map((line) => `• ${line.days}: ${line.time}`)]),
  ].join("\n");

/** Resumen en una linea para el prompt de la IA. */
export const storeFactsForPrompt = () =>
  `Tienda en ${current.city}: ${activeBranches()
    .map((branch) => `${branch.name}: ${branch.address} (${branch.hours.map((line) => `${line.days} ${line.time}`).join("; ")})`)
    .join(" / ")}. Instagram ${STORE.instagram} (${STORE.instagramUrl}). Correo ${STORE.email}. No hay otras sucursales.`;
