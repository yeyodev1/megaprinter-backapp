/**
 * Sincroniza la base de datos con `src/data/offersCatalog.ts` sin pasar por el
 * panel. Equivale al boton "Cargar ofertas base" pero se puede correr desde la
 * terminal tras actualizar el catalogo:
 *
 *   pnpm catalog:import
 */
import "dotenv/config";
import mongoose from "mongoose";
import { dbConnect } from "../src/config/mongo";
import { importOffersCatalog } from "../src/services/catalogImport.service";

const MAX_ATTEMPTS = 5;

const isNetworkError = (error: unknown) =>
  error instanceof Error && /MongoNetworkError|ECONNRESET|ETIMEDOUT|ServerSelection/.test(`${error.name} ${error.message}`);

async function main() {
  await dbConnect();

  // La importacion es idempotente, asi que ante un corte de red (Atlas suele
  // cerrar conexiones inactivas con ECONNRESET) se reintenta completa.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const summary = await importOffersCatalog();
      console.log(
        `Catalogo sincronizado: ${summary.imported} productos (${summary.created} nuevos, ${summary.updated} actualizados) en ${summary.categories} categorias.`,
      );
      break;
    } catch (error) {
      if (!isNetworkError(error) || attempt >= MAX_ATTEMPTS) throw error;
      console.warn(`Intento ${attempt} fallo por red (${(error as Error).message}); reintentando...`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("Error importando el catalogo:", error);
  process.exit(1);
});
