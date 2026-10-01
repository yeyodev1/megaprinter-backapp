import { normalize } from "./whatsappBot/catalog";

/**
 * Bancos de Ecuador que el panel ofrece al cargar cuentas. El logo sale del
 * servicio de iconos de Google por dominio (sin API key); el panel permite
 * reemplazarlo con una URL propia.
 */
export const KNOWN_BANKS = {
  pichincha: { name: "Banco Pichincha", domain: "pichincha.com", keywords: ["pichincha"] },
  guayaquil: { name: "Banco Guayaquil", domain: "bancoguayaquil.com", keywords: ["banco guayaquil", "banco de guayaquil", "bg"] },
  // Google no tiene icono de bancodelpacifico.com: el de su banca en linea si.
  pacifico: { name: "Banco del Pacífico", domain: "intermatico.com", keywords: ["pacifico"] },
  produbanco: { name: "Produbanco", domain: "produbanco.com.ec", keywords: ["produbanco", "produ"] },
  bolivariano: { name: "Banco Bolivariano", domain: "bolivariano.com", keywords: ["bolivariano"] },
  internacional: { name: "Banco Internacional", domain: "bancointernacional.com.ec", keywords: ["internacional"] },
  austro: { name: "Banco del Austro", domain: "www.bancodelaustro.com", keywords: ["austro"] },
  jep: { name: "Cooperativa JEP", domain: "coopjep.fin.ec", keywords: ["jep"] },
} as const;

export type BankCode = keyof typeof KNOWN_BANKS | "otro";

export const bankLogo = (code: string) => {
  const bank = KNOWN_BANKS[code as keyof typeof KNOWN_BANKS];
  return bank ? `https://www.google.com/s2/favicons?domain=${bank.domain}&sz=128` : "";
};

/**
 * Banco que nombra el cliente, solo entre las cuentas activas. "Guayaquil" a
 * secas es la ciudad: solo cuenta como banco si se esta eligiendo banco.
 */
export function detectBank<T extends { id: string; bankCode: string; bank: string }>(text: string, accounts: T[], choosingBank = false): T | null {
  const value = ` ${normalize(text)} `;
  for (const account of accounts) {
    const known = KNOWN_BANKS[account.bankCode as keyof typeof KNOWN_BANKS];
    const words: string[] = known ? [...known.keywords] : [normalize(account.bank)];
    if (choosingBank && account.bankCode === "guayaquil") words.push("guayaquil");
    if (words.some((word) => word && value.includes(` ${word} `))) return account;
  }
  return null;
}
