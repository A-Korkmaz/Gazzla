-- Gazzla: çalışma kayıtları tablosu.
-- Supabase panelinde SQL Editor'e yapıştırıp "Run" ile bir kere çalıştırılır.

create table if not exists public.sessions (
  id          uuid primary key,                      -- uygulamanın verdiği kimlik (crypto.randomUUID)
  user_id     uuid not null default auth.uid()       -- kaydın sahibi (giriş yapan kullanıcı)
              references auth.users (id) on delete cascade,
  kind        text not null check (kind in ('work', 'break')),
  started_at  timestamptz not null,
  duration_ms integer not null check (duration_ms >= 0),
  subject     text,                                  -- proje adı, yoksa null (= genel çalışma)
  pause_count integer,
  created_at  timestamptz not null default now()
);

create index if not exists sessions_user_started on public.sessions (user_id, started_at);

-- Satır düzeyinde güvenlik: herkes sadece KENDİ kayıtlarını görebilir ve değiştirebilir.
-- (Arkadaşların kayıtlarını görme kuralını arkadaşlık adımında ekleyeceğiz.)
alter table public.sessions enable row level security;

create policy "kendi kayitlarini okur" on public.sessions
  for select using (auth.uid() = user_id);

create policy "kendi kaydini ekler" on public.sessions
  for insert with check (auth.uid() = user_id);

create policy "kendi kaydini gunceller" on public.sessions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "kendi kaydini siler" on public.sessions
  for delete using (auth.uid() = user_id);
