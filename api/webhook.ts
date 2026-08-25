import { createClient } from '@supabase/supabase-js';

// Helper Action Mengetik
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

// Helper Kirim Pesan HTML Telegram
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

// Brain Engine: Intent & Query Engine menggunakan Gemini
async function processWithGemini(apiKey: string, promptText: string, currentDate: string, imageBase64?: string) {
  const parts: any[] = [
    {
      text: `Current Timestamp ISO: ${currentDate}.
Instruksi: Analisis pesan atau foto berikut. Tentukan intent user dari 3 kemungkinan:
1. "ADD_EXPENSE": Mencatat transaksi (satu/banyak item).
2. "QUERY_EXPENSE": Bertanya total/rekap/rincian dengan filter dinamis (hari ini, minggu ini, hanya makanan, bulan lalu, dsb).
3. "DELETE_EXPENSE": Menghapus data (semua, item terakhir, atau spesifik).

Kembalikan response dalam JSON sesuai schema.`
    },
    { text: promptText }
  ];

  if (imageBase64) {
    parts.unshift({
      inline_data: { mime_type: 'image/jpeg', data: imageBase64 }
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
              intent: { type: 'STRING', description: 'ADD_EXPENSE | QUERY_EXPENSE | DELETE_EXPENSE' },
              items: {
                type: 'ARRAY',
                description: 'Daftar item jika ADD_EXPENSE',
                items: {
                  type: 'OBJECT',
                  properties: {
                    description: { type: 'STRING' },
                    amount: { type: 'NUMBER' },
                    category: { type: 'STRING', description: 'Makanan, Minuman, Belanja, Transportasi, Tagihan, Hiburan, Lainnya' }
                  },
                  required: ['description', 'amount', 'category']
                }
              },
              query_filter: {
                type: 'OBJECT',
                description: 'Filter query jika QUERY_EXPENSE',
                properties: {
                  start_date: { type: 'STRING', description: 'ISO date string awal filter (contoh: 2026-08-25T00:00:00.000Z)' },
                  end_date: { type: 'STRING', description: 'ISO date string akhir filter' },
                  category: { type: 'STRING', description: 'Nama kategori jika user meminta kategori tertentu (misal: Makanan), kosongkan jika semua' },
                  title: { type: 'STRING', description: 'Judul ringkasan laporan (misal: Pengeluaran Makanan Hari Ini)' }
                }
              },
              delete_type: { 
                type: 'STRING', 
                description: '"ALL" jika hapus semua, "LAST" jika hapus 1 terakhir' 
              }
            },
            required: ['intent']
          }
        }
      })
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
  if (req.method !== 'POST') return res.status(200).send('Webhook ready');

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID ? Number(process.env.ALLOWED_USER_ID.trim()) : null;
  const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const GEMINI_KEY = process.env.GEMINI_API_KEY?.trim();

  if (!BOT_TOKEN) return res.status(200).send('Missing BOT_TOKEN');

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
    await sendTelegram(BOT_TOKEN, chatId, `⛔ Akses ditolak. ID Akun: <code>${userId}</code>`);
    return res.status(200).send('OK');
  }

  // Info Dasar
  if (text === '/start' || text === '/bantuan') {
    await sendTelegram(
      BOT_TOKEN,
      chatId,
      `👋 <b>Bot AI Finansial Pribadi Siap!</b>\n\n` +
      `Kamu bisa berbicara santai dan fleksibel, contoh:\n` +
      `• <i>"Makan bakso 25rb sama es teh 5rb"</i>\n` +
      `• <i>"Kirim foto nota struk belanja"</i>\n` +
      `• <i>"Coba berikan saya rincian hari ini tapi hanya makanan saja"</i>\n` +
      `• <i>"Total pengeluaran bensin minggu ini berapa?"</i>\n` +
      `• <i>"Hapus data terakhir dong"</i> atau <i>"Reset semua data"</i>`
    );
    return res.status(200).send('OK');
  }

  await sendChatAction(BOT_TOKEN, chatId, 'typing');

  try {
    const supabase = createClient(SUPABASE_URL!, SUPABASE_KEY!);
    const nowIso = new Date().toISOString();

    let aiResult: any = null;

    if (message.photo) {
      const photo = message.photo[message.photo.length - 1];
      const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${photo.file_id}`);
      const fileData = await fileRes.json();
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;

      const buffer = await fetch(fileUrl).then((r) => r.arrayBuffer());
      const base64 = Buffer.from(buffer).toString('base64');

      aiResult = await processWithGemini(GEMINI_KEY!, text || 'Analisis nota ini dan catat semua itemnya.', nowIso, base64);
    } else {
      aiResult = await processWithGemini(GEMINI_KEY!, text, nowIso);
    }

    // 1. INTENT: QUERY EXPENSE (Filter Dinamis & Bahasa Natural)
    if (aiResult.intent === 'QUERY_EXPENSE') {
      const filter = aiResult.query_filter || {};
      let query = supabase.from('expenses').select('amount, category, description, created_at').eq('user_id', userId);

      if (filter.start_date) {
        query = query.gte('created_at', filter.start_date);
      } else {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        query = query.gte('created_at', today.toISOString());
      }

      if (filter.end_date) {
        query = query.lte('created_at', filter.end_date);
      }

      if (filter.category) {
        query = query.ilike('category', `%${filter.category}%`);
      }

      const { data, error } = await query.order('created_at', { ascending: true });

      if (error || !data || data.length === 0) {
        const catInfo = filter.category ? ` untuk kategori <b>${filter.category}</b>` : '';
        await sendTelegram(BOT_TOKEN, chatId, `📊 Tidak ditemukan catatan pengeluaran${catInfo} pada periode tersebut.`);
        return res.status(200).send('OK');
      }

      const total = data.reduce((acc: number, curr: any) => acc + Number(curr.amount), 0);
      const title = filter.title || 'Laporan Pengeluaran';

      let reply = `📊 <b>${title}</b>\n💰 <b>Total:</b> Rp ${total.toLocaleString('id-ID')}\n\n<b>Rincian:</b>`;
      data.forEach((item: any, idx: number) => {
        reply += `\n${idx + 1}. <b>${item.description}</b> (<i>${item.category}</i>): Rp ${Number(item.amount).toLocaleString('id-ID')}`;
      });

      await sendTelegram(BOT_TOKEN, chatId, reply);
      return res.status(200).send('OK');
    }

    // 2. INTENT: DELETE EXPENSE
    if (aiResult.intent === 'DELETE_EXPENSE') {
      if (aiResult.delete_type === 'ALL') {
        await supabase.from('expenses').delete().eq('user_id', userId);
        await sendTelegram(BOT_TOKEN, chatId, '🗑️ <b>Semua data pengeluaran kamu telah dihapus bersih.</b>');
      } else {
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
          await sendTelegram(BOT_TOKEN, chatId, '⚠️ Tidak ada data untuk dihapus.');
        }
      }
      return res.status(200).send('OK');
    }

    // 3. INTENT: ADD EXPENSE (Catat Transaksi Baru)
    const items = aiResult.items || [];
    if (items.length > 0) {
      const payload = items.map((it: any) => ({
        user_id: userId,
        amount: it.amount,
        category: it.category || 'Lainnya',
        description: it.description || '-',
      }));

      const { error: insErr } = await supabase.from('expenses').insert(payload);
      if (insErr) throw insErr;

      const total = items.reduce((acc: number, it: any) => acc + Number(it.amount), 0);
      let reply = `✅ <b>${items.length} Transaksi Tercatat!</b>\n💰 <b>Total:</b> Rp ${total.toLocaleString('id-ID')}\n\n<b>Item:</b>`;
      items.forEach((it: any, i: number) => {
        reply += `\n${i + 1}. <b>${it.description}</b>: Rp ${Number(it.amount).toLocaleString('id-ID')} (<i>${it.category}</i>)`;
      });

      await sendTelegram(BOT_TOKEN, chatId, reply);
    } else {
      await sendTelegram(BOT_TOKEN, chatId, '⚠️ Pesan tidak dikenali sebagai transaksi, rekap, atau hapus data.');
    }

    return res.status(200).send('OK');
  } catch (err: any) {
    console.error('Webhook Runtime Error:', err);
    await sendTelegram(BOT_TOKEN, chatId, `❌ Error: ${err.message || 'Gagal memproses'}`);
    return res.status(200).send('OK');
  }
}