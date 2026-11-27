-- Gazzla: Google Calendar bağlantısı için kullanıcı başına Google "yenileme anahtarı" (refresh token).
-- Supabase panelinde SQL Editor'e yapıştırıp "Run" ile bir kere çalıştırılır.
--
-- Bu anahtar şifre kadar değerli: onunla kullanıcının takvimine erişilebilir. O yüzden
-- RLS açık ama HİÇBİR kural yok, yani uygulama (tarayıcı) bu tabloyu ne okuyabilir ne yazabilir.
-- Sadece sunucudaki "gcal-auth" fonksiyonu (service role ile) erişir ve tarayıcıya
-- yalnızca 1 saatlik "erişim anahtarı" (access token) verir.

create table if not exists public.google_tokens (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  refresh_token text not null,
  scope         text,
  updated_at    timestamptz not null default now()
);

alter table public.google_tokens enable row level security;
-- Bilerek hiç "create policy" yok.
