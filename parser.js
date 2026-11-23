// Normalisasi karakter Greek/Cyrillic lookalike ke Latin A-Z
const HOMOGLYPH_MAP = {
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K',
  'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O',
  'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X'
};

export function normalizeText(raw) {
  if (!raw) return '';
  return raw
    .replace(/[ΑΒΕΖΗΙΚΜΝΟΡΤΥΧАВЕКМНОРСТХ]/g, (ch) => HOMOGLYPH_MAP[ch] || ch)
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function detectCourier(text) {
  const upper = text.toUpperCase();
  if (/SPXID|SHOPEE\s*EXPRESS|\bSPX\b/.test(upper)) return 'Shopee Express';
  if (/\bJ&T\b|\bJNT\b|JX\d{8,}|JP\d{8,}/.test(upper)) return 'J&T Express';
  if (/\bJNE\b|CM\d{8,}|TLJR/.test(upper)) return 'JNE';
  if (/SICEPAT|00\d{10,}/.test(upper)) return 'SiCepat';
  if (/ANTERAJA|1000\d{10,}/.test(upper)) return 'Anteraja';
  if (/NINJA|NVID/.test(upper)) return 'Ninja Xpress';
  if (/ID\s*EXPRESS|IDE\d{8,}/.test(upper)) return 'ID Express';
  if (/\bLEX\b|LAZADA/.test(upper)) return 'LEX (Lazada)';
  return 'Tidak Terdeteksi';
}

export function extractOrderNumber(text) {
  // 1. Cari lewat label eksplisit (High Confidence)
  const labelPatterns = [
    /No\.?\s*Pesanan\s*[:\-]?\s*([A-Z0-9]{10,20})/i,
    /Order\s*(?:ID|No\.?)\s*[:\-]?\s*([A-Z0-9\-]{8,22})/i,
    /Invoice\s*(?:No\.?)?\s*[:\-]?\s*(INV[A-Z0-9\/\-]+)/i
  ];

  for (const regex of labelPatterns) {
    const match = text.match(regex);
    if (match && match[1]) {
      return { value: match[1].toUpperCase(), method: 'label' };
    }
  }

  // 2. Fallback: cari di dalam tanda kurung Pesan: (261107N9QP8SCN)
  const pesanMatch = text.match(/Pesan\s*:.*?\(([0-9]{6}[A-Z0-9]{8})\)/i);
  if (pesanMatch && pesanMatch[1]) {
    return { value: pesanMatch[1].toUpperCase(), method: 'backup_pesan' };
  }

  // 3. Fallback: pola umum No. Pesanan Shopee (YYMMDD + 8 alfanumerik)
  const shopeePattern = text.match(/\b(2[4-9](?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[A-Z0-9]{8})\b/);
  if (shopeePattern && shopeePattern[1]) {
    return { value: shopeePattern[1].toUpperCase(), method: 'pattern' };
  }

  return { value: '', method: 'none' };
}

export function extractSenderCity(text, spatialSenderText = '') {
  // Prioritaskan blok teks yang dekat dengan koordinat "Pengirim:"
  const targetPool = spatialSenderText ? [spatialSenderText, text] : [text];
  const cityRegex = /\b((?:KOTA|KAB\.?|KABUPATEN)\s+[A-Z]+(?:\s+[A-Z]+)?)\b/g;

  for (let i = 0; i < targetPool.length; i++) {
    const upper = targetPool[i].toUpperCase();
    const matches = [...upper.matchAll(cityRegex)].map((m) => m[1].replace(/\s+/g, ' ').trim());

    if (matches.length > 0) {
      // Jika dari blok spasial pengirim, ambil yang pertama. Jika dari full text, ambil yang muncul setelah kata "PENGIRIM"
      if (i === 0 && spatialSenderText) {
        return { value: matches[0], method: 'spatial' };
      }
      const pengirimIdx = upper.indexOf('PENGIRIM');
      if (pengirimIdx !== -1) {
        const afterPengirim = upper.slice(pengirimIdx, pengirimIdx + 250);
        const afterMatch = afterPengirim.match(/\b((?:KOTA|KAB\.?|KABUPATEN)\s+[A-Z]+(?:\s+[A-Z]+)?)\b/);
        if (afterMatch) return { value: afterMatch[1].trim(), method: 'anchor' };
      }
      return { value: matches[matches.length - 1], method: 'fallback' };
    }
  }

  return { value: '', method: 'none' };
}

export function parseAwbPage(pageNumber, rawText, spatialSenderText, sourceType) {
  const cleanText = normalizeText(rawText);
  const cleanSpatial = normalizeText(spatialSenderText);

  const order = extractOrderNumber(cleanText);
  const courier = detectCourier(cleanText);
  const city = extractSenderCity(cleanText, cleanSpatial);

  // Hitung Confidence Level
  let score = 0;
  if (order.method === 'label') score += 50;
  else if (order.method === 'backup_pesan') score += 40;
  else if (order.method === 'pattern') score += 25;

  if (courier !== 'Tidak Terdeteksi') score += 20;
  if (city.method === 'spatial' || city.method === 'anchor') score += 30;
  else if (city.method === 'fallback') score += 15;

  // Penalti kecil jika hasil dari OCR fallback
  if (sourceType === 'OCR Fallback') score -= 15;

  let confidence = 'Low';
  if (score >= 85 && order.value) confidence = 'High';
  else if (score >= 55 && order.value) confidence = 'Medium';

  const status = order.value ? 'Sukses' : 'Perlu Cek';

  return {
    page: pageNumber,
    orderNo: order.value || '-',
    courier,
    senderCity: city.value || '-',
    status,
    confidence,
    source: sourceType
  };
}