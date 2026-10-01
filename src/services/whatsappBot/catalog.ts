/**
 * Catalogo del bot: productos activos de Mongo y busqueda por palabras.
 * Sin Mongo aqui: el controlador inyecta `loadCatalog` para que las pruebas
 * usen un catalogo fijo.
 */

export interface BotProduct {
  id: string;
  name: string;
  price: number;
  originalPrice: number | null;
  category: string;
  kind: "product" | "service";
  description: string;
  specs: string;
}

export const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const STOPWORDS = new Set(
  "a al algo alguna alguno buen buena busco con cual cuanto cuesta de del el en es esa ese esta este hay la las lo los me mas necesito para por precio que quiero se si su tiene tienen tienes un una uno unos y o porfa favor hola gracias dame quisiera".split(" "),
);

/** Sinonimos frecuentes en Ecuador -> palabra que aparece en el catalogo. */
const SYNONYMS: Record<string, string> = {
  laptop: "laptop",
  laptops: "laptop",
  portatil: "laptop",
  portatiles: "laptop",
  notebook: "laptop",
  computadora: "laptop",
  compu: "laptop",
  pc: "all in one",
  allinone: "all in one",
  aio: "all in one",
  impresora: "impresora",
  impresoras: "impresora",
  multifuncion: "impresora",
  monitor: "monitor",
  monitores: "monitor",
  pantalla: "monitor",
  camara: "camara",
  camaras: "camara",
  ram: "ram",
  disco: "ssd",
};

export function tokens(text: string) {
  return normalize(text)
    .split(" ")
    .map((word) => SYNONYMS[word] || word)
    .flatMap((word) => word.split(" "))
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/** Puntaje de un producto para una busqueda: palabras en el nombre pesan mas que en specs. */
function score(product: BotProduct, queryTokens: string[]) {
  const name = normalize(product.name);
  const category = normalize(product.category);
  const rest = normalize(`${product.specs} ${product.description}`);
  let total = 0;
  let matched = 0;
  for (const token of queryTokens) {
    const pattern = new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    if (pattern.test(name)) {
      total += 3;
      matched += 1;
    } else if (pattern.test(category)) {
      total += 2;
      matched += 1;
    } else if (pattern.test(rest)) {
      total += 1;
      matched += 1;
    }
  }
  return { total, matched };
}

/** Productos que mejor coinciden con lo que escribio el cliente. */
export function searchProducts(catalog: BotProduct[], query: string, limit = 5) {
  const queryTokens = tokens(query);
  if (!queryTokens.length) return [];
  const ranked = catalog
    .map((product) => ({ product, ...score(product, queryTokens) }))
    .filter((entry) => entry.matched > 0)
    // Todas las palabras del cliente deben aparecer si escribio dos o menos;
    // con mas palabras se tolera que falte una ("laptop hp 16gb negra").
    .filter((entry) => entry.matched >= Math.max(1, queryTokens.length - (queryTokens.length > 2 ? 1 : 0)))
    .sort((a, b) => b.total - a.total || a.product.price - b.product.price);
  return ranked.slice(0, limit).map((entry) => entry.product);
}

export const money = (value: number) => `$${value.toFixed(2)}`;

export function productLine(product: BotProduct, index?: number) {
  const prefix = index != null ? `*${index}.* ` : "• ";
  const offer = product.originalPrice && product.originalPrice > product.price ? ` ~${money(product.originalPrice)}~` : "";
  return `${prefix}${product.name} — *${money(product.price)}*${offer}`;
}

/** Resumen del catalogo por categoria, para "que tienen" o "catalogo". */
export function catalogOverview(catalog: BotProduct[], storeUrl: string) {
  const byCategory = new Map<string, BotProduct[]>();
  for (const product of catalog.filter((item) => item.kind === "product")) {
    byCategory.set(product.category, [...(byCategory.get(product.category) || []), product]);
  }
  const lines = [...byCategory.entries()].map(([category, products]) => {
    const from = Math.min(...products.map((product) => product.price));
    return `• *${category}*: ${products.length} modelos desde ${money(from)}`;
  });
  return [
    "Esto es lo que tenemos en tienda 🖨️💻",
    "",
    ...lines,
    "",
    `Dime qué buscas (ej. "laptop para la U", "impresora de tinta continua") y te muestro opciones. También puedes ver todo en ${storeUrl}/products`,
  ].join("\n");
}
