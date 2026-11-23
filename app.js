import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, collection, addDoc, getDocs, deleteDoc, doc, query, orderBy, limit, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { parseAwbPage } from './parser.js';

// ==========================================
// 1. KONFIGURASI FIREBASE (GANTI PUNYA KAMU)
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyCkZH1f07-jRikkdPimKmimSFxaPFo2fRY",
  authDomain: "awb-ocr-pro.firebaseapp.com",
  projectId: "awb-ocr-pro",
  storageBucket: "awb-ocr-pro.firebasestorage.app",
  messagingSenderId: "894835235422",
  appId: "1:894835235422:web:f3bf54d96d0fd7e3b372cf"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const BATCH_COL = collection(db, 'ocr_batches');

// Setup PDF.js Worker
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const MAX_PAGES = 200;
let currentData = [];
let filteredData = [];
let currentFileName = '';

// DOM Elements
const pdfInput = document.getElementById('pdfInput');
const dropZone = document.getElementById('dropZone');
const progressBox = document.getElementById('progressBox');
const fileNameLabel = document.getElementById('fileNameLabel');
const fileSizeLabel = document.getElementById('fileSizeLabel');
const progressText = document.getElementById('progressText');
const progressPercent = document.getElementById('progressPercent');
const progressBar = document.getElementById('progressBar');
const resultBody = document.getElementById('resultBody');

// ==========================================
// 2. EXTRACTION ENGINE (PDF TEXT -> OCR)
// ==========================================
async function extractSpatialSender(textContent) {
  // Cari koordinat X/Y kata "Pengirim" lalu ambil teks di bawahnya pada kolom X yang berdekatan
  const items = textContent.items;
  const senderAnchor = items.find((it) => /Pengirim/i.test(it.str));
  if (!senderAnchor) return '';

  const anchorX = senderAnchor.transform[4];
  const anchorY = senderAnchor.transform[5];

  return items
    .filter((it) => {
      const x = it.transform[4];
      const y = it.transform[5];
      return Math.abs(x - anchorX) < 120 && y <= anchorY + 10 && y >= anchorY - 90;
    })
    .map((it) => it.str)
    .join(' ');
}

async function runOcrFallback(page) {
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({ canvasContext: ctx, viewport }).promise;
  const { data: { text } } = await Tesseract.recognize(canvas, 'eng');

  // Bersihkan memori canvas segera
  canvas.width = 0;
  canvas.height = 0;
  return text;
}

async function processPdfFile(file) {
  if (!file || file.type !== 'application/pdf') {
    alert('Harap pilih file PDF yang valid.');
    return;
  }

  currentFileName = file.name;
  currentData = [];
  progressBox.classList.remove('hidden');
  fileNameLabel.textContent = file.name;
  fileSizeLabel.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} MB`;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  if (pdf.numPages > MAX_PAGES) {
    alert(`File memiliki ${pdf.numPages} halaman. Maksimal limit adalah ${MAX_PAGES} halaman per PDF.`);
    progressBox.classList.add('hidden');
    return;
  }

  for (let i = 1; i <= pdf.numPages; i++) {
    const pct = Math.round((i / pdf.numPages) * 100);
    progressText.textContent = `Memproses halaman ${i} dari ${pdf.numPages}...`;
    progressPercent.textContent = `${pct}%`;
    progressBar.style.width = `${pct}%`;

    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const rawText = textContent.items.map((it) => it.str).join(' ');
    const spatialSender = await extractSpatialSender(textContent);

    let parsed = parseAwbPage(i, rawText, spatialSender, 'PDF Text');

    // Jika PDF berupa scan/gambar (teks kosong atau No. Pesanan gagal dibaca), jalankan OCR Fallback
    if (!rawText.trim() || parsed.orderNo === '-') {
      progressText.textContent = `OCR Fallback halaman ${i} dari ${pdf.numPages}...`;
      const ocrText = await runOcrFallback(page);
      parsed = parseAwbPage(i, ocrText, '', 'OCR Fallback');
    }

    currentData.push(parsed);
    page.cleanup(); // Wajib untuk hemat RAM di 200 halaman
  }

  progressText.textContent = `Selesai! Menyimpan ${pdf.numPages} data ke Cloud...`;
  renderAll();
  await saveBatchToCloud(file.name, currentData);
  progressText.textContent = `Selesai & tersimpan di Firebase Cloud!`;
}

// ==========================================
// 3. FIREBASE CLOUD HISTORY
// ==========================================
async function saveBatchToCloud(fileName, items) {
  try {
    const pic = document.getElementById('picInput').value.trim() || 'Tim Shift';
    await addDoc(BATCH_COL, {
      fileName,
      uploadedBy: pic,
      createdAt: serverTimestamp(),
      totalPages: items.length,
      successCount: items.filter((d) => d.status === 'Sukses').length,
      needCheckCount: items.filter((d) => d.status === 'Perlu Cek').length,
      highConfidenceCount: items.filter((d) => d.confidence === 'High').length,
      items
    });
    loadHistoryList();
  } catch (err) {
    console.error('Gagal simpan ke Firestore:', err);
  }
}

async function loadHistoryList() {
  try {
    const q = query(BATCH_COL, orderBy('createdAt', 'desc'), limit(30));
    const snap = await getDocs(q);
    document.getElementById('historyCount').textContent = snap.size;

    const container = document.getElementById('historyList');
    if (snap.empty) {
      container.innerHTML = '<p class="text-slate-400 text-center py-6">Belum ada riwayat di cloud.</p>';
      return;
    }

    container.innerHTML = '';
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      const dateStr = data.createdAt?.toDate
        ? data.createdAt.toDate().toLocaleString('id-ID')
        : 'Baru saja';

      const div = document.createElement('div');
      div.className = 'flex items-center justify-between p-3 border border-slate-200 rounded-xl hover:bg-slate-50';
      div.innerHTML = `
        <div class="cursor-pointer flex-1" data-load>
          <p class="font-semibold text-slate-800">${data.fileName}</p>
          <p class="text-xs text-slate-500">${data.uploadedBy} • ${dateStr} • ${data.totalPages} hal (${data.successCount} sukses)</p>
        </div>
        <button data-del class="ml-3 text-xs text-red-500 hover:underline">Hapus</button>
      `;

      div.querySelector('[data-load]').addEventListener('click', () => {
        currentData = data.items || [];
        currentFileName = data.fileName;
        renderAll();
        document.getElementById('historyModal').classList.add('hidden');
      });

      div.querySelector('[data-del]').addEventListener('click', async () => {
        if (confirm(`Hapus riwayat "${data.fileName}"?`)) {
          await deleteDoc(doc(db, 'ocr_batches', docSnap.id));
          loadHistoryList();
        }
      });

      container.appendChild(div);
    });
  } catch (err) {
    console.error('Gagal load riwayat:', err);
  }
}

// ==========================================
// 4. UI RENDER, FILTER, COPY & EXPORT EXCEL
// ==========================================
function populateFilterOptions() {
  const couriers = [...new Set(currentData.map((d) => d.courier))].sort();
  const cities = [...new Set(currentData.map((d) => d.senderCity))].sort();

  const courierSel = document.getElementById('filterCourier');
  courierSel.innerHTML = '<option value="">Semua Kurir</option>' +
    couriers.map((c) => `<option value="${c}">${c}</option>`).join('');

  const citySel = document.getElementById('filterCity');
  citySel.innerHTML = '<option value="">Semua Kota Pengirim</option>' +
    cities.map((c) => `<option value="${c}">${c}</option>`).join('');
}

function applyFilters() {
  const search = document.getElementById('filterSearch').value.toLowerCase();
  const courier = document.getElementById('filterCourier').value;
  const city = document.getElementById('filterCity').value;
  const status = document.getElementById('filterStatus').value;
  const conf = document.getElementById('filterConfidence').value;

  filteredData = currentData.filter((d) => {
    const matchSearch = !search ||
      d.orderNo.toLowerCase().includes(search) ||
      d.courier.toLowerCase().includes(search) ||
      d.senderCity.toLowerCase().includes(search);
    const matchCourier = !courier || d.courier === courier;
    const matchCity = !city || d.senderCity === city;
    const matchStatus = !status || d.status === status;
    const matchConf = !conf || d.confidence === conf;
    return matchSearch && matchCourier && matchCity && matchStatus && matchConf;
  });

  renderTable();
}

function renderTable() {
  document.getElementById('displayCount').textContent =
    `Menampilkan ${filteredData.length} dari ${currentData.length} data`;

  if (filteredData.length === 0) {
    resultBody.innerHTML = '<tr><td colspan="7" class="py-10 text-center text-slate-400">Tidak ada data yang cocok.</td></tr>';
    return;
  }

  resultBody.innerHTML = filteredData.map((d) => {
    const statusBadge = d.status === 'Sukses'
      ? 'bg-emerald-100 text-emerald-700'
      : 'bg-amber-100 text-amber-700';
    const confBadge = d.confidence === 'High'
      ? 'bg-emerald-100 text-emerald-700'
      : d.confidence === 'Medium'
        ? 'bg-amber-100 text-amber-700'
        : 'bg-red-100 text-red-700';

    return `
      <tr class="hover:bg-slate-50">
        <td class="py-3 px-3 text-slate-500">${d.page}</td>
        <td class="py-3 px-3">
          <span class="font-mono font-semibold text-blue-700 bg-blue-50 px-2.5 py-1 rounded-md">${d.orderNo}</span>
        </td>
        <td class="py-3 px-3">${d.courier}</td>
        <td class="py-3 px-3 font-medium">${d.senderCity}</td>
        <td class="py-3 px-3"><span class="px-2.5 py-1 rounded-full text-xs font-semibold ${statusBadge}">${d.status}</span></td>
        <td class="py-3 px-3"><span class="px-2.5 py-1 rounded-full text-xs font-semibold ${confBadge}">${d.confidence}</span></td>
        <td class="py-3 px-3 text-xs text-slate-500">${d.source}</td>
      </tr>
    `;
  }).join('');
}

function renderAll() {
  document.getElementById('statTotal').textContent = currentData.length;
  document.getElementById('statSuccess').textContent = currentData.filter((d) => d.status === 'Sukses').length;
  document.getElementById('statCheck').textContent = currentData.filter((d) => d.status === 'Perlu Cek').length;
  document.getElementById('statHigh').textContent = currentData.filter((d) => d.confidence === 'High').length;
  populateFilterOptions();
  applyFilters();
}

// Event Listeners
pdfInput.addEventListener('change', (e) => processPdfFile(e.target.files[0]));
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('border-blue-500'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('border-blue-500'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('border-blue-500');
  processPdfFile(e.dataTransfer.files[0]);
});

['filterSearch', 'filterCourier', 'filterCity', 'filterStatus', 'filterConfidence'].forEach((id) => {
  document.getElementById(id).addEventListener('input', applyFilters);
  document.getElementById(id).addEventListener('change', applyFilters);
});

document.getElementById('btnCopyOrders').addEventListener('click', async () => {
  const orders = filteredData.map((d) => d.orderNo).filter((v) => v && v !== '-').join('\n');
  if (!orders) return alert('Tidak ada No. Pesanan untuk disalin.');
  await navigator.clipboard.writeText(orders);
  alert(`Berhasil menyalin ${orders.split('\n').length} No. Pesanan!`);
});

document.getElementById('btnExportExcel').addEventListener('click', () => {
  if (!filteredData.length) return alert('Tidak ada data untuk di-export.');
  const rows = filteredData.map((d) => ({
    Halaman: d.page,
    'No. Pesanan': d.orderNo,
    Kurir: d.courier,
    'Kota Pengirim': d.senderCity,
    Status: d.status,
    Confidence: d.confidence,
    Source: d.source
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Hasil OCR');
  const outName = (currentFileName || 'hasil-ocr').replace(/\.pdf$/i, '') + '.xlsx';
  XLSX.writeFile(wb, outName);
});

document.getElementById('btnReset').addEventListener('click', () => {
  currentData = [];
  filteredData = [];
  pdfInput.value = '';
  progressBox.classList.add('hidden');
  renderAll();
});

document.getElementById('btnOpenHistory').addEventListener('click', () => {
  document.getElementById('historyModal').classList.remove('hidden');
  loadHistoryList();
});
document.getElementById('btnCloseHistory').addEventListener('click', () => {
  document.getElementById('historyModal').classList.add('hidden');
});

// Load count riwayat saat pertama kali buka
loadHistoryList();