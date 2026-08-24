import { GoogleGenAI, Type } from "@google/genai";
import { createClient } from "@supabase/supabase-js";

// Helper kirim pesan ke Telegram
async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch (err) {
    console.error("Gagal kirim pesan telegram:", err);
  }
}

// Helper ambil URL file foto dari Telegram
async function getTelegramFileUrl(
  token: string,
  fileId: string,
): Promise<string> {
  const res = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`,
  );
  const data = await res.json();
  return `https://api.telegram.org/file/bot${token}/${data.result.file_path}`;
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(200).send("Bot is active!");
  }

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID
    ? Number(process.env.ALLOWED_USER_ID)
    : null;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  const message = req.body?.message;
  if (!message || !BOT_TOKEN) return res.status(200).send("OK");

  const chatId = message.chat.id;
  const userId = message.from.id;

  // 1. Validasi Keamanan User ID
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    await sendTelegramMessage(
      BOT_TOKEN,
      chatId,
      "⛔ Akses ditolak. Bot ini privat.",
    );
    return res.status(200).send("OK");
  }

  // 2. Handle Command Teks Cepat
  const text = message.text?.trim() || message.caption?.trim() || "";

  if (text === "/start" || text === "/bantuan") {
    const welcomeText =
      `👋 *Halo! Saya Bot Pencatat Pengeluaran.*\n\n` +
      `Kirimkan catatan pengeluaran dengan cara:\n` +
      `• *Teks:* "Makan siang 25rb" atau "Bensin 50k"\n` +
      `• *Foto:* Kirim foto struk/nota belanjaan\n\n` +
      `*Perintah Rekapitulasi:*\n` +
      `• /hari_ini - Rekap pengeluaran hari ini\n` +
      `• /minggu_ini - Rekap 7 hari terakhir\n` +
      `• /bulan_ini - Rekap bulan berjalan`;

    await sendTelegramMessage(BOT_TOKEN, chatId, welcomeText);
    return res.status(200).send("OK");
  }

  try {
    const supabase = createClient(SUPABASE_URL!, SUPABASE_KEY!);

    // 3. Handle Perintah Rekapitulasi
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
          BOT_TOKEN,
          chatId,
          `📊 Belum ada pengeluaran yang tercatat untuk periode ini.`,
        );
        return res.status(200).send("OK");
      }

      const total = data.reduce(
        (acc: number, curr: any) => acc + Number(curr.amount),
        0,
      );
      let summary = `📊 *Rekap Pengeluaran (${text.replace("/", "")})*\n`;
      summary += `💰 *Total:* Rp ${total.toLocaleString("id-ID")}\n\n*Rincian:*`;

      data.forEach((item: any) => {
        summary += `\n• [${item.category}] Rp ${Number(item.amount).toLocaleString("id-ID")} - ${item.description || "-"}`;
      });

      await sendTelegramMessage(BOT_TOKEN, chatId, summary);
      return res.status(200).send("OK");
    }

    // 4. Handle Input Pengeluaran (Teks atau Foto Nota)
    const ai = new GoogleGenAI({ apiKey: GEMINI_KEY! });
    let contents: any[] = [];

    if (message.photo) {
      const highestResPhoto = message.photo[message.photo.length - 1];
      const fileUrl = await getTelegramFileUrl(
        BOT_TOKEN,
        highestResPhoto.file_id,
      );

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

    // Ekstraksi AI
    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
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

    // 5. Simpan ke Supabase
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

      await sendTelegramMessage(BOT_TOKEN, chatId, replyText);
    } else {
      await sendTelegramMessage(
        BOT_TOKEN,
        chatId,
        "⚠️ Gagal mengenali format pengeluaran. Coba ketik lebih jelas.",
      );
    }

    return res.status(200).send("OK");
  } catch (err: any) {
    console.error("Detail Runtime Error:", err);
    await sendTelegramMessage(
      BOT_TOKEN,
      chatId,
      `❌ Terjadi kesalahan: ${err?.message || "Server error"}`,
    );
    return res.status(200).send("Error");
  }
}
