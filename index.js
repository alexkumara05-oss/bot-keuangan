// ============================================================
// BOT KEUANGAN WHATSAPP
// Stack: Baileys (WA) + Google Vision (OCR) + Gemini (AI)
//        + Google Sheets API
// ============================================================

const { default: makeWASocket, useMultiFileAuthState,
  DisconnectReason, fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const { Boom }               = require("@hapi/boom");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google }             = require("googleapis");
const qrcode                 = require("qrcode-terminal");
const pino                   = require("pino");

require("dotenv").config();

// ── Matikan log noise dari Baileys ───────────────────────────
const logger = pino({ level: "silent" });

// ── Clients ──────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const sheets = google.sheets({ version: "v4" });
// Baca credentials dari Base64 (Railway) atau file langsung (lokal)
let googleAuthConfig;
if (process.env.GOOGLE_CREDENTIALS_BASE64) {
const credsJson = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, "base64").toString("utf8");
const creds     = JSON.parse(credsJson);
googleAuthConfig = { credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets"] };
} else {
googleAuthConfig = { keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS, scopes: ["https://www.googleapis.com/auth/spreadsheets"] };
}
const auth = new google.auth.GoogleAuth(googleAuthConfig);

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// ── Helper: tunggu beberapa detik ────────────────────────────
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ── Helper: format rupiah ─────────────────────────────────────
function formatRupiah(num) {
return "Rp " + Number(num).toLocaleString("id-ID");
}

// ── Helper: tanggal & waktu sekarang ─────────────────────────
function nowDate() {
return new Date().toLocaleDateString("id-ID", {
day: "2-digit", month: "2-digit", year: "numeric",
});
}
function nowTime() {
return new Date().toLocaleTimeString("id-ID", {
hour: "2-digit", minute: "2-digit",
});
}

// ── Sheets: ambil nomor terakhir ─────────────────────────────
async function getLastRowNumber(authClient) {
const res = await sheets.spreadsheets.values.get({
auth: authClient,
spreadsheetId: SPREADSHEET_ID,
range: "Transaksi!A:A",
});
const rows = res.data.values || [];
const dataRows = rows.filter((r, i) => i >= 2 && r[0] && !isNaN(r[0]));
return dataRows.length > 0 ? parseInt(dataRows[dataRows.length - 1][0]) : 0;
}

// ── Sheets: append transaksi ─────────────────────────────────
async function appendTransaction(data) {
const authClient = await auth.getClient();
const lastNo     = await getLastRowNumber(authClient);
const no         = lastNo + 1;
const row = [
no, data.tanggal || nowDate(), data.waktu || nowTime(),
data.keterangan, data.kategori,
data.masuk  || "", data.keluar || "", "",
data.sumber || "WhatsApp Bot", data.catatan || "",
];
await sheets.spreadsheets.values.append({
auth: authClient,
spreadsheetId: SPREADSHEET_ID,
range: "Transaksi!A:J",
valueInputOption: "USER_ENTERED",
requestBody: { values: [row] },
});
return no;
}

// ── Sheets: hapus baris terakhir ─────────────────────────────
async function deleteLastTransaction() {
const authClient = await auth.getClient();
const res = await sheets.spreadsheets.values.get({
auth: authClient,
spreadsheetId: SPREADSHEET_ID,
range: "Transaksi!A:J",
});
const rows    = res.data.values || [];
const lastRow = rows.length;
if (lastRow <= 2) return null;
await sheets.spreadsheets.values.clear({
auth: authClient,
spreadsheetId: SPREADSHEET_ID,
range: `Transaksi!A${lastRow}:J${lastRow}`,
});
return rows[lastRow - 1];
}

// ── Sheets: summary bulan ini ────────────────────────────────
async function getMonthlySummary() {
const authClient = await auth.getClient();
const res = await sheets.spreadsheets.values.get({
auth: authClient,
spreadsheetId: SPREADSHEET_ID,
range: "Transaksi!B3:G2000",
});
const rows  = res.data.values || [];
const now   = new Date();
const bulan = now.getMonth() + 1;
const tahun = now.getFullYear();

let totalMasuk = 0, totalKeluar = 0, count = 0;
const kategoriMap = {};

for (const row of rows) {
if (!row[0]) continue;
const parts = (row[0] || "").split("/");
if (parseInt(parts[1]) !== bulan || parseInt(parts[2]) !== tahun) continue;
const masuk  = parseFloat((row[4] || "0").replace(/\./g, "").replace(",", ".")) || 0;
const keluar = parseFloat((row[5] || "0").replace(/\./g, "").replace(",", ".")) || 0;
totalMasuk  += masuk;
totalKeluar += keluar;
count++;
const kat = row[3] || "Lain-lain";
kategoriMap[kat] = (kategoriMap[kat] || 0) + keluar;
}

const topKat = Object.entries(kategoriMap)
.sort((a, b) => b[1] - a[1]).slice(0, 3)
.map(([k, v]) => `  • ${k}: ${formatRupiah(v)}`).join("\n");

return { totalMasuk, totalKeluar, saldo: totalMasuk - totalKeluar, count, topKat };
}

// ── Sheets: transaksi hari ini ───────────────────────────────
async function getTodayTransactions() {
const authClient = await auth.getClient();
const res = await sheets.spreadsheets.values.get({
auth: authClient,
spreadsheetId: SPREADSHEET_ID,
range: "Transaksi!A3:J2000",
});
const today = nowDate();
return (res.data.values || []).filter(r => r[1] === today);
}

// ── Helper: panggil Gemini dengan retry saat kena 429 ────────
async function callGemini(prompt, maxRetry = 4) {
for (let i = 0; i < maxRetry; i++) {
try {
const result = await model.generateContent(prompt);
return result.response.text().trim().replace(/```json|```/g, "");
} catch (err) {
const is429 = err.message?.includes("429");
const is503 = err.message?.includes("503") || err.message?.includes("overload") || err.message?.includes("high demand");
const isRetryable = is429 || is503;

if (isRetryable && i < maxRetry - 1) {
  const waitSec = is429 ? 35 : 10; // 503 cukup tunggu 10 detik
  const reason  = is429 ? "Rate limit" : "Server sibuk (503)";
  console.log(`[Gemini] ${reason}, tunggu ${waitSec}s lalu coba lagi... (${i + 2}/${maxRetry})`);
  await delay(waitSec * 1000);
} else {
  throw err;
}
}
}
}

// ── AI: parse teks ───────────────────────────────────────────
async function parseTextCommand(text) {
const prompt = `
Kamu adalah asisten keuangan. Parse perintah berikut dan kembalikan JSON.
Perintah: "${text}"

Format JSON (tanpa markdown):
{
"type": "masuk" | "keluar" | "unknown",
"nominal": number,
"keterangan": "string",
"kategori": "Pendapatan" | "Makan & Minum" | "Transport" | "Belanja" | "Tagihan" | "Kesehatan" | "Hiburan" | "Lain-lain"
}

Aturan:
- Gaji/freelance → Pendapatan, type masuk
- Makan/warung/resto → Makan & Minum, type keluar
- Bensin/parkir/ojol/grab → Transport, type keluar
- Belanja/indomaret/alfamart → Belanja, type keluar
- Listrik/air/pulsa/internet → Tagihan, type keluar
- Dokter/obat/apotek → Kesehatan, type keluar
- Bioskop/game/hiburan → Hiburan, type keluar
- Awalan - atau kata "keluar" → type keluar
- Awalan + atau kata "masuk" → type masuk
- Singkatan: rb=ribu, jt=juta (contoh: 50rb=50000, 2jt=2000000)

Kembalikan HANYA JSON.`;

const raw = await callGemini(prompt);
return JSON.parse(raw);
}

// ── AI: parse foto struk langsung pakai Gemini Vision ────────
async function parseReceiptImage(imageBuffer) {
const base64Image = imageBuffer.toString("base64");

const prompt = `
Kamu adalah asisten keuangan. Lihat gambar struk/bon belanja ini dan ekstrak informasinya.

Kembalikan JSON (tanpa markdown, tanpa penjelasan):
{
"keterangan": "nama toko atau merchant",
"nominal": number (total pembayaran, angka saja tanpa titik/koma),
"kategori": salah satu dari "Makan & Minum" | "Transport" | "Belanja" | "Tagihan" | "Kesehatan" | "Hiburan" | "Lain-lain",
"item_utama": "ringkasan item yang dibeli, maks 30 karakter"
}

Jika tidak bisa membaca nominal, isi nominal dengan 0.
Kembalikan HANYA JSON.`;

// Gemini Vision: kirim gambar langsung
const result = await model.generateContent([
{ text: prompt },
{
inlineData: {
  mimeType: "image/jpeg",
  data: base64Image,
},
},
]);

const raw = result.response.text().trim().replace(/```json|```/g, "");
return JSON.parse(raw);
}

// ── Pesan-pesan balasan ──────────────────────────────────────
function buildConfirmMessage(data, no) {
const emoji = data.type === "masuk" ? "💚" : "❤️";
const label = data.type === "masuk" ? "MASUK" : "KELUAR";
return (
`✅ *Transaksi #${no} Tercatat!*\n\n` +
`${emoji} *${label}:* ${formatRupiah(data.nominal)}\n` +
`📋 *Keterangan:* ${data.keterangan}\n` +
`🗂️ *Kategori:* ${data.kategori}\n` +
`📅 *${nowDate()} | ${nowTime()} WIB*\n\n` +
`_Ketik *saldo* untuk lihat ringkasan_`
);
}

function buildSummaryMessage(s) {
return (
`📊 *Ringkasan Bulan Ini*\n\n` +
`✅ Masuk  : ${formatRupiah(s.totalMasuk)}\n` +
`❌ Keluar : ${formatRupiah(s.totalKeluar)}\n` +
`💰 Saldo  : ${formatRupiah(s.saldo)}\n` +
`🔢 Transaksi: ${s.count} kali\n\n` +
`*Top Pengeluaran:*\n${s.topKat || "  (belum ada data)"}`
);
}

function buildHelpMessage() {
return (
`🤖 *Bot Keuangan*\n\n` +
`*📤 Pengeluaran:*\n` +
`  keluar 25000 makan siang\n` +
`  -50rb bensin motor\n\n` +
`*📥 Pemasukan:*\n` +
`  masuk 8jt gaji juni\n` +
`  +200rb transfer dari reza\n\n` +
`*📸 Foto Struk:* Kirim foto langsung\n\n` +
`*📊 Laporan:*\n` +
`  saldo · hari ini · hapus terakhir`
);
}

// ── Handle pesan masuk ───────────────────────────────────────
async function handleMessage(sock, msg) {
if (!msg.message || msg.key.fromMe) return;

const from    = msg.key.remoteJid;
const msgType = Object.keys(msg.message)[0];
const textRaw = msg.message.conversation ||
            msg.message.extendedTextMessage?.text || "";
const text    = textRaw.trim().toLowerCase();

try {
// ── Pesan teks ─────────────────────────────────────────
if (msgType === "conversation" || msgType === "extendedTextMessage") {

if (["saldo", "laporan", "summary"].includes(text)) {
  const s = await getMonthlySummary();
  await sock.sendMessage(from, { text: buildSummaryMessage(s) });
  return;
}

if (["hari ini", "hariini", "today"].includes(text)) {
  const rows = await getTodayTransactions();
  if (rows.length === 0) {
    await sock.sendMessage(from, { text: "📭 Belum ada transaksi hari ini." });
  } else {
    let reply = `📅 *Transaksi Hari Ini (${nowDate()})*\n\n`;
    for (const r of rows) {
      const lbl = r[5] ? `💚 +${formatRupiah(r[5])}` : `❤️ -${formatRupiah(r[6])}`;
      reply += `${r[0]}. ${r[3]} — ${lbl}\n`;
    }
    await sock.sendMessage(from, { text: reply });
  }
  return;
}

if (["hapus terakhir", "batal", "cancel", "undo"].includes(text)) {
  const deleted = await deleteLastTransaction();
  if (!deleted) {
    await sock.sendMessage(from, { text: "❌ Tidak ada transaksi yang bisa dihapus." });
  } else {
    await sock.sendMessage(from, {
      text: `🗑️ Dihapus: *${deleted[3]}* — ${formatRupiah(deleted[5] || deleted[6])}`,
    });
  }
  return;
}

if (["bantuan", "help", "menu", "?"].includes(text)) {
  await sock.sendMessage(from, { text: buildHelpMessage() });
  return;
}

const isTransaksi =
  text.startsWith("keluar") || text.startsWith("masuk") ||
  text.startsWith("-")      || text.startsWith("+")     ||
  /^\d/.test(text);

if (isTransaksi) {
  await sock.sendMessage(from, { text: "⏳ Memproses..." });
  const parsed = await parseTextCommand(textRaw);

  if (parsed.type === "unknown" || !parsed.nominal) {
    await sock.sendMessage(from, {
      text: "❓ Format tidak dikenali.\nContoh: *keluar 25000 makan siang*\nKetik *bantuan* untuk panduan.",
    });
    return;
  }

  const data = {
    keterangan: parsed.keterangan,
    kategori:   parsed.kategori,
    masuk:      parsed.type === "masuk"  ? parsed.nominal : null,
    keluar:     parsed.type === "keluar" ? parsed.nominal : null,
    sumber:     "Ketik Manual",
    type:       parsed.type,
    nominal:    parsed.nominal,
  };
  const no = await appendTransaction(data);
  await sock.sendMessage(from, { text: buildConfirmMessage(data, no) });
  return;
}

await sock.sendMessage(from, {
  text: "👋 Halo! Ketik *bantuan* untuk panduan penggunaan.",
});

// ── Foto struk ───────────────────────────────────────
} else if (msgType === "imageMessage") {
await sock.sendMessage(from, { text: "📸 Struk diterima! Sedang dibaca..." });
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
const parsed = await parseReceiptImage(buffer);

if (!parsed || !parsed.nominal) {
  await sock.sendMessage(from, {
    text: "❌ Gagal membaca struk. Pastikan foto jelas.\nAtau ketik manual: *keluar [nominal] [keterangan]*",
  });
  return;
}

const data = {
  keterangan: parsed.keterangan, kategori: parsed.kategori,
  keluar: parsed.nominal, masuk: null, sumber: "Foto Struk",
  type: "keluar", nominal: parsed.nominal, catatan: parsed.item_utama || "",
};
const no = await appendTransaction(data);
await sock.sendMessage(from, { text: buildConfirmMessage(data, no) });
}

} catch (err) {
console.error("[handleMessage error]", err.message);
await sock.sendMessage(from, {
text: "⚠️ Terjadi kesalahan. Coba lagi atau ketik *bantuan*.",
});
}
}

// ── Main: startBot dengan reconnect yang aman ────────────────
let reconnectCount = 0;
const MAX_RECONNECT = 5;

async function startBot() {
const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
const { version }          = await fetchLatestBaileysVersion();

console.log(`[Bot] Menggunakan Baileys versi ${version.join(".")}`);

const sock = makeWASocket({
version,
auth: {
creds: state.creds,
keys:  makeCacheableSignalKeyStore(state.keys, logger),
},
logger,
browser: ["Bot Keuangan", "Chrome", "1.0.0"],
connectTimeoutMs: 30_000,
keepAliveIntervalMs: 15_000,
retryRequestDelayMs: 2_000,
});

sock.ev.on("creds.update", saveCreds);

sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
if (qr) {
console.log("\n==============================");
console.log(" Scan QR ini dengan WhatsApp");
console.log("==============================\n");
qrcode.generate(qr, { small: true });
console.log("\n(QR berlaku ~60 detik)\n");
}

if (connection === "open") {
reconnectCount = 0; // reset counter saat berhasil konek
console.log("✅ Bot Keuangan aktif!\n");
}

if (connection === "close") {
const statusCode  = new Boom(lastDisconnect?.error)?.output?.statusCode;
const isLoggedOut = statusCode === DisconnectReason.loggedOut;

console.log(`[Bot] Koneksi tertutup. Kode: ${statusCode}`);

if (isLoggedOut) {
  console.log("[Bot] Logged out. Hapus folder auth_info lalu jalankan ulang.");
  process.exit(0); // berhenti total, jangan looping
}

if (reconnectCount >= MAX_RECONNECT) {
  console.log(`[Bot] Gagal reconnect ${MAX_RECONNECT}x. Berhenti.`);
  console.log("[Bot] Coba hapus folder auth_info lalu jalankan npm start lagi.");
  process.exit(1);
}

reconnectCount++;
const waitSec = reconnectCount * 5; // 5s, 10s, 15s, ...
console.log(`[Bot] Reconnect ke-${reconnectCount} dalam ${waitSec} detik...`);
await delay(waitSec * 1000);
startBot();
}
});

sock.ev.on("messages.upsert", async ({ messages, type }) => {
// Hanya proses pesan baru (type "notify"), abaikan history/sync
if (type !== "notify") return;
const msg = messages[0];
await handleMessage(sock, msg);
});
}

startBot();