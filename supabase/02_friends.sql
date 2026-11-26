-- Gazzla: kullanıcı adları, arkadaşlık ve "şu an çalışıyor" durumu.
-- 01_sessions.sql'den SONRA, SQL Editor'de bir kere çalıştırılır.

-- ---------- 1) Profiller (kullanıcı adı) ----------
create table if not exists public.profiles (
  id         uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  username   text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Giriş yapmış herkes kullanıcı adlarını görebilir (arkadaşını adıyla bulabilmek için).
create policy "girisli herkes profilleri gorur" on public.profiles
  for select to authenticated using (true);
create policy "kendi profilini olusturur" on public.profiles
  for insert with check (id = auth.uid());
create policy "kendi profilini gunceller" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- ---------- 2) Arkadaşlıklar ----------
-- requester isteği gönderen, addressee isteği alan. Kabul edilince status = 'accepted'.
create table if not exists public.friendships (
  requester  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  addressee  uuid not null references auth.users (id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  primary key (requester, addressee),
  check (requester <> addressee)
);

-- Aynı iki kişi arasında tek kayıt olsun (A→B varken B→A açılmasın).
create unique index if not exists friendships_pair
  on public.friendships (least(requester, addressee), greatest(requester, addressee));

alter table public.friendships enable row level security;

create policy "kendi arkadasliklarini gorur" on public.friendships
  for select using (auth.uid() in (requester, addressee));
create policy "istek gonderir" on public.friendships
  for insert with check (requester = auth.uid() and status = 'pending');
create policy "gelen istegi kabul eder" on public.friendships
  for update using (addressee = auth.uid()) with check (addressee = auth.uid() and status = 'accepted');
create policy "arkadasligi siler" on public.friendships
  for delete using (auth.uid() in (requester, addressee));

-- Güncellemede sadece status değişebilsin (kimse requester'ı başkasıyla değiştiremesin).
revoke update on public.friendships from anon, authenticated;
grant update (status) on public.friendships to authenticated;

-- İki kişi arkadaş mı? Diğer tabloların kurallarında kullanılıyor.
-- "security definer": fonksiyon friendships'i kendi yetkisiyle okur (kural içinde kural döngüsü olmasın).
create or replace function public.is_friend(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friendships
    where status = 'accepted'
      and ((requester = a and addressee = b) or (requester = b and addressee = a))
  );
$$;

-- ---------- 3) Arkadaşların süreleri (proje adları GİZLİ) ----------
-- Arkadaşlar birbirinin seans kayıtlarını doğrudan okuyamaz (yoksa proje adlarını da görürlerdi).
-- Bunun yerine bu fonksiyon sadece toplam süreleri verir: kim, bugün kaç ms, bu hafta kaç ms.
-- day_start / week_start uygulamadan gelir (kullanıcının yerel saatine göre gün ve hafta başı).
create or replace function public.friend_totals(day_start timestamptz, week_start timestamptz)
returns table (user_id uuid, today_ms bigint, week_ms bigint)
language sql
stable
security definer
set search_path = public
as $$
  select s.user_id,
         coalesce(sum(s.duration_ms) filter (where s.started_at >= day_start), 0)::bigint,
         coalesce(sum(s.duration_ms), 0)::bigint
  from public.sessions s
  where s.kind = 'work'
    and s.started_at >= week_start
    and public.is_friend(auth.uid(), s.user_id)
  group by s.user_id;
$$;

-- ---------- 4) "Şu an çalışıyor" durumu ----------
-- Her kullanıcının en fazla bir satırı var; seans başlayınca yazılır, bitince silinir.
create table if not exists public.presence (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('work', 'break')),  -- proje adı bilerek YOK (gizli)
  started_at timestamptz not null,
  ends_at    timestamptz not null,
  paused     boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.presence enable row level security;

create policy "kendi ve arkadaslarinin durumunu gorur" on public.presence
  for select using (user_id = auth.uid() or public.is_friend(auth.uid(), user_id));
create policy "kendi durumunu yazar" on public.presence
  for insert with check (user_id = auth.uid());
create policy "kendi durumunu gunceller" on public.presence
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "kendi durumunu siler" on public.presence
  for delete using (user_id = auth.uid());
