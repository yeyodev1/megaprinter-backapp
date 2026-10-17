import { PhotoMatchModel } from "../../models/photoMatch.model";

/**
 * APRENDIZAJE DE LA VISTA (fotos de productos).
 *
 * Cada foto de producto queda guardada con lo que propuso la IA. Si el cliente
 * elige uno de esos productos queda "confirmada"; si el equipo dice en el panel
 * cual era, "corregida". Las ultimas se pasan como ejemplos al analizar la
 * siguiente foto, asi la IA repite los aciertos y no los errores.
 */

export interface PhotoExample {
  description: string;
  /** Producto correcto; null = no esta en el catalogo. */
  productId: string | null;
  /** Lo que la IA propuso y no era. */
  wrongIds: string[];
}

const MAX_EXAMPLES = 40;
const CACHE_MS = 60 * 1000;
let examples: PhotoExample[] = [];
let loadedAt = 0;

/** Ejemplos para el prompt de la vista (cache 1 min). Nunca lanza. */
export async function loadPhotoExamples(): Promise<PhotoExample[]> {
  if (Date.now() - loadedAt < CACHE_MS) return examples;
  try {
    const docs: any[] = await PhotoMatchModel.find({ status: { $in: ["confirmada", "corregida"] }, description: { $ne: "" } })
      .sort({ updatedAt: -1 })
      .limit(MAX_EXAMPLES)
      .lean();
    examples = docs.map((doc) => {
      const productId = doc.productId ? String(doc.productId) : null;
      return { description: doc.description, productId, wrongIds: (doc.suggestedIds || []).map(String).filter((id: string) => id !== productId) };
    });
    loadedAt = Date.now();
  } catch (error) {
    console.error("[vista] no se pudieron leer los ejemplos:", error instanceof Error ? error.message : error);
  }
  return examples;
}

export const photoExamplesChanged = () => {
  loadedAt = 0;
};

/** Guarda la foto y lo que vio la IA. Devuelve el id ("" si falla: nunca frena la respuesta). */
export async function recordPhoto(input: { phone: string; imageUrl: string; description: string; searchQuery: string; suggestedIds: string[]; exactMatch: boolean }) {
  try {
    const doc = await PhotoMatchModel.create(input);
    return String(doc._id);
  } catch (error) {
    console.error("[vista] no se pudo guardar la foto:", error instanceof Error ? error.message : error);
    return "";
  }
}

/** El cliente eligio un producto de la lista que salio de su foto. No pisa una correccion del equipo. */
export async function confirmPhotoByCustomer(photoMatchId: string, productId: string) {
  try {
    await PhotoMatchModel.updateOne({ _id: photoMatchId, status: "sugerida" }, { $set: { productId, status: "confirmada", confirmedBy: "cliente" } });
    photoExamplesChanged();
  } catch (error) {
    console.error("[vista] no se pudo confirmar la foto:", error instanceof Error ? error.message : error);
  }
}
