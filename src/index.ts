// dotenv debe ejecutarse antes que cualquier otro import lea `process.env`.
// Antes se llamaba dentro de `main()`, pero `const port = process.env.PORT` se
// evaluaba al cargar el modulo, asi que el PORT del .env se ignoraba siempre.
import "dotenv/config";

import { dbConnect } from "./config/mongo";
import { createApp } from "./app";
import { ensureInitialAdmin } from "./controllers/auth.controller";

const MAX_PORT_ATTEMPTS = 10;

async function main() {
  const basePort = Number(process.env.PORT) || 8101;

  await dbConnect();
  await ensureInitialAdmin();

  const { server } = createApp();

  server.timeout = 10 * 60 * 1000;

  // Si el puerto esta ocupado se prueba el siguiente en vez de morir con
  // EADDRINUSE, igual que hace Vite en el frontend.
  let attempt = 0;

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE" || attempt >= MAX_PORT_ATTEMPTS) {
      console.error("Server error:", error);
      process.exit(1);
    }
    attempt += 1;
    const nextPort = basePort + attempt;
    console.warn(`Puerto ${nextPort - 1} ocupado, intentando en ${nextPort}...`);
    server.listen(nextPort);
  });

  server.on("listening", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : basePort;
    console.log(`Server running on port ${port}`);
  });

  server.listen(basePort);
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
