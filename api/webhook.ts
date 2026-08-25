import { createClient } from '@supabase/supabase-js';

// Helper Heartbeat Typing Indicator
function startTypingHeartbeat(token: string, chatId: number) {
  const send = () => {
    fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    }).catch(() => {});
  };

  send();
  const intervalId = setInterval(send, 4000);
  return () => clearInterval(intervalId);
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

// AI Engine Multimodal
async function processWithGemini(
  apiKey: string,
  userText: string,
  currentDate: string,
  historyContext: string,
  imageBase64?: string
) {
  const parts: any[] = [
    {
      text: `Current Timestamp ISO: ${currentDate}.
Konteks 20 Transaksi Terakhir di Database:
${historyContext}

Instruksi Analisis:
1. Jika ada GAMBAR NOTA + PERTANYAAN (misal: "Saya hanya pesan Sirloin Steak, berapa pengeluaran saya?", "Hitung PPN", split bill):
   - Set intent: "IMAGE_QA_AND_SAVE".
   - Tulis jawaban detail pada 'answer' (hitung nominal item + proporsi PPN/Tax 11% secara matematis).
   - Masukkan item yang dipesan oleh user tersebut ke array 'items' agar otomatis disimpan ke database.
2. Jika ada GAMBAR NOTA TANPA PERTANYAAN (hanya ingin catat semua):
   - Set intent: "ADD_EXPENSE".
   - Ekstrak semua baris item dan baris Pajak/Tax ke array 'items'.
3. Jika HANYA TEKS TANYA JAWAB / SPLIT BILL dari riwayat database:
   - Set intent: "ANALYZE_EXPENSE".
   - Tulis penjelasan lengkap dan hasil hitungan pada 'answer'.
4. Jika REKAP TABEL (misal: "rekap hari ini", "pengeluaran bulan ini"):
   - Set intent: "QUERY_EXPENSE".
5. Jika HAPUS DATA:
   - Set intent: "DELETE_EXPENSE" (delete_type: "ALL" | "LAST").`
    },
    { text: userText || 'Ekstrak semua rincian belanjaan dan pajak dari nota ini.' }
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
              intent: { 
                type: 'STRING', 
                description: 'ADD_EXPENSE | IMAGE_QA_AND_SAVE | ANALYZE_EXPENSE | QUERY_EXPENSE | DELETE_EXPENSE' 
              },
              answer: { type: 'STRING', description: 'Jawaban langsung pertanyaan user (termasuk hitungan pajak & split bill)' },
              items: {
                type: 'ARRAY',
                description: 'Daftar item transaksi yang akan disimpan ke database',
                items: {
                  type: 'OBJECT',
                  properties: {
                    description: { type: 'STRING' },
                    amount: { type: 'NUMBER' },
                    category: { type: 'STRING' }
                  },
                  required: ['description', 'amount', 'category']
                }
              },
              query_filter: {
                type: 'OBJECT',
                properties: {
                  start_date: { type: 'STRING' },
                  end_date: { type: 'STRING' },
                  category: { type: 'STRING' },
                  title: { type: 'STRING' }
                }
              },
              delete_type: { type: 'STRING' }
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
  if (req.method !== 'POST') return res.status(200).send('Webhook active');

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

  if (text === '/start' || text === '/bantuan') {
    await sendTelegram(
      BOT_TOKEN,
      chatId,
      `👋 <b>Bot AI Finansial Siap!</b>\n\n` +
      `• <b>Kirim Foto Nota + Caption:</b> <i>"Saya cuma pesan sirloin steak, berapa pengeluaran saya?"</i>\n` +
      `• <b>Tanya PPN / Split Bill:</b> Otomatis menghitung pajak proporsional.\n` +
      `• <b>Rekapitulasi Fleksibel:</b> /hari_ini, /minggu_ini, /bulan_ini.`
    );
    return res.status(200).send('OK');
  }

  const stopTyping = startTypingHeartbeat(BOT_TOKEN, chatId);

  try {
    const supabase = createClient(SUPABASE_URL!, SUPABASE_KEY!);
    const nowIso = new Date().toISOString();

    // Ambil 20 transaksi terbaru untuk konteks pertanyaan teks lanjutan
    const { data: recentExpenses } = await supabase
      .from('expenses')
      .select('description, amount, category, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);

    const historyContext = JSON.stringify(recentExpenses || []);
    let aiResult: any = null;

    if (message.photo) {
      const photo = message.photo[message.photo.length - 1];
      const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${photo.file_id}`);
      const fileData = await fileRes.json();
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;

      const buffer = await fetch(fileUrl).then((r) => r.arrayBuffer());
      const base64Image = Buffer.from(buffer).toString('base64');

      aiResult = await processWithGemini(GEMINI_KEY!, text, nowIso, historyContext, base64Image);
    } else {
      aiResult = await processWithGemini(GEMINI_KEY!, text, nowIso, historyContext);
    }

    // 1. INTENT: IMAGE_QA_AND_SAVE (Kirim Nota + Pertanyaan Spesifik)
    if (aiResult.intent === 'IMAGE_QA_AND_SAVE') {
      const items = aiResult.items || [];
      if (items.length > 0) {
        const payload = items.map((it: any) => ({
          user_id: userId,
          amount: it.amount,
          category: it.category || 'Makanan',
          description: it.description || '-',
        }));
        await supabase.from('expenses').insert(payload);
      }

      const formattedAnswer = (aiResult.answer || 'Berhasil dihitung.')
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
        .replace(/\*(.*?)\*/g, '<i>$1</i>');

      await sendTelegram(
        BOT_TOKEN,
        chatId,
        `${formattedAnswer}\n\n<i>💾 Catatan pesanan Anda sudah otomatis disimpan ke database.</i>`
      );
      stopTyping();
      return res.status(200).send('OK');
    }

    // 2. INTENT: ANALYZE_EXPENSE (Tanya Jawab Teks dari Database)
    if (aiResult.intent === 'ANALYZE_EXPENSE' && aiResult.answer) {
      const formattedAnswer = aiResult.answer
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
        .replace(/\*(.*?)\*/g, '<i>$1</i>');

      await sendTelegram(BOT_TOKEN, chatId, formattedAnswer);
      stopTyping();
      return res.status(200).send('OK');
    }

    // 3. INTENT: QUERY_EXPENSE
    if (aiResult.intent === 'QUERY_EXPENSE') {
      const filter = aiResult.query_filter || {};
      let query = supabase.from('expenses').select('amount, category, description, created_at').eq('user_id', userId);

      if (filter.start_date) query = query.gte('created_at', filter.start_date);
      if (filter.end_date) query = query.lte('created_at', filter.end_date);
      if (filter.category) query = query.ilike('category', `%${filter.category}%`);

      const { data, error } = await query.order('created_at', { ascending: true });

      if (error || !data || data.length === 0) {
        await sendTelegram(BOT_TOKEN, chatId, `📊 Belum ada transaksi tercatat untuk periode tersebut.`);
        stopTyping();
        return res.status(200).send('OK');
      }

      const total = data.reduce((acc: number, curr: any) => acc + Number(curr.amount), 0);
      const title = filter.title || 'Laporan Pengeluaran';

      let reply = `📊 <b>${title}</b>\n💰 <b>Total:</b> Rp ${total.toLocaleString('id-ID')}\n\n<b>Rincian:</b>`;
      data.forEach((item: any, idx: number) => {
        reply += `\n${idx + 1}. <b>${item.description}</b> (<i>${item.category}</i>): Rp ${Number(item.amount).toLocaleString('id-ID')}`;
      });

      await sendTelegram(BOT_TOKEN, chatId, reply);
      stopTyping();
      return res.status(200).send('OK');
    }

    // 4. INTENT: DELETE_EXPENSE
    if (aiResult.intent === 'DELETE_EXPENSE') {
      if (aiResult.delete_type === 'ALL' || text === '/reset_semua') {
        await supabase.from('expenses').delete().eq('user_id', userId);
        await sendTelegram(BOT_TOKEN, chatId, '🗑️ <b>Semua data transaksi berhasil dihapus bersih.</b>');
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
      stopTyping();
      return res.status(200).send('OK');
    }

    // 5. INTENT: ADD_EXPENSE (Catat Semua Baris Nota)
    const items = aiResult.items || [];
    if (items.length > 0) {
      const payload = items.map((it: any) => ({
        user_id: userId,
        amount: it.amount,
        category: it.category || 'Lainnya',
        description: it.description || '-',
      }));

      await supabase.from('expenses').insert(payload);
      const total = items.reduce((acc: number, it: any) => acc + Number(it.amount), 0);

      let reply = `✅ <b>${items.length} Transaksi Tercatat!</b>\n💰 <b>Total:</b> Rp ${total.toLocaleString('id-ID')}\n\n<b>Rincian Item:</b>`;
      items.forEach((it: any, i: number) => {
        reply += `\n${i + 1}. <b>${it.description}</b>: Rp ${Number(it.amount).toLocaleString('id-ID')} (<i>${it.category}</i>)`;
      });

      await sendTelegram(BOT_TOKEN, chatId, reply);
    } else {
      await sendTelegram(BOT_TOKEN, chatId, '⚠️ Pesan tidak dapat diproses.');
    }

    stopTyping();
    return res.status(200).send('OK');
  } catch (err: any) {
    stopTyping();
    console.error('Runtime Error:', err);
    await sendTelegram(BOT_TOKEN, chatId, `❌ Error: ${err.message || 'Gagal memproses'}`);
    return res.status(200).send('OK');
  }
}