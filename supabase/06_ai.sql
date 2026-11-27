-- Gazzla AI: kullanıcı başına günlük hak sayacı.
-- Supabase panelinde SQL Editor'e yapıştırıp "Run" ile BİR KERE çalıştırılır.
--
-- Her kullanıcının her gün için bir satırı var: kaç Koç sorusu, kaç ders asistanı sorusu, kaç sayfa okuma (ocr).
-- Kullanıcı yalnız kendi satırını OKUYABİLİR (kalan hakkını görmek için); YAZAMAZ.
-- Sayacı sadece sunucudaki gazzla-ai fonksiyonu, aşağıdaki ai_use() ile artırır.

create table if not exists public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day     date not null default current_date,
  coach   int  not null default 0,
  study   int  not null default 0,
  ocr     int  not null default 0,
  primary key (user_id, day)
);

alter table public.ai_usage enable row level security;

create policy "ai_usage: kendi satırını okur"
  on public.ai_usage for select
  using (auth.uid() = user_id);

-- Bir hak kullan: sınır dolmadıysa sayacı 1 artırıp yeni değeri, dolduysa -1 döndürür.
-- Tek bir UPDATE içinde "sınırın altındaysa artır" dediğimiz için iki istek aynı anda gelse de sınır aşılmaz.
create or replace function public.ai_use(p_user uuid, p_kind text, p_limit int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  insert into ai_usage (user_id, day) values (p_user, current_date) on conflict do nothing;
  if p_kind = 'coach' then
    update ai_usage set coach = coach + 1 where user_id = p_user and day = current_date and coach < p_limit returning coach into n;
  elsif p_kind = 'study' then
    update ai_usage set study = study + 1 where user_id = p_user and day = current_date and study < p_limit returning study into n;
  elsif p_kind = 'ocr' then
    update ai_usage set ocr = ocr + 1 where user_id = p_user and day = current_date and ocr < p_limit returning ocr into n;
  else
    raise exception 'bilinmeyen tür: %', p_kind;
  end if;
  return coalesce(n, -1);
end;
$$;

-- Bu fonksiyonu tarayıcıdan kimse çağıramasın (yalnız sunucu, service role ile).
revoke all on function public.ai_use(uuid, text, int) from public, anon, authenticated;
