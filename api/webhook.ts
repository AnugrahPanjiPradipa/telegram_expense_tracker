import { createClient } from '@supabase/supabase-js';

// 1. Helper Kirim Pesan Telegram (Menggunakan HTML Parse Mode agar anti error parsing)
async function sendTelegram(token: string, chatId: number, text: string) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('Telegram API Error:', data);
    }
    return data;
  } catch (err) {
    console.error('Network Error sendTelegram:', err);
  }
}

// 2. Helper Gemini REST API (Structured JSON Extraction)
async function parseWithGemini(apiKey: string, promptText: string, imageBase64?: string) {
  const parts: any[] = [{ text: promptText }];
  if (imageBase64) {
    parts.unshift({
      inline_data: { mime_type: 'image/jpeg', data: imageBase64 },
    });
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          response_mime_type: 'application/json',
          response_schema: {
            type: 'OBJECT',
            properties: {
              amount: { type: 'NUMBER', description: 'Total nominal angka saja' },
              category: { type: 'STRING', description: 'Kategori (Makanan, Transportasi, Belanja, Tagihan, Lainnya)' },
              description: { type: 'STRING', description: 'Rincian atau keterangan transaksi' },
            },
            required: ['amount', 'category', 'description'],
          },
        },
      }),
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Gemini API Error: ${errorText}`);
  }

  const json = await res.json();
  const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text;
  return JSON.parse(rawText || '{}');
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(200).send('Webhook is active!');
  }

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID ? Number(process.env.ALLOWED_USER_ID.trim()) : null;
  const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const GEMINI_KEY = process.env.GEMINI_API_KEY?.trim();

  if (!BOT_TOKEN) {
    console.error('Missing TELEGRAM_BOT_TOKEN');
    return res.status(200).send('Missing BOT_TOKEN');
  }

  // Parse Body Update Telegram
  let update = req.body;
  if (typeof update === 'string') {
    try {
      update = JSON.parse(update);
    } catch (e) {
      console.error('JSON body parse error:', e);
    }
  }

  const message = update?.message;
  if (!message) {
    return res.status(200).send('No message received');
  }

  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text?.trim() || message.caption?.trim() || '';

  // Validasi User ID
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    await sendTelegram(BOT_TOKEN, chatId, `⛔ Akses ditolak. Akun kamu (<code>${userId}</code>) belum diizinkan.`);
    return res.status(200).send('OK');
  }

  // 1. Perintah Start / Bantuan
  if (text === '/start' || text === '/bantuan') {
    const welcomeText =
      `👋 <b>Halo! Saya Bot Pencatat Pengeluaran.</b>\n\n` +
      `Kirimkan catatan pengeluaran dengan cara:\n` +
      `• <b>Teks:</b> "Makan siang 25rb" atau "Beli bensin 50k"\n` +
      `• <b>Foto:</b> Kirim foto nota / struk belanjaan\n\n` +
      `<b>Perintah Rekap:</b>\n` +
      `• /hari_ini - Rekap hari ini\n` +
      `• /minggu_ini - Rekap 7 hari terakhir\n` +
      `• /bulan_ini - Rekap bulan ini`;

    await sendTelegram(BOT_TOKEN, chatId, welcomeText);
    return res.status(200).send('OK');
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      throw new Error('Supabase URL atau Key belum diset.');
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // 2. Perintah Rekapitulasi
    if (text === '/hari_ini' || text === '/minggu_ini' || text === '/bulan_ini') {
      const now = new Date();
      let startDate = new Date();

      if (text === '/hari_ini') {
        startDate.setHours(0, 0, 0, 0);
      } else if (text === '/minggu_ini') {
        startDate.setDate(now.getDate() - 7);
      } else if (text === '/bulan_ini') {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      }

      const { data, error } = await supabase
        .from('expenses')
        .select('amount, category, description')
        .eq('user_id', userId)
        .gte('created_at', startDate.toISOString());

      if (error || !data || data.length === 0) {
        await sendTelegram(BOT_TOKEN, chatId, `📊 Belum ada data pengeluaran untuk periode ini.`);
        return res.status(200).send('OK');
      }

      const total = data.reduce((acc: number, curr: any) => acc + Number(curr.amount), 0);
      let summary = `📊 <b>Rekap Pengeluaran (${text.replace('/', '')})</b>\n`;
      summary += `💰 <b>Total:</b> Rp ${total.toLocaleString('id-ID')}\n\n<b>Rincian:</b>`;

      data.forEach((item: any) => {
        summary += `\n• [${item.category}] Rp ${Number(item.amount).toLocaleString('id-ID')} - ${item.description || '-'}`;
      });

      await sendTelegram(BOT_TOKEN, chatId, summary);
      return res.status(200).send('OK');
    }

    // 3. Parsing Input (Teks / Foto Nota)
    if (!GEMINI_KEY) {
      throw new Error('GEMINI_API_KEY belum diset.');
    }

    let parsedData: any = null;

    if (message.photo) {
      const photo = message.photo[message.photo.length - 1];
      const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${photo.file_id}`);
      const fileData = await fileRes.json();
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;

      const imageBuffer = await fetch(fileUrl).then((r) => r.arrayBuffer());
      const base64Image = Buffer.from(imageBuffer).toString('base64');

      parsedData = await parseWithGemini(
        GEMINI_KEY,
        'Ekstrak total nominal belanja, kategori utama, dan rincian transaksi dari gambar nota ini.',
        base64Image
      );
    } else if (text) {
      parsedData = await parseWithGemini(
        GEMINI_KEY,
        `Ekstrak nominal pengeluaran, kategori, dan rincian dari pesan ini: "${text}"`
      );
    } else {
      return res.status(200).send('OK');
    }

    // 4. Simpan ke Supabase
    if (parsedData?.amount) {
      await supabase.from('expenses').insert({
        user_id: userId,
        amount: parsedData.amount,
        category: parsedData.category || 'Lainnya',
        description: parsedData.description || '-',
      });

      const replyText =
        `✅ <b>Tercatat!</b>\n` +
        `💵 <b>Nominal:</b> Rp ${Number(parsedData.amount).toLocaleString('id-ID')}\n` +
        `📂 <b>Kategori:</b> ${parsedData.category}\n` +
        `📝 <b>Keterangan:</b> ${parsedData.description}`;

      await sendTelegram(BOT_TOKEN, chatId, replyText);
    } else {
      await sendTelegram(BOT_TOKEN, chatId, '⚠️ Gagal mengenali format pengeluaran.');
    }

    return res.status(200).send('OK');
  } catch (err: any) {
    console.error('Webhook Runtime Error:', err);
    await sendTelegram(BOT_TOKEN, chatId, `❌ Terjadi kesalahan: ${err?.message || 'Server error'}`);
    return res.status(200).send('OK');
  }
}