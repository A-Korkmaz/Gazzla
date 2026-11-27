-- Gazzla: haftalık program (ders programı) blokları.
-- Supabase panelinde SQL Editor'e yapıştırıp "Run" ile bir kere çalıştırılır.
--
-- Her blok bir satır, anahtar id (uygulamanın ürettiği uuid).
-- kind = 'study' (çalışma bloğu, subject = proje adı ya da null = genel çalışma)
--      | 'fixed' (sabit blok: ders, etkinlik; title = adı)
-- Ya weekday (0 = pazartesi ... 6 = pazar, her hafta tekrar) ya da date (tek seferlik) dolu.
-- Saatler gece yarısından beri dakika: 09:30 = 570.
-- Silinen blok satırdan silinmez, deleted = true yapılır (öbür cihaz da öğrensin diye).

create table if not exists public.timetable_blocks (
  id          uuid primary key,
  user_id     uuid not null default auth.uid()
              references auth.users (id) on delete cascade,
  kind        text not null check (kind in ('study', 'fixed')),
  subject     text check (subject is null or length(subject) between 1 and 200),
  title       text check (title is null or length(title) between 1 and 200),
  weekday     smallint check (weekday between 0 and 6),
  date        date,
  start_min   smallint not null check (start_min between 0 and 1439),
  end_min     smallint not null check (end_min between 1 and 1440),
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now(),
  check (end_min > start_min),
  check ((weekday is null) <> (date is null))  -- tam olarak biri dolu
);

create index if not exists timetable_blocks_user on public.timetable_blocks (user_id);

-- Satır düzeyinde güvenlik: herkes sadece KENDİ programını görebilir ve değiştirebilir.
-- Arkadaşlar için hiçbir kural yok; programın (ve proje adları) onlardan gizli.
alter table public.timetable_blocks enable row level security;

create policy "kendi programini okur" on public.timetable_blocks
  for select using (auth.uid() = user_id);

create policy "kendi blogunu ekler" on public.timetable_blocks
  for insert with check (auth.uid() = user_id);

create policy "kendi blogunu gunceller" on public.timetable_blocks
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "kendi blogunu siler" on public.timetable_blocks
  for delete using (auth.uid() = user_id);

-- updated_at her güncellemede kendiliğinden yenilensin.
create or replace function public.timetable_blocks_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists timetable_blocks_touch on public.timetable_blocks;
create trigger timetable_blocks_touch before update on public.timetable_blocks
  for each row execute function public.timetable_blocks_touch();
