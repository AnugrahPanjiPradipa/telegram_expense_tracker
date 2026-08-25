import { createClient } from '@supabase/supabase-js';

async function sendChatAction(token: string, chatId: number, action: 'typing' | 'upload_photo' = 'typing') {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch (err) {
    console.error('Error sendChatAction:', err);
  }
}

async function sendTelegram(token: string, chatId: number, text: string) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram API Error:', data);
    return data;
  } catch (err) {
    console.error('Network Error sendTelegram:', err);
  }
}

async function parseExpensesWithGemini(apiKey: string, promptText: string, imageBase64?: string) {
  const parts: any[] = [{ text: promptText }];
  if (imageBase64) {
    parts.unshift({
      inline_data: { mime_type: 'image/jpeg', data: imageBase64 },
    });
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
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
              intent: { 
                type: 'STRING', 
                description: 'Tujuan user: "ADD_EXPENSE" jika mencatat, "DELETE_ALL" jika meminta menghapus semua data, "DELETE_LAST" jika menghapus input terakhir' 
              },
              items: {
                type: 'ARRAY',
                description: 'Daftar item belanja jika intent ADD_EXPENSE',
                items: {
                  type: 'OBJECT',
                  properties: {
                    description: { type: 'STRING', description: 'Nama barang / keterangan' },
                    amount: { type: 'NUMBER', description: 'Nominal harga angka saja' },
                    category: { type: 'STRING', description: 'Kategori (Makanan, Minuman, Belanja, Transportasi, Tagihan, Lainnya)' },
                  },
                  required: ['description', 'amount', 'category'],
                },
              },
            },
            required: ['intent', 'items'],
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
  return JSON.parse(rawText || '{"intent":"ADD_EXPENSE","items":[]}');
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(200).send('Webhook active');

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID ? Number(process.env.ALLOWED_USER_ID.trim()) : null;
  const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const GEMINI_KEY = process.env.GEMINI_API_KEY?.trim();

  if (!BOT_TOKEN) return res.status(200).send('Missing token');

  let update = req.body;
  if (typeof update === 'string') {
    try { update = JSON.parse(update); } catch { return res.status(200).send('Bad JSON'); }
  }

  const message = update?.message;
  if (!message) return res.status(200).send('No message');

  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text?.trim() || message.caption?.trim() || '';

  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    await sendTelegram(BOT_TOKEN, chatId, `⛔ Akses ditolak. ID Anda: <code>${userId}</code>`);
    return res.status(200).send('OK');
  }

  // 1. Menu Perintah Cepat
  if (text === '/start' || text === '/bantuan') {
    const welcomeText =
      `👋 <b>Halo! Bot Pencatat Pengeluaran Siap Digunakan.</b>\n\n` +
      `<b>Cara Input:</b>\n` +
      `• Teks: "Makan siang 25rb"\n` +
      `• Foto: Kirim foto struk belanja\n\n` +
      `<b>Perintah Rekap:</b>\n` +
      `• /hari_ini | /minggu_ini | /bulan_ini\n\n` +
      `<b>Perintah Hapus:</b>\n` +
      `• /hapus_terakhir - Hapus 1 transaksi terakhir\n` +
      `• /reset_semua - Hapus seluruh data pengeluaran Anda`;

    await sendTelegram(BOT_TOKEN, chatId, welcomeText);
    return res.status(200).send('OK');
  }

  try {
    const supabase = createClient(SUPABASE_URL!, SUPABASE_KEY!);

    // 2. Handler Command Hapus Cepat
    if (text === '/reset_semua') {
      await supabase.from('expenses').delete().eq('user_id', userId);
      await sendTelegram(BOT_TOKEN, chatId, '🗑️ <b>Semua data pengeluaran Anda berhasil dihapus bersih dari database.</b>');
      return res.status(200).send('OK');
    }

    if (text === '/hapus_terakhir') {
      const { data: lastItem } = await supabase
        .from('expenses')
        .select('id, description, amount')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!lastItem) {
        await sendTelegram(BOT_TOKEN, chatId, '⚠️ Belum ada transaksi yang bisa dihapus.');
        return res.status(200).send('OK');
      }

      await supabase.from('expenses').delete().eq('id', lastItem.id);
      await sendTelegram(
        BOT_TOKEN,
        chatId,
        `🗑️ <b>Transaksi terakhir dihapus:</b>\n• ${lastItem.description} (Rp ${Number(lastItem.amount).toLocaleString('id-ID')})`
      );
      return res.status(200).send('OK');
    }

    // 3. Handler Rekapitulasi
    if (text === '/hari_ini' || text === '/minggu_ini' || text === '/bulan_ini') {
      await sendChatAction(BOT_TOKEN, chatId, 'typing');
      const now = new Date();
      let startDate = new Date();

      if (text === '/hari_ini') startDate.setHours(0, 0, 0, 0);
      if (text === '/minggu_ini') startDate.setDate(now.getDate() - 7);
      if (text === '/bulan_ini') startDate = new Date(now.getFullYear(), now.getMonth(), 1);

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

    // 4. Analisis Teks / Foto dengan Gemini
    await sendChatAction(BOT_TOKEN, chatId, 'typing');

    let parsedResult: { intent: string; items: Array<{ amount: number; category: string; description: string }> } = {
      intent: 'ADD_EXPENSE',
      items: [],
    };

    if (message.photo) {
      const photo = message.photo[message.photo.length - 1];
      const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${photo.file_id}`);
      const fileData = await fileRes.json();
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;

      const imageBuffer = await fetch(fileUrl).then((r) => r.arrayBuffer());
      const base64Image = Buffer.from(imageBuffer).toString('base64');

      parsedResult = await parseExpensesWithGemini(
        GEMINI_KEY!,
        'Analisis nota ini. Ekstrak setiap item barang/makanan yang dibeli beserta harganya.',
        base64Image
      );
    } else if (text) {
      parsedResult = await parseExpensesWithGemini(
        GEMINI_KEY!,
        `Analisis teks berikut. Jika user ingin menghapus data (misal: "hapus semua", "tolong hapus database"), set intent ke DELETE_ALL atau DELETE_LAST. Jika user mencatat pengeluaran, set intent ADD_EXPENSE dan ekstrak items: "${text}"`
      );
    } else {
      return res.status(200).send('OK');
    }

    // Eksekusi Berdasarkan Intent AI
    if (parsedResult.intent === 'DELETE_ALL') {
      await supabase.from('expenses').delete().eq('user_id', userId);
      await sendTelegram(BOT_TOKEN, chatId, '🗑️ <b>Semua data transaksi kamu sudah berhasil dihapus dari database!</b>');
      return res.status(200).send('OK');
    }

    if (parsedResult.intent === 'DELETE_LAST') {
      const { data: lastItem } = await supabase
        .from('expenses')
        .select('id, description, amount')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (lastItem) {
        await supabase.from('expenses').delete().eq('id', lastItem.id);
        await sendTelegram(
          BOT_TOKEN,
          chatId,
          `🗑️ <b>Transaksi terakhir dihapus:</b>\n• ${lastItem.description} (Rp ${Number(lastItem.amount).toLocaleString('id-ID')})`
        );
      } else {
        await sendTelegram(BOT_TOKEN, chatId, '⚠️ Tidak ada transaksi yang ditemukan untuk dihapus.');
      }
      return res.status(200).send('OK');
    }

    // Intent Tambah Pengeluaran
    const items = parsedResult?.items || [];
    if (items.length > 0) {
      const insertPayload = items.map((item) => ({
        user_id: userId,
        amount: item.amount,
        category: item.category || 'Lainnya',
        description: item.description || '-',
      }));

      const { error: insertError } = await supabase.from('expenses').insert(insertPayload);
      if (insertError) throw insertError;

      const totalNominal = items.reduce((sum, item) => sum + Number(item.amount), 0);
      let replyText = `✅ <b>${items.length} Transaksi Berhasil Dicatat!</b>\n`;
      replyText += `💰 <b>Total:</b> Rp ${totalNominal.toLocaleString('id-ID')}\n\n<b>Rincian Item:</b>`;

      items.forEach((item, index) => {
        replyText += `\n${index + 1}. <b>${item.description}</b>: Rp ${Number(item.amount).toLocaleString('id-ID')} (<i>${item.category}</i>)`;
      });

      await sendTelegram(BOT_TOKEN, chatId, replyText);
    } else {
      await sendTelegram(BOT_TOKEN, chatId, '⚠️ Gagal mengenali format pengeluaran atau instruksi.');
    }

    return res.status(200).send('OK');
  } catch (err: any) {
    console.error('Execution Error:', err);
    await sendTelegram(BOT_TOKEN, chatId, `❌ Terjadi kesalahan: ${err?.message || 'Gagal memproses'}`);
    return res.status(200).send('OK');
  }
}