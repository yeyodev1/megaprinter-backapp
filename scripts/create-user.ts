/**
 * Crea (o actualiza la contraseña de) un acceso al panel sin pasar por la UI:
 *
 *   pnpm user:create -- correo@megaprinter.ec "contraseña" "Nombre visible"
 *
 * Técnicos (entran con WhatsApp, cédula o correo y solo ven los tickets):
 *
 *   pnpm user:create -- --rol tecnico --whatsapp 0991234567 --cedula 0912345678 "contraseña" "Nombre"
 *   pnpm user:create -- --rol tecnico tecnico@megaprinter.ec "contraseña" "Nombre"
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { dbConnect } from "../src/config/mongo";
import { USER_ROLES, UserModel, UserRole, migrateUserIndexes } from "../src/models/user.model";
import { isValidCedula, normalizeCedula, normalizeEmail, normalizePhone } from "../src/utils/identity";

const USAGE =
  "Uso: pnpm user:create -- [--rol admin|tecnico] [--whatsapp <número>] [--cedula <cédula>] [--correo <correo>] [<correo>] <contraseña> [nombre]";

/** Separa `--flag valor` (o `--flag=valor`) de los argumentos sueltos. */
function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    flags[key] = inline ?? argv[++index] ?? "";
  }
  return { flags, positional };
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  // Compatibilidad con el uso original: el primer argumento suelto con @ es el correo.
  const emailArg = positional[0]?.includes("@") ? positional.shift() : undefined;
  const [password, name = "Equipo Megaprinter"] = positional;

  const role = (flags.rol || flags.role || "admin") as UserRole;
  const email = normalizeEmail(flags.correo || flags.email || emailArg);
  const phone = normalizePhone(flags.whatsapp || flags.phone);
  const cedula = normalizeCedula(flags.cedula);

  if (!USER_ROLES.includes(role)) throw new Error(`Rol no válido: ${role}. Usa admin o tecnico`);
  if (!password) throw new Error(USAGE);
  if (password.length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres");
  if ((flags.whatsapp || flags.phone) && !phone) throw new Error("El WhatsApp no es válido. Ej.: 0991234567");
  if (cedula && !isValidCedula(cedula)) throw new Error("La cédula no es válida");
  if (role === "admin" && !email) throw new Error("Un admin necesita correo. " + USAGE);
  if (!email && !phone && !cedula) throw new Error("Indica correo, --whatsapp o --cedula. " + USAGE);

  await dbConnect();
  await migrateUserIndexes();
  const passwordHash = await bcrypt.hash(password, 12);
  const identity = { ...(email ? { email } : {}), ...(phone ? { phone } : {}), ...(cedula ? { cedula } : {}) };
  const label = email || phone || cedula;

  const existing = await UserModel.findOne({ $or: Object.entries(identity).map(([key, value]) => ({ [key]: value })) });
  if (existing) {
    // El rol solo cambia si se pide con --rol: actualizar la clave no degrada a nadie.
    existing.set({ ...identity, passwordHash, name, active: true, ...(flags.rol || flags.role ? { role } : {}) });
    await existing.save();
    console.log(`Acceso actualizado (${existing.role}): ${label}`);
  } else {
    await UserModel.create({ ...identity, name, passwordHash, role, active: true });
    console.log(`Acceso creado (${role}): ${label}`);
  }
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("Error creando el acceso:", error.message);
  process.exit(1);
});
