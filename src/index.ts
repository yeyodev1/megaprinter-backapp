import dotenv from "dotenv";
import { dbConnect } from "./config/mongo";
import { createApp } from "./app";
import { ensureInitialAdmin } from "./controllers/auth.controller";

const port = process.env.PORT || 8101;

async function main() {
  dotenv.config();
  await dbConnect();
  await ensureInitialAdmin();

  const { app, server } = createApp();

  server.timeout = 10 * 60 * 1000;

  server.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

main();
