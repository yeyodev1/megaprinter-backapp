/**
 * Convierte un nombre legible en un slug URL-safe. Se quitan las tildes antes
 * de generar el slug: sin esto "Monitores Gráficos" producia "monitores-gr-ficos".
 */
export const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
