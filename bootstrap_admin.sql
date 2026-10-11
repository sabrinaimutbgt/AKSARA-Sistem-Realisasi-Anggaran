-- Jalankan setelah workflow_migration.sql dan setelah akun admin pertama terdaftar.
-- Ganti alamat email di bawah dengan email akun yang didaftarkan.
do $$
declare
  admin_user_id uuid;
  secretariat_unit_id bigint;
  admin_email text := lower(trim('GANTI_DENGAN_EMAIL_ADMIN'));
begin
  if admin_email = '' or admin_email = 'ganti_dengan_email_admin' then
    raise exception 'Ganti GANTI_DENGAN_EMAIL_ADMIN dengan email akun Supabase Auth Anda.';
  end if;

  select id into admin_user_id
  from auth.users
  where lower(email) = admin_email
  limit 1;

  if admin_user_id is null then
    raise exception 'Akun % belum ditemukan. Daftar akun di aplikasi terlebih dahulu dan pastikan email sudah dikonfirmasi.', admin_email;
  end if;

  select id into secretariat_unit_id
  from public.unit_organisasi
  where nama = 'Sekretariat'
  limit 1;

  if secretariat_unit_id is null then
    raise exception 'Divisi Sekretariat belum ada di public.unit_organisasi.';
  end if;

  insert into public.profiles (id, nama, unit_id, peran)
  select
    auth_user.id,
    coalesce(auth_user.raw_user_meta_data ->> 'nama', split_part(auth_user.email, '@', 1)),
    secretariat_unit_id,
    'admin'
  from auth.users as auth_user
  where auth_user.id = admin_user_id
  on conflict (id) do update
  set unit_id = excluded.unit_id,
      peran = 'admin';
end;
$$;
