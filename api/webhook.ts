import { createClient } from "@supabase/supabase-js";

// 1. Helper Action Mengetik
async function sendChatAction(
  token: string,
  chatId: number,
  action: "typing" | "upload_photo" = "typing",
) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch (err) {
    console.error("Error sendChatAction:", err);
  }
}

// 2. Helper Kirim Pesan HTML Telegram
async function sendTelegram(token: string, chatId: number, text: string) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      },
    );
    const data = await res.json();
    if (!data.ok) console.error("Telegram API Error:", data);
    return data;
  } catch (err) {
    console.error("Network Error sendTelegram:", err);
  }
}

// 3. AI Engine: Routing Intent & Ekstraksi Cerdas
async function processWithGemini(
  apiKey: string,
  promptText: string,
  currentDate: string,
  imageBase64?: string,
) {
  const parts: any[] = [
    {
      text: `Current Timestamp ISO: ${currentDate}.
Instruksi: Analisis pesan atau nota berikut. Tentukan intent user dari 4 kategori:
1. "ADD_EXPENSE": Mencatat transaksi nota/teks. Untuk nota, ekstrak tiap item barang, beserta info pajak/PPN/service charge jika ada.
2. "QUERY_EXPENSE": Rekap daftar tabel pengeluaran biasa (misal: "rekap hari ini", "pengeluaran minggu ini").
3. "ANALYZE_EXPENSE": Tanya jawab spesifik, hitung harga satuan, split bill, atau perhitungan PPN/pajak (misal: "berapa harga 1 kale salad?", "saya cuma pesan minum hitungkan plus PPN", "harga sebelum PPN berapa?").
4. "DELETE_EXPENSE": Menghapus data (semua / terakhir).

Kembalikan response dalam format JSON valid.`,
    },
    { text: promptText },
  ];

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
              intent: {
                type: "STRING",
                description:
                  "ADD_EXPENSE | QUERY_EXPENSE | ANALYZE_EXPENSE | DELETE_EXPENSE",
              },
              items: {
                type: "ARRAY",
                description: "Daftar item jika ADD_EXPENSE",
                items: {
                  type: "OBJECT",
                  properties: {
                    description: {
                      type: "STRING",
                      description:
                        "Nama barang, jumlah qty, dan catatan PPN jika ada",
                    },
                    amount: {
                      type: "NUMBER",
                      description: "Nominal harga subtotal item",
                    },
                    category: {
                      type: "STRING",
                      description:
                        "Makanan, Minuman, Belanja, Transportasi, Tagihan, Pajak/Service, Lainnya",
                    },
                  },
                  required: ["description", "amount", "category"],
                },
              },
              search_keyword: {
                type: "STRING",
                description:
                  "Kata kunci pencarian nama barang jika ANALYZE_EXPENSE",
              },
              query_filter: {
                type: "OBJECT",
                description: "Filter query jika QUERY_EXPENSE",
                properties: {
                  start_date: { type: "STRING" },
                  end_date: { type: "STRING" },
                  category: { type: "STRING" },
                  title: { type: "STRING" },
                },
              },
              delete_type: {
                type: "STRING",
                description:
                  '"ALL" jika hapus semua, "LAST" jika hapus 1 terakhir',
              },
            },
            required: ["intent"],
          },
        },
      }),
    },
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Gemini API Error: ${errorText}`);
  }

  const json = await res.json();
  const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text;
  return JSON.parse(rawText || '{"intent":"ADD_EXPENSE","items":[]}');
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(200).send("Webhook ready");

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID
    ? Number(process.env.ALLOWED_USER_ID.trim())
    : null;
  const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const GEMINI_KEY = process.env.GEMINI_API_KEY?.trim();

  if (!BOT_TOKEN) return res.status(200).send("Missing BOT_TOKEN");

  let update = req.body;
  if (typeof update === "string") {
    try {
      update = JSON.parse(update);
    } catch {
      return res.status(200).send("Bad JSON");
    }
  }

  const message = update?.message;
  if (!message) return res.status(200).send("No message");

  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text?.trim() || message.caption?.trim() || "";

  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    await sendTelegram(
      BOT_TOKEN,
      chatId,
      `⛔ Akses ditolak. ID Akun: <code>${userId}</code>`,
    );
    return res.status(200).send("OK");
  }

  // Info Bantuan
  if (text === "/start" || text === "/bantuan") {
    await sendTelegram(
      BOT_TOKEN,
      chatId,
      `👋 <b>Bot AI Finansial Siap!</b>\n\n` +
        `<b>Fitur yang didukung:</b>\n` +
        `• <b>Input Nota & Teks:</b> Kirim struk foto atau teks rincian belanja.\n` +
        `• <b>Hitung Pajak & Split Bill:</b> <i>"Berapa harga 1 kale salad sebelum PPN?"</i> atau <i>"Kalau saya cuma pesan minum + PPN jadi berapa?"</i>\n` +
        `• <b>Rekapitulasi Fleksibel:</b> <i>"Total pengeluaran hari ini kategori makanan"</i>\n` +
        `• <b>Hapus Data:</b> <i>"Hapus data terakhir"</i> atau <i>/reset_semua</i>`,
    );
    return res.status(200).send("OK");
  }

  await sendChatAction(BOT_TOKEN, chatId, "typing");

  try {
    const supabase = createClient(SUPABASE_URL!, SUPABASE_KEY!);
    const nowIso = new Date().toISOString();

    let aiResult: any = null;

    if (message.photo) {
      const photo = message.photo[message.photo.length - 1];
      const fileRes = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${photo.file_id}`,
      );
      const fileData = await fileRes.json();
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;

      const buffer = await fetch(fileUrl).then((r) => r.arrayBuffer());
      const base64 = Buffer.from(buffer).toString("base64");

      aiResult = await processWithGemini(
        GEMINI_KEY!,
        text ||
          "Ekstrak semua baris item barang/makanan, subtotal, serta PPN/Service Tax dari nota ini secara detail.",
        nowIso,
        base64,
      );
    } else {
      aiResult = await processWithGemini(GEMINI_KEY!, text, nowIso);
    }

    // 1. INTENT: ANALYZE_EXPENSE (Tanya Jawab Satuan, Pajak, Split Bill)
    if (aiResult.intent === "ANALYZE_EXPENSE") {
      let query = supabase
        .from("expenses")
        .select("description, amount, category, created_at")
        .eq("user_id", userId);

      if (aiResult.search_keyword) {
        query = query.ilike("description", `%${aiResult.search_keyword}%`);
      }

      // Ambil riwayat transaksi terbaru sebagai konteks
      const { data: history } = await query
        .order("created_at", { ascending: false })
        .limit(25);

      if (!history || history.length === 0) {
        await sendTelegram(
          BOT_TOKEN,
          chatId,
          `🔍 Tidak ditemukan data transaksi terkait untuk menjawab pertanyaan tersebut.`,
        );
        return res.status(200).send("OK");
      }

      // Minta AI menghitung dan menjawab pertanyaan pengguna
      const answerRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: `Kamu adalah asisten keuangan pintar. Gunakan data transaksi berikut untuk menjawab pertanyaan user secara akurat.
Data Transaksi Database:
${JSON.stringify(history, null, 2)}

Pertanyaan User: "${text}"

Instruksi:
- Jawab secara to the point, jelas, dan ramah.
- Jika user menanyakan harga satuan, bagikan total nominal dengan kuantitas item.
- Jika user menanyakan perhitungan PPN / Service Charge / Split Bill untuk sebagian pesanan saja, hitung proporsinya secara matematis dan tunjukkan rincian perhitungannya.`,
                  },
                ],
              },
            ],
          }),
        },
      );

      const ansJson = await answerRes.json();
      const botAnswer =
        ansJson.candidates?.[0]?.content?.parts?.[0]?.text ||
        "Gagal menghitung jawaban.";

      // Bersihkan markdown bintang ganda ke HTML bold jika perlu
      const formattedAnswer = botAnswer
        .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
        .replace(/\*(.*?)\*/g, "<i>$1</i>");

      await sendTelegram(BOT_TOKEN, chatId, formattedAnswer);
      return res.status(200).send("OK");
    }

    // 2. INTENT: QUERY_EXPENSE (Rekapitulasi List)
    if (aiResult.intent === "QUERY_EXPENSE") {
      const filter = aiResult.query_filter || {};
      let query = supabase
        .from("expenses")
        .select("amount, category, description, created_at")
        .eq("user_id", userId);

      if (filter.start_date) {
        query = query.gte("created_at", filter.start_date);
      } else {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        query = query.gte("created_at", today.toISOString());
      }

      if (filter.end_date) query = query.lte("created_at", filter.end_date);
      if (filter.category)
        query = query.ilike("category", `%${filter.category}%`);

      const { data, error } = await query.order("created_at", {
        ascending: true,
      });

      if (error || !data || data.length === 0) {
        const catInfo = filter.category
          ? ` untuk kategori <b>${filter.category}</b>`
          : "";
        await sendTelegram(
          BOT_TOKEN,
          chatId,
          `📊 Tidak ditemukan catatan pengeluaran${catInfo} pada periode tersebut.`,
        );
        return res.status(200).send("OK");
      }

      const total = data.reduce(
        (acc: number, curr: any) => acc + Number(curr.amount),
        0,
      );
      const title = filter.title || "Laporan Pengeluaran";

      let reply = `📊 <b>${title}</b>\n💰 <b>Total:</b> Rp ${total.toLocaleString("id-ID")}\n\n<b>Rincian:</b>`;
      data.forEach((item: any, idx: number) => {
        reply += `\n${idx + 1}. <b>${item.description}</b> (<i>${item.category}</i>): Rp ${Number(item.amount).toLocaleString("id-ID")}`;
      });

      await sendTelegram(BOT_TOKEN, chatId, reply);
      return res.status(200).send("OK");
    }

    // 3. INTENT: DELETE_EXPENSE
    if (aiResult.intent === "DELETE_EXPENSE") {
      if (aiResult.delete_type === "ALL" || text === "/reset_semua") {
        await supabase.from("expenses").delete().eq("user_id", userId);
        await sendTelegram(
          BOT_TOKEN,
          chatId,
          "🗑️ <b>Semua data pengeluaran kamu telah dihapus bersih.</b>",
        );
      } else {
        const { data: lastItem } = await supabase
          .from("expenses")
          .select("id, description, amount")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(1)
          .single();

        if (lastItem) {
          await supabase.from("expenses").delete().eq("id", lastItem.id);
          await sendTelegram(
            BOT_TOKEN,
            chatId,
            `🗑️ <b>Transaksi terakhir dihapus:</b>\n• ${lastItem.description} (Rp ${Number(lastItem.amount).toLocaleString("id-ID")})`,
          );
        } else {
          await sendTelegram(
            BOT_TOKEN,
            chatId,
            "⚠️ Tidak ada data untuk dihapus.",
          );
        }
      }
      return res.status(200).send("OK");
    }

    // 4. INTENT: ADD_EXPENSE (Pencatatan Item & Pajak)
    const items = aiResult.items || [];
    if (items.length > 0) {
      const payload = items.map((it: any) => ({
        user_id: userId,
        amount: it.amount,
        category: it.category || "Lainnya",
        description: it.description || "-",
      }));

      const { error: insErr } = await supabase.from("expenses").insert(payload);
      if (insErr) throw insErr;

      const total = items.reduce(
        (acc: number, it: any) => acc + Number(it.amount),
        0,
      );
      let reply = `✅ <b>${items.length} Transaksi Tercatat!</b>\n💰 <b>Total:</b> Rp ${total.toLocaleString("id-ID")}\n\n<b>Rincian Item:</b>`;
      items.forEach((it: any, i: number) => {
        reply += `\n${i + 1}. <b>${it.description}</b>: Rp ${Number(it.amount).toLocaleString("id-ID")} (<i>${it.category}</i>)`;
      });

      await sendTelegram(BOT_TOKEN, chatId, reply);
    } else {
      await sendTelegram(BOT_TOKEN, chatId, "⚠️ Pesan tidak dapat diproses.");
    }

    return res.status(200).send("OK");
  } catch (err: any) {
    console.error("Webhook Runtime Error:", err);
    await sendTelegram(
      BOT_TOKEN,
      chatId,
      `❌ Error: ${err.message || "Gagal memproses"}`,
    );
    return res.status(200).send("OK");
  }
}
