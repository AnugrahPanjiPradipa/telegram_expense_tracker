import { GoogleGenAI, Type } from "@google/genai";
import { createClient } from "@supabase/supabase-js";

// Setup Supabase & Gemini
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const ALLOWED_USER_ID = Number(process.env.ALLOWED_USER_ID);

// Helper kirim pesan ke Telegram
async function sendTelegramMessage(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

// Helper ambil URL file foto dari Telegram
async function getTelegramFileUrl(fileId: string): Promise<string> {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`,
  );
  const data = await res.json();
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`;
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(200).send("Bot is active!");
  }

  const message = req.body?.message;
  if (!message) return res.status(200).send("OK");

  const chatId = message.chat.id;
  const userId = message.from.id;

  // 1. Validasi Keamanan (Hanya izinkan akun Telegram kamu)
  if (userId !== ALLOWED_USER_ID) {
    await sendTelegramMessage(chatId, "⛔ Akses ditolak. Bot ini privat.");
    return res.status(200).send("OK");
  }

  try {
    const text = message.text?.trim();

    // 2. Handle Perintah Dasar & Rekapitulasi
    if (text === "/start" || text === "/bantuan") {
      const welcomeText =
        `👋 *Halo! Saya Bot Pencatat Pengeluaran.*\n\n` +
        `Kirimkan catatan pengeluaran dengan cara:\n` +
        `• *Teks:* "Makan siang 25rb" atau "Bensin 50k"\n` +
        `• *Foto:* Kirim foto struk/nota belanjaan\n\n` +
        `*Perintah Rekapitulasi:*\n` +
        `• /hari_ini - Rekap pengeluaran hari ini\n` +
        `• /minggu_ini - Rekap pengeluaran 7 hari terakhir\n` +
        `• /bulan_ini - Rekap pengeluaran bulan berjalan`;

      await sendTelegramMessage(chatId, welcomeText);
      return res.status(200).send("OK");
    }

    if (
      text === "/hari_ini" ||
      text === "/minggu_ini" ||
      text === "/bulan_ini"
    ) {
      const now = new Date();
      let startDate = new Date();

      if (text === "/hari_ini") {
        startDate.setHours(0, 0, 0, 0);
      } else if (text === "/minggu_ini") {
        startDate.setDate(now.getDate() - 7);
      } else if (text === "/bulan_ini") {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      }

      const { data, error } = await supabase
        .from("expenses")
        .select("amount, category, description")
        .eq("user_id", userId)
        .gte("created_at", startDate.toISOString());

      if (error || !data || data.length === 0) {
        await sendTelegramMessage(
          chatId,
          `📊 Belum ada pengeluaran yang tercatat untuk periode ini.`,
        );
        return res.status(200).send("OK");
      }

      const total = data.reduce((acc, curr) => acc + Number(curr.amount), 0);
      let summary = `📊 *Rekap Pengeluaran (${text.replace("/", "")})*\n`;
      summary += `💰 *Total:* Rp ${total.toLocaleString("id-ID")}\n\n*Rincian:*`;

      data.forEach((item) => {
        summary += `\n• [${item.category}] Rp ${Number(item.amount).toLocaleString("id-ID")} - ${item.description || "-"}`;
      });

      await sendTelegramMessage(chatId, summary);
      return res.status(200).send("OK");
    }

    // 3. Handle Input Pengeluaran (Teks atau Foto Nota)
    let contents: any[] = [];

    if (message.photo) {
      // Ambil foto resolusi tertinggi
      const highestResPhoto = message.photo[message.photo.length - 1];
      const fileUrl = await getTelegramFileUrl(highestResPhoto.file_id);

      const imageBuffer = await fetch(fileUrl).then((r) => r.arrayBuffer());
      const base64Image = Buffer.from(imageBuffer).toString("base64");

      contents = [
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: base64Image,
          },
        },
        "Ekstrak total nominal belanja, kategori, dan rincian transaksi dari gambar nota ini.",
      ];
    } else if (text) {
      contents = [
        `Ekstrak nominal pengeluaran, kategori, dan deskripsi dari pesan ini: "${text}"`,
      ];
    } else {
      return res.status(200).send("OK");
    }

    // Panggil Gemini Flash dengan Structured Output
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            amount: {
              type: Type.NUMBER,
              description: "Total nominal angka saja (contoh 25000)",
            },
            category: {
              type: Type.STRING,
              description:
                "Kategori (contoh: Makanan, Transportasi, Belanja, Tagihan, Lainnya)",
            },
            description: {
              type: Type.STRING,
              description: "Keterangan ringkas transaksi",
            },
          },
          required: ["amount", "category", "description"],
        },
      },
    });

    const parsedData = JSON.parse(response.text || "{}");

    // 4. Simpan ke Supabase
    if (parsedData.amount) {
      await supabase.from("expenses").insert({
        user_id: userId,
        amount: parsedData.amount,
        category: parsedData.category,
        description: parsedData.description,
      });

      const replyText =
        `✅ *Tercatat!*\n` +
        `💵 *Nominal:* Rp ${Number(parsedData.amount).toLocaleString("id-ID")}\n` +
        `📂 *Kategori:* ${parsedData.category}\n` +
        `📝 *Keterangan:* ${parsedData.description}`;

      await sendTelegramMessage(chatId, replyText);
    } else {
      await sendTelegramMessage(
        chatId,
        "⚠️ Gagal mengenali format pengeluaran. Coba tuliskan lebih jelas atau kirim foto nota yang lebih terang.",
      );
    }

    return res.status(200).send("OK");
  } catch (err: any) {
    console.error(err);
    await sendTelegramMessage(
      chatId,
      "❌ Terjadi kesalahan saat memproses data.",
    );
    return res.status(200).send("Error");
  }
}
