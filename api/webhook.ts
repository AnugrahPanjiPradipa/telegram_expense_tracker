import { createClient } from '@supabase/supabase-js';

// 1. Helper Kirim Pesan Telegram
async function sendTelegramMessage(token: string, chatId: number, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch (err) {
    console.error('Error sendTelegramMessage:', err);
  }
}

// 2. Helper Ambil URL Foto Telegram
async function getTelegramFileUrl(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const data = await res.json();
  return `https://api.telegram.org/file/bot${token}/${data.result.file_path}`;
}

// 3. Helper Ekstraksi Gemini via Native REST API
async function extractExpenseWithGemini(apiKey: string, promptText: string, imageBase64?: string) {
  const parts: any[] = [{ text: promptText }];

  if (imageBase64) {
    parts.unshift({
      inline_data: {
        mime_type: 'image/jpeg',
        data: imageBase64,
      },
    });
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  const res = await fetch(endpoint, {
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
            description: { type: 'STRING', description: 'Keterangan ringkas transaksi' },
          },
          required: ['amount', 'category', 'description'],
        },
      },
    }),
  });

  if (!res.ok) {
    const errorDetail = await res.text();
    throw new Error(`Gemini API Error: ${errorDetail}`);
  }

  const data = await res.json();
  const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return JSON.parse(rawJson || '{}');
}

export default async function handler(req: any, res: any) {
  // Selalu return 200 untuk metode selain POST agar Vercel tidak error 500
  if (req.method !== 'POST') {
    return res.status(200).send('Webhook is running');
  }

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID ? Number(process.env.ALLOWED_USER_ID.trim()) : null;
  const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const GEMINI_KEY = process.env.GEMINI_API_KEY?.trim();

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(200).send('Invalid body');
    }
  }

  const message = body?.message;
  if (!message || !BOT_TOKEN) {
    return res.status(200).send('OK');
  }

  const chatId = message.chat.id;
  const userId = message.from.id;

  // Cek Whitelist User
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    await sendTelegramMessage(BOT_TOKEN, chatId, `⛔ Akses ditolak. Akun kamu (\`${userId}\`) belum terdaftar.`);
    return res.status(200).send('OK');
  }

  const text = message.text?.trim() || message.caption?.trim() || '';

  // Perintah /start dan /bantuan
  if (text === '/start' || text === '/bantuan') {
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
    return res.status(200).send('OK');
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      throw new Error('Supabase environment variables belum diset di Vercel.');
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Perintah Rekapitulasi
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
        await sendTelegramMessage(BOT_TOKEN, chatId, `📊 Belum ada pengeluaran yang tercatat untuk periode ini.`);
        return res.status(200).send('OK');
      }

      const total = data.reduce((acc: number, curr: any) => acc + Number(curr.amount), 0);
      let summary = `📊 *Rekap Pengeluaran (${text.replace('/', '')})*\n`;
      summary += `💰 *Total:* Rp ${total.toLocaleString('id-ID')}\n\n*Rincian:*`;

      data.forEach((item: any) => {
        summary += `\n• [${item.category}] Rp ${Number(item.amount).toLocaleString('id-ID')} - ${item.description || '-'}`;
      });

      await sendTelegramMessage(BOT_TOKEN, chatId, summary);
      return res.status(200).send('OK');
    }

    // Input Data (Teks / Foto)
    if (!GEMINI_KEY) {
      throw new Error('GEMINI_API_KEY belum diset di Vercel.');
    }

    let parsedData: any = null;

    if (message.photo) {
      const photo = message.photo[message.photo.length - 1];
      const fileUrl = await getTelegramFileUrl(BOT_TOKEN, photo.file_id);
      const buffer = await fetch(fileUrl).then((r) => r.arrayBuffer());
      const base64 = Buffer.from(buffer).toString('base64');

      parsedData = await extractExpenseWithGemini(
        GEMINI_KEY,
        'Ekstrak total nominal belanja, kategori, dan deskripsi singkat dari foto nota ini.',
        base64
      );
    } else if (text) {
      parsedData = await extractExpenseWithGemini(
        GEMINI_KEY,
        `Ekstrak nominal pengeluaran, kategori, dan deskripsi dari pesan ini: "${text}"`
      );
    } else {
      return res.status(200).send('OK');
    }

    // Simpan ke Supabase
    if (parsedData?.amount) {
      await supabase.from('expenses').insert({
        user_id: userId,
        amount: parsedData.amount,
        category: parsedData.category || 'Lainnya',
        description: parsedData.description || '-',
      });

      const replyText =
        `✅ *Tercatat!*\n` +
        `💵 *Nominal:* Rp ${Number(parsedData.amount).toLocaleString('id-ID')}\n` +
        `📂 *Kategori:* ${parsedData.category}\n` +
        `📝 *Keterangan:* ${parsedData.description}`;

      await sendTelegramMessage(BOT_TOKEN, chatId, replyText);
    } else {
      await sendTelegramMessage(BOT_TOKEN, chatId, '⚠️ Gagal mengenali format pengeluaran.');
    }

    return res.status(200).send('OK');
  } catch (err: any) {
    console.error('Error in webhook:', err);
    await sendTelegramMessage(BOT_TOKEN, chatId, `❌ Terjadi kesalahan: ${err?.message || 'Internal error'}`);
    return res.status(200).send('OK'); // Tetap balas 200 agar Telegram tidak retry terus
  }
}