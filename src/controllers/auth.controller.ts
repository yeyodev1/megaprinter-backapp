import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { NextFunction, Request, Response } from "express";
import { UserModel } from "../models/user.model";
import { AdminRequest } from "../middlewares/admin.middleware";

const userDto = (user: { _id: { toString(): string }; name: string; email: string; role: string; createdAt?: Date }) => ({ id: user._id.toString(), name: user.name, email: user.email, role: user.role, createdAt: user.createdAt });

export async function ensureInitialAdmin() {
  const email = process.env.INITIAL_ADMIN_EMAIL;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!email || !password) throw new Error("INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD are required");
  if (await UserModel.exists({ email: email.toLowerCase() })) return;
  await UserModel.create({ name: "Diego Reyes", email, passwordHash: await bcrypt.hash(password, 12), role: "admin" });
  console.log(`Initial admin created: ${email}`);
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body;
    const secret = process.env.JWT_SECRET;
    if (!email || !password || !secret) return res.status(400).json({ error: "Email and password are required" });
    const user = await UserModel.findOne({ email: String(email).toLowerCase() });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: "Invalid credentials" });
    const token = jwt.sign({ email: user.email, role: user.role }, secret, { subject: user._id.toString(), expiresIn: "8h" });
    res.json({ token, user: userDto(user) });
  } catch (error) { next(error); }
}

export async function listUsers(_req: AdminRequest, res: Response, next: NextFunction) {
  try { res.json((await UserModel.find().sort({ createdAt: -1 })).map(userDto)); } catch (error) { next(error); }
}

export async function createUser(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password || String(password).length < 10) return res.status(400).json({ error: "Name, email, and a 10 character password are required" });
    const user = await UserModel.create({ name, email: String(email).toLowerCase(), passwordHash: await bcrypt.hash(password, 12), role: "admin" });
    res.status(201).json(userDto(user));
  } catch (error) { next(error); }
}
