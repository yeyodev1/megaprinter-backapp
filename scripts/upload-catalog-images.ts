/**
 * Sube a Cloudinary todas las imagenes de una carpeta local y escribe un JSON
 * `{ "<nombre-de-archivo-sin-extension>": "<url>" }` con las URLs resultantes.
 *
 *   pnpm catalog:upload -- ./ruta/a/imagenes [./salida.json]
 *
 * El `public_id` es determinista (`megaprinter/catalog/<slug>`), asi que volver
 * a subir la misma imagen la reemplaza en vez de acumular copias. Las URLs
 * devueltas incluyen `f_auto,q_auto`: Cloudinary entrega WebP/AVIF y ajusta la
 * compresion segun el navegador sin tocar el original.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import cloudinary from "../src/config/cloudinary";

const FOLDER = "megaprinter/catalog";
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);

async function main() {
  const [dir, output = "catalog-images.json"] = process.argv.slice(2);
  if (!dir) throw new Error("Uso: pnpm catalog:upload -- <carpeta-de-imagenes> [salida.json]");

  for (const key of ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) {
    if (!process.env[key]) throw new Error(`Falta la variable de entorno ${key}`);
  }

  const files = fs
    .readdirSync(dir)
    .filter((file) => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .sort();
  if (!files.length) throw new Error(`No hay imagenes en ${dir}`);

  const urls: Record<string, string> = {};

  for (const [index, file] of files.entries()) {
    const slug = path.basename(file, path.extname(file));
    const result = await cloudinary.uploader.upload(path.join(dir, file), {
      public_id: slug,
      folder: FOLDER,
      resource_type: "image",
      overwrite: true,
      invalidate: true,
    });

    urls[slug] = cloudinary.url(result.public_id, {
      secure: true,
      version: result.version,
      fetch_format: "auto",
      quality: "auto",
      // Sin esto el SDK agrega `?_a=...` (telemetria) a cada URL.
      analytics: false,
    });
    console.log(`[${index + 1}/${files.length}] ${slug} -> ${urls[slug]}`);
  }

  fs.writeFileSync(output, JSON.stringify(urls, null, 2) + "\n");
  console.log(`\n${files.length} imagenes subidas. URLs guardadas en ${output}`);
}

main().catch((error) => {
  console.error("Error subiendo imagenes:", error);
  process.exit(1);
});
