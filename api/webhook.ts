import { createClient } from "@supabase/supabase-js";

// Helper kirim pesan balik ke Telegram
async function sendTelegram(token: string, chatId: number, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error("Telegram API Error:", data);
  }
  return data;
}

// Helper Gemini Flash REST API
async function parseWithGemini(
  apiKey: string,
  promptText: string,
  imageBase64?: string,
) {
  const parts: any[] = [{ text: promptText }];
  if (imageBase64) {
    parts.unshift({
      inline_data: { mime_type: "image/jpeg", data: imageBase64 },
    });
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          response_mime_type: "application/json",
          response_schema: {
            type: "OBJECT",
            properties: {
              amount: {
                type: "NUMBER",
                description: "Total pengeluaran angka saja",
              },
              category: { type: "STRING", description: "Kategori pengeluaran" },
              description: {
                type: "STRING",
                description: "Deskripsi transaksi",
              },
            },
            required: ["amount", "category", "description"],
          },
        },
      }),
    },
  );

  const json = await res.json();
  const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text;
  return JSON.parse(rawText || "{}");
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(200).json({ status: "Webhook endpoint ready" });
  }

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const GEMINI_KEY = process.env.GEMINI_API_KEY?.trim();

  if (!BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN missing");
    return res.status(200).send("Missing token");
  }

  // Handle parsing body Vercel Serverless
  let update = req.body;
  if (typeof update === "string") {
    try {
      update = JSON.parse(update);
    } catch (e) {
      console.error("JSON Parse error", e);
    }
  }

  const message = update?.message;
  if (!message) {
    return res.status(200).send("No message payload");
  }

  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text?.trim() || message.caption?.trim() || "";

  // 1. Respon Perintah Dasar
  if (text === "/start" || text === "/bantuan") {
    await sendTelegram(
      BOT_TOKEN,
      chatId,
      `👋 *Bot Pencatat Pengeluaran Aktif!*\n\n` +
        `Kirimkan pengeluaran:\n` +
        `• *Teks:* "Beli kopi 25rb" atau "Bensin 50k"\n` +
        `• *Foto:* Kirim foto struk/nota\n\n` +
        `*Perintah Rekap:*\n` +
        `• /hari_ini\n• /minggu_ini\n• /bulan_ini`,
    );
    return res.status(200).send("OK");
  }

  try {
    const supabase = createClient(SUPABASE_URL!, SUPABASE_KEY!);

    // 2. Respon Rekapitulasi
    if (
      text === "/hari_ini" ||
      text === "/minggu_ini" ||
      text === "/bulan_ini"
    ) {
      const now = new Date();
      let startDate = new Date();

      if (text === "/hari_ini") startDate.setHours(0, 0, 0, 0);
      if (text === "/minggu_ini") startDate.setDate(now.getDate() - 7);
      if (text === "/bulan_ini")
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);

      const { data, error } = await supabase
        .from("expenses")
        .select("amount, category, description")
        .eq("user_id", userId)
        .gte("created_at", startDate.toISOString());

      if (error || !data || data.length === 0) {
        await sendTelegram(
          BOT_TOKEN,
          chatId,
          `📊 Belum ada data untuk periode ini.`,
        );
        return res.status(200).send("OK");
      }

      const total = data.reduce(
        (acc: number, curr: any) => acc + Number(curr.amount),
        0,
      );
      let summary = `📊 *Rekap Pengeluaran*\n💰 *Total:* Rp ${total.toLocaleString("id-ID")}\n\n*Rincian:*`;
      data.forEach((item: any) => {
        summary += `\n• [${item.category}] Rp ${Number(item.amount).toLocaleString("id-ID")} - ${item.description}`;
      });

      await sendTelegram(BOT_TOKEN, chatId, summary);
      return res.status(200).send("OK");
    }

    // 3. Respon Ekstraksi Teks / Foto
    let parsed: any = null;

    if (message.photo) {
      const photo = message.photo[message.photo.length - 1];
      const fileRes = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${photo.file_id}`,
      );
      const fileData = await fileRes.json();
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;

      const buffer = await fetch(fileUrl).then((r) => r.arrayBuffer());
      const base64 = Buffer.from(buffer).toString("base64");

      parsed = await parseWithGemini(
        GEMINI_KEY!,
        "Ekstrak nominal belanja, kategori, dan deskripsi dari nota ini.",
        base64,
      );
    } else if (text) {
      parsed = await parseWithGemini(
        GEMINI_KEY!,
        `Ekstrak nominal, kategori, dan deskripsi: "${text}"`,
      );
    }

    if (parsed?.amount) {
      await supabase.from("expenses").insert({
        user_id: userId,
        amount: parsed.amount,
        category: parsed.category || "Lainnya",
        description: parsed.description || "-",
      });

      await sendTelegram(
        BOT_TOKEN,
        chatId,
        `✅ *Tercatat!*\n💵 *Nominal:* Rp ${Number(parsed.amount).toLocaleString("id-ID")}\n📂 *Kategori:* ${parsed.category}\n📝 *Keterangan:* ${parsed.description}`,
      );
    } else {
      await sendTelegram(
        BOT_TOKEN,
        chatId,
        "⚠️ Gagal mendeteksi format pengeluaran.",
      );
    }

    return res.status(200).send("OK");
  } catch (err: any) {
    console.error("Execution Error:", err);
    await sendTelegram(
      BOT_TOKEN,
      chatId,
      `❌ Error: ${err.message || "Gagal memproses"}`,
    );
    return res.status(200).send("OK");
  }
}
