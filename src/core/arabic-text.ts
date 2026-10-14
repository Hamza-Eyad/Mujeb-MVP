/**
 * Arabic text normalization for *matching* (echo detection, backchannels, directory search) — not for display or TTS.
 * Removes diacritics/tatweel, unifies hamza/alef/taa-marbuta/alef-maqsura variants, maps Arabic-Indic
 * digits to ASCII, strips punctuation, and collapses elongated letters ("اااه" → "اه").
 */

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;

export function normalizeArabic(text: string): string {
  return text
    .normalize('NFKC')
    .replace(DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/(\p{L})\1+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text: string): string[] {
  const normalized = normalizeArabic(text);
  return normalized === '' ? [] : normalized.split(' ');
}
