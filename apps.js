const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = Number(process.env.PORT || 3000);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY
  || process.env.SUPABASE_ANON_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Isi SUPABASE_URL dan SUPABASE_PUBLISHABLE_KEY (atau SUPABASE_ANON_KEY) di backend/.env.');
}

const supabase = createClient(supabaseUrl, supabaseKey);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

function sendSupabaseError(res, error) {
  console.error(error);
  res.status(400).json({ error: error.message || 'Permintaan ke database gagal.' });
}

function isPositiveAmount(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

async function resolveOptionId(table, value) {
  const numericId = Number(value);
  if (Number.isInteger(numericId) && numericId > 0) return numericId;

  const name = String(value || '').trim();
  if (!name) throw new Error('Pilihan unit dan kategori wajib diisi.');

  const { data: existing, error: lookupError } = await supabase
    .from(table)
    .select('id')
    .eq('nama', name)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return existing.id;

  const { data: created, error: insertError } = await supabase
    .from(table)
    .insert({ nama: name })
    .select('id')
    .single();
  if (insertError) throw insertError;
  return created.id;
}

app.get('/api/health', async (_req, res) => {
  const { error } = await supabase
    .from('unit_organisasi')
    .select('id', { head: true, count: 'exact' });

  if (error) {
    return res.status(503).json({ status: 'error', error: error.message });
  }

  res.json({ status: 'ok', database: 'connected' });
});

app.get('/api/options', async (_req, res) => {
  const [unitsResult, categoriesResult] = await Promise.all([
    supabase.from('unit_organisasi').select('id, nama').order('nama'),
    supabase.from('kategori_anggaran').select('id, nama, warna').order('nama'),
  ]);

  if (unitsResult.error) return sendSupabaseError(res, unitsResult.error);
  if (categoriesResult.error) return sendSupabaseError(res, categoriesResult.error);

  res.json({ units: unitsResult.data, categories: categoriesResult.data });
});

app.get('/api/dashboard', async (_req, res) => {
  const { data, error } = await supabase
    .from('anggaran')
    .select(`
      id, tahun, jumlah_anggaran, catatan, created_at,
      unit_organisasi ( id, nama ),
      kategori_anggaran ( id, nama, warna ),
      realisasi ( id, tanggal, uraian, jumlah, nomor_bukti )
    `)
    .order('tahun', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) return sendSupabaseError(res, error);

  res.json({ budgets: data });
});

app.post('/api/budgets', async (req, res) => {
  const { unit_id, kategori_id, tahun, jumlah_anggaran, catatan } = req.body;
  const year = Number(tahun);

  if (!unit_id || !kategori_id || !Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ error: 'Unit, kategori, dan tahun anggaran wajib diisi dengan benar.' });
  }
  if (!isPositiveAmount(jumlah_anggaran)) {
    return res.status(400).json({ error: 'Jumlah anggaran harus lebih besar dari nol.' });
  }

  let unitId;
  let categoryId;
  try {
    [unitId, categoryId] = await Promise.all([
      resolveOptionId('unit_organisasi', unit_id),
      resolveOptionId('kategori_anggaran', kategori_id),
    ]);
  } catch (error) {
    return sendSupabaseError(res, error);
  }

  const { data, error } = await supabase
    .from('anggaran')
    .insert({
      unit_id: unitId,
      kategori_id: categoryId,
      tahun: year,
      jumlah_anggaran: Number(jumlah_anggaran),
      catatan: catatan?.trim() || null,
    })
    .select('id')
    .single();

  if (error) return sendSupabaseError(res, error);
  res.status(201).json({ id: data.id });
});

app.post('/api/realizations', async (req, res) => {
  const { anggaran_id, tanggal, uraian, jumlah, nomor_bukti } = req.body;

  if (!anggaran_id || !tanggal || !uraian?.trim()) {
    return res.status(400).json({ error: 'Alokasi, tanggal, dan uraian realisasi wajib diisi.' });
  }
  if (!isPositiveAmount(jumlah)) {
    return res.status(400).json({ error: 'Jumlah realisasi harus lebih besar dari nol.' });
  }

  const { data: budget, error: budgetError } = await supabase
    .from('anggaran')
    .select('jumlah_anggaran, realisasi(jumlah)')
    .eq('id', Number(anggaran_id))
    .single();

  if (budgetError || !budget) {
    return res.status(404).json({ error: 'Alokasi anggaran tidak ditemukan.' });
  }

  const spent = budget.realisasi.reduce((total, item) => total + Number(item.jumlah), 0);
  if (spent + Number(jumlah) > Number(budget.jumlah_anggaran)) {
    return res.status(400).json({ error: 'Realisasi melebihi sisa anggaran pada alokasi ini.' });
  }

  const { data, error } = await supabase
    .from('realisasi')
    .insert({
      anggaran_id: Number(anggaran_id),
      tanggal,
      uraian: uraian.trim(),
      jumlah: Number(jumlah),
      nomor_bukti: nomor_bukti?.trim() || null,
    })
    .select('id')
    .single();

  if (error) return sendSupabaseError(res, error);
  res.status(201).json({ id: data.id });
});

app.delete('/api/realizations/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'ID realisasi tidak valid.' });
  }

  const { error } = await supabase.from('realisasi').delete().eq('id', id);
  if (error) return sendSupabaseError(res, error);
  res.status(204).end();
});

app.listen(port, () => {
  console.log(`Sistem Anggaran berjalan di http://localhost:${port}`);
});