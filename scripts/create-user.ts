/**
 * Crea (o actualiza la contraseña de) un acceso al panel sin pasar por la UI:
 *
 *   pnpm user:create -- correo@megaprinter.ec "contraseña" "Nombre visible"
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { dbConnect } from "../src/config/mongo";
import { UserModel } from "../src/models/user.model";

async function main() {
  const [email, password, name = "Equipo Megaprinter"] = process.argv.slice(2);
  if (!email || !password) throw new Error("Uso: pnpm user:create -- <correo> <contraseña> [nombre]");
  if (password.length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres");

  await dbConnect();
  const normalisedEmail = email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, 12);

  const existing = await UserModel.findOne({ email: normalisedEmail });
  if (existing) {
    existing.passwordHash = passwordHash;
    existing.name = name;
    await existing.save();
    console.log(`Acceso actualizado: ${normalisedEmail}`);
  } else {
    await UserModel.create({ name, email: normalisedEmail, passwordHash, role: "admin" });
    console.log(`Acceso creado: ${normalisedEmail}`);
  }
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("Error creando el acceso:", error.message);
  process.exit(1);
});
