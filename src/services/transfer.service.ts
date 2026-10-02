import axios from "axios";
import { UploadApiResponse } from "cloudinary";
import cloudinary from "../config/cloudinary";
import { geminiJson } from "./gemini.service";
import { escapeHtml, sendStoreEmail } from "./email.service";
import { PaymentSettingsModel } from "../models/paymentSettings.model";
import { KNOWN_BANKS, bankLogo } from "./banks";

/**
 * Pagos por transferencia: datos de la cuenta, comprobantes y aviso al equipo.
 *
 * La cuenta y el interruptor viven en Mongo y se editan desde el panel
 * (/admin/payments). En Sorbito estaban escritos en cuatro lugares del codigo.
 */

/** Una cuenta para transferencias, tal como la carga el equipo en el panel. */
export interface BankAccount {
  id: string;
  bankCode: string;
  bank: string;
  accountType: string;
  accountNumber: string;
  accountHolder: string;
  holderId: string;
  logoUrl: string;
  active: boolean;
}

/** Datos de la cuenta que se le muestran al cliente (y se copian al pedido). */
export type BankDetails = Omit<BankAccount, "active">;

export interface TransferSettings {
  enabled: boolean;
  accounts: BankAccount[];
}

// Cache corto: el bot lee la configuracion en cada mensaje. Se limpia al guardar.
let cache: { at: number; value: TransferSettings } | null = null;
const CACHE_MS = 30_000;

const toAccount = (raw: any): BankAccount => ({
  id: String(raw._id || raw.id || ""),
  bankCode: raw.bankCode || "otro",
  bank: raw.bank || "",
  accountType: raw.accountType || "",
  accountNumber: raw.accountNumber || "",
  accountHolder: raw.accountHolder || "",
  holderId: raw.holderId || "",
  logoUrl: raw.logoUrl || bankLogo(raw.bankCode || ""),
  active: raw.active !== false,
});

export async function getTransferSettings(): Promise<TransferSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const doc: any = await PaymentSettingsModel.findById("payments").lean();
  const transfer = doc?.transfer || {};
  let accounts: BankAccount[] = (transfer.accounts || []).map(toAccount);
  // Formato anterior: una sola cuenta en campos sueltos.
  if (!accounts.length && transfer.accountNumber) accounts = [toAccount({ ...transfer, id: "legacy", bankCode: "otro" })];
  const value = { enabled: transfer.enabled === true, accounts };
  cache = { at: Date.now(), value };
  return value;
}

export async function saveTransferSettings(input: { enabled?: boolean; accounts?: any[] }, updatedBy: string) {
  const clean = (value: unknown, max = 120) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const accounts = (Array.isArray(input.accounts) ? input.accounts : []).slice(0, 12).map((raw) => {
    const bankCode = KNOWN_BANKS[clean(raw?.bankCode) as keyof typeof KNOWN_BANKS] ? clean(raw.bankCode) : "otro";
    const known = KNOWN_BANKS[bankCode as keyof typeof KNOWN_BANKS];
    return {
      ...(/^[a-f\d]{24}$/i.test(String(raw?.id || "")) ? { _id: raw.id } : {}),
      bankCode,
      bank: known ? known.name : clean(raw?.bank, 80),
      accountType: clean(raw?.accountType, 40),
      accountNumber: clean(raw?.accountNumber, 30).replace(/\s+/g, ""),
      accountHolder: clean(raw?.accountHolder, 100),
      holderId: clean(raw?.holderId, 13).replace(/\s+/g, ""),
      logoUrl: /^https:\/\//.test(clean(raw?.logoUrl, 500)) ? clean(raw.logoUrl, 500) : "",
      active: raw?.active !== false,
    };
  });
  await PaymentSettingsModel.updateOne(
    { _id: "payments" },
    {
      $set: { "transfer.enabled": input.enabled === true, "transfer.accounts": accounts, updatedBy },
      $unset: { "transfer.bank": 1, "transfer.accountType": 1, "transfer.accountNumber": 1, "transfer.accountHolder": 1, "transfer.holderId": 1 },
    },
    { upsert: true },
  );
  cache = null;
  return getTransferSettings();
}

const toDetails = ({ active: _active, ...details }: BankAccount): BankDetails => details;

/** Cuentas para OFRECER transferencia a pedidos nuevos: vacio si esta apagada. */
export async function activeBankAccounts(): Promise<BankDetails[]> {
  const settings = await getTransferSettings();
  if (!settings.enabled) return [];
  return settings.accounts.filter((account) => account.active && account.accountNumber).map(toDetails);
}

/** Todas las cuentas cargadas (para leer un comprobante o un pedido que ya existe). */
export async function allBankAccounts(): Promise<BankDetails[]> {
  return (await getTransferSettings()).accounts.filter((account) => account.accountNumber).map(toDetails);
}

export const transferEnabled = async () => (await activeBankAccounts()).length > 0;

/** Datos de UNA cuenta en formato WhatsApp. */
export function bankText(details: BankDetails) {
  return [
    details.bank && `🏦 *${details.bank}*`,
    details.accountType && `Cuenta ${details.accountType}`,
    `N.º *${details.accountNumber}*`,
    details.accountHolder && `A nombre de: ${details.accountHolder}`,
    details.holderId && `RUC/Cédula: ${details.holderId}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const RECEIPT_MIME = /^image\/(jpe?g|png|webp|heic|heif)$|^application\/pdf$/i;
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export interface ReceiptFile {
  buffer: Buffer;
  mimeType: string;
}

/** Descarga el archivo temporal que manda BuilderBot (sus URLs caducan). */
export async function downloadReceipt(url: string): Promise<ReceiptFile> {
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 15000,
    maxContentLength: MAX_RECEIPT_BYTES,
  });
  const mimeType = String(response.headers["content-type"] || "").split(";")[0].trim() || "image/jpeg";
  return { buffer: Buffer.from(response.data), mimeType };
}

export const isAcceptedReceipt = (mimeType: string) => RECEIPT_MIME.test(mimeType);

const VIDEO_EXT = /\.(mp4|mov|3gp|webm|mkv|avi)(\?|$)/i;
const AUDIO_EXT = /\.(ogg|opus|mp3|m4a|aac|wav|amr)(\?|$)/i;

/**
 * Tipo del archivo SIN descargarlo (un video puede pesar decenas de MB):
 * primero la extension de la URL, luego un HEAD. "" si no se sabe.
 */
export async function probeMediaKind(url: string): Promise<"video" | "audio" | ""> {
  if (VIDEO_EXT.test(url)) return "video";
  if (AUDIO_EXT.test(url)) return "audio";
  try {
    const response = await axios.head(url, { timeout: 5000 });
    const type = String(response.headers["content-type"] || "");
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
  } catch {
    /* algunos servidores no aceptan HEAD: se decide al descargar */
  }
  return "";
}

export const mediaKindFromMime = (mimeType: string): "video" | "audio" | "" =>
  mimeType.startsWith("video/") ? "video" : mimeType.startsWith("audio/") ? "audio" : "";

async function uploadReceipt(file: ReceiptFile, orderNumber: string): Promise<string> {
  const result = await new Promise<UploadApiResponse>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "megaprinter/receipts",
        public_id: `${orderNumber}-${Date.now()}`,
        resource_type: file.mimeType === "application/pdf" ? "raw" : "image",
      },
      (error, upload) => (error || !upload ? reject(error || new Error("Cloudinary upload failed")) : resolve(upload)),
    );
    stream.end(file.buffer);
  });
  return result.secure_url;
}

export interface ReceiptAnalysis {
  isReceipt: boolean | null;
  amountMatches: boolean | null;
  accountMatches: boolean | null;
  detectedAmount: number | null;
  detectedBank: string;
  detectedReference: string;
  summary: string;
}

const RECEIPT_PROMPT = `Eres asistente contable de Megaprinter (tienda de tecnología en Ecuador). Te muestran una imagen que un cliente envió como comprobante de transferencia o depósito.
Devuelve SOLO JSON: {"isReceipt":bool,"detectedAmount":number|null,"detectedAccount":"","detectedBank":"","detectedReference":"","summary":""}
- isReceipt: true solo si es un comprobante bancario real (transferencia, depósito o pago por app del banco). Fotos de productos, capturas de chat o imágenes borrosas = false.
- detectedAmount: monto transferido en dólares, con decimales. null si no se lee.
- detectedAccount: número de cuenta destino tal como aparece (puede venir enmascarado, ej. ****6030).
- detectedReference: número de comprobante, referencia o documento.
- summary: una frase en español para el equipo (banco, monto, fecha, destinatario). No apruebes ni rechaces: solo describe.`;

/**
 * Lectura del comprobante con Gemini. Solo ayuda al equipo a revisar: el pago
 * se aprueba a mano en el panel (Sorbito aprobaba solo con la IA).
 */
export async function analyzeReceipt(
  file: ReceiptFile,
  expected: { total: number; orderNumber: string; account?: BankDetails | null },
): Promise<ReceiptAnalysis | null> {
  if (!file.mimeType.startsWith("image/")) return null;
  // La cuenta que eligio el cliente; si no eligio, cualquiera de las cargadas.
  const candidates = expected.account ? [expected.account] : await allBankAccounts();
  const accountsText = candidates.map((account) => `${account.accountNumber} (${account.bank}, a nombre de ${account.accountHolder || "-"})`).join("; ");
  const parsed = await geminiJson<any>({
    system: RECEIPT_PROMPT,
    text: `Pedido ${expected.orderNumber}. Monto esperado: $${expected.total.toFixed(2)}. Cuenta(s) destino válidas: ${accountsText || "(no configurada)"}.`,
    image: { mimeType: file.mimeType, base64: file.buffer.toString("base64") },
    maxOutputTokens: 400,
    timeoutMs: 15000,
  });
  if (!parsed) return null;

  const detectedAmount = Number.isFinite(Number(parsed.detectedAmount)) && parsed.detectedAmount !== null
    ? Math.round(Number(parsed.detectedAmount) * 100) / 100
    : null;
  const accountDigits = String(parsed.detectedAccount || "").replace(/\D/g, "");

  return {
    isReceipt: typeof parsed.isReceipt === "boolean" ? parsed.isReceipt : null,
    amountMatches: detectedAmount === null ? null : Math.abs(detectedAmount - expected.total) < 0.01,
    // Los bancos enmascaran la cuenta: basta con que coincidan los ultimos 4 digitos.
    accountMatches:
      accountDigits.length >= 4 && candidates.length
        ? candidates.some((account) => account.accountNumber.replace(/\D/g, "").endsWith(accountDigits.slice(-4)))
        : null,
    detectedAmount,
    detectedBank: String(parsed.detectedBank || "").slice(0, 80),
    detectedReference: String(parsed.detectedReference || "").slice(0, 80),
    summary: String(parsed.summary || "").slice(0, 400),
  };
}

/**
 * Guarda un comprobante en el pedido: lo sube a Cloudinary, lo lee con la IA,
 * deja el pedido "en revision" y avisa al equipo por correo.
 */
export async function attachReceipt(order: any, file: ReceiptFile, via: "whatsapp" | "web") {
  const orderNumber = order.orderNumber || String(order._id);
  const [url, analysis] = await Promise.all([
    uploadReceipt(file, orderNumber),
    analyzeReceipt(file, { total: order.totalAmount, orderNumber, account: order.transfer?.account?.accountNumber ? order.transfer.account : null }),
  ]);

  const receipts = [...(order.transfer?.receipts || []), { url, receivedAt: new Date(), via, analysis: analysis || {} }];
  order.set("transfer.receipts", receipts);
  order.set("transfer.status", "in_review");
  await order.save();

  const adminUrl = `${(process.env.PUBLIC_WEB_URL || "https://megaprinter.ec").replace(/\/$/, "")}/admin/orders?transfer=in_review`;
  void sendStoreEmail(
    `Comprobante por revisar ${orderNumber} - $${order.totalAmount.toFixed(2)}`,
    `
      <h2>Llegó un comprobante de transferencia</h2>
      <p><strong>Pedido:</strong> ${escapeHtml(orderNumber)} (${via === "whatsapp" ? "WhatsApp" : "web"})</p>
      <p><strong>Cliente:</strong> ${escapeHtml(order.customerName)} · ${escapeHtml(order.customerPhone)}</p>
      <p><strong>Total del pedido:</strong> $${order.totalAmount.toFixed(2)}</p>
      ${analysis ? `<p><strong>Lectura automática:</strong> ${escapeHtml(analysis.summary)}${analysis.detectedAmount !== null ? ` (monto leído $${analysis.detectedAmount.toFixed(2)})` : ""}</p>` : ""}
      <p><a href="${url}">Ver comprobante</a> · <a href="${adminUrl}">Revisar en el panel</a></p>
    `,
    order.customerEmail,
  );

  return { url, analysis };
}

export interface ImageInsight {
  kind: "receipt" | "product" | "other";
  description: string;
  searchQuery: string;
  /** Productos del catalogo que son ese mismo equipo (o el mas parecido). */
  productIds: string[];
  /** true si el primero de productIds es el mismo modelo que se ve en la imagen. */
  exactMatch: boolean;
}

const IMAGE_PROMPT = `Eres el asistente de Megaprinter (tienda de tecnología en Ecuador: laptops, all in one, monitores, impresoras, cámaras de seguridad). Un cliente mandó esta imagen por WhatsApp. Puede ser una foto, una captura de Instagram (de Megaprinter o de otra tienda), una publicidad o un comprobante bancario.
Devuelve SOLO JSON: {"kind":"receipt|product|other","description":"","searchQuery":"","matches":[0],"exactMatch":false}
- kind "receipt": comprobante de transferencia, depósito o pago bancario, o captura de un pago con tarjeta aprobado (Payphone, voucher, "pago exitoso").
- kind "product": muestra un equipo de tecnología o una publicación/anuncio de uno (lee el texto de la imagen: marca, modelo, specs, precio).
- kind "other": cualquier otra cosa.
- description: frase corta en español de lo que se ve (ej. "una impresora Epson L3250 negra", "una publicación de Instagram de una laptop HP 15").
- searchQuery: si es product, marca + tipo + modelo (ej. "impresora epson l3250"); si no, "".
- matches: si es product, hasta 3 números [ref] del CATÁLOGO que sean ese mismo equipo o los más parecidos (mismo tipo y gama), del más al menos parecido. [] si ninguno se parece. NUNCA inventes refs.
- exactMatch: true solo si el primer ref es exactamente el mismo modelo de la imagen.`;

/** Que muestra una imagen: comprobante, producto (cruzado con el catalogo) u otra cosa. */
export async function describeImage(
  file: ReceiptFile,
  catalog: Array<{ id: string; name: string; price: number; category: string }> = [],
): Promise<ImageInsight | null> {
  if (!file.mimeType.startsWith("image/")) return null;
  const list = catalog.map((product, index) => `[${index}] ${product.name} | ${product.category} | $${product.price.toFixed(2)}`).join("\n");
  const parsed = await geminiJson<any>({
    system: `${IMAGE_PROMPT}\n\nCATÁLOGO:\n${list || "(vacío)"}`,
    text: "Analiza la imagen del cliente.",
    image: { mimeType: file.mimeType, base64: file.buffer.toString("base64") },
    maxOutputTokens: 300,
    timeoutMs: 15000,
  });
  if (!parsed) return null;
  const kind = ["receipt", "product", "other"].includes(parsed.kind) ? parsed.kind : "other";
  const productIds = kind === "product" && Array.isArray(parsed.matches)
    ? [...new Set(parsed.matches.map(Number).filter((index: number) => Number.isInteger(index) && catalog[index]).map((index: number) => catalog[index].id))].slice(0, 3) as string[]
    : [];
  return {
    kind,
    description: String(parsed.description || "").slice(0, 160),
    searchQuery: kind === "product" ? String(parsed.searchQuery || "").slice(0, 120) : "",
    productIds,
    exactMatch: productIds.length > 0 && parsed.exactMatch === true,
  };
}
