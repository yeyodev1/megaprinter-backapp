import type { Request, Response } from "express";
import dotenv from "dotenv";
import { createApp } from "../src/app";
import { dbConnect } from "../src/config/mongo";
import { ensureInitialAdmin } from "../src/controllers/auth.controller";

dotenv.config();

const app = createApp().app;
let bootPromise: Promise<void> | undefined;

function boot() {
  bootPromise ??= (async () => {
    await dbConnect();
    await ensureInitialAdmin();
  })();
  return bootPromise;
}

export default async function handler(req: Request, res: Response) {
  await boot();
  app(req, res);
}
