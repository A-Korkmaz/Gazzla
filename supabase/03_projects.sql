-- Gazzla: proje listesi ve proje hedefleri tablosu.
-- Supabase panelinde SQL Editor'e yapıştırıp "Run" ile bir kere çalıştırılır.
--
-- Her hesabın her proje adı için tek satır var: anahtar (user_id, name).
-- Silinen proje satırdan silinmez, deleted = true yapılır; böylece öbür cihaz da
-- "bu proje silinmiş" diye öğrenir (yoksa kendi kopyasını geri yüklerdi).
-- Ad değiştirme = eski ad deleted, yeni ad yeni satır.

create table if not exists public.projects (
  user_id         uuid not null default auth.uid()   -- projenin sahibi (giriş yapan kullanıcı)
                  references auth.users (id) on delete cascade,
  name            text not null check (length(name) between 1 and 200),
  weekly_goal_min integer check (weekly_goal_min is null or weekly_goal_min > 0), -- null = hedef yok
  position        integer not null default 0,        -- listedeki sırası
  deleted         boolean not null default false,
  updated_at      timestamptz not null default now(),
  primary key (user_id, name)
);

-- Satır düzeyinde güvenlik: herkes sadece KENDİ projelerini görebilir ve değiştirebilir.
-- Arkadaşlar için hiçbir kural yok, yani proje adları onlardan tamamen gizli.
alter table public.projects enable row level security;

create policy "kendi projelerini okur" on public.projects
  for select using (auth.uid() = user_id);

create policy "kendi projesini ekler" on public.projects
  for insert with check (auth.uid() = user_id);

create policy "kendi projesini gunceller" on public.projects
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "kendi projesini siler" on public.projects
  for delete using (auth.uid() = user_id);

-- updated_at her güncellemede kendiliğinden yenilensin.
create or replace function public.projects_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function public.projects_touch();
