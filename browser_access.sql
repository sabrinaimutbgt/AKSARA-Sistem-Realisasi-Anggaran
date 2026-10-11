-- Pengaturan akses API browser. Aman dijalankan ulang; tidak mengubah isi tabel.
grant usage on schema public to anon;

alter table public.unit_organisasi disable row level security;
alter table public.kategori_anggaran disable row level security;
alter table public.anggaran disable row level security;
alter table public.realisasi disable row level security;

grant select, insert, update, delete on table
  public.unit_organisasi,
  public.kategori_anggaran,
  public.anggaran,
  public.realisasi
  to anon;

grant usage, select on all sequences in schema public to anon;
