# Gazzla — proje notu (Claude Code bu dosyayı her oturumda okur)

## Ben
Ahmet, ETH öğrencisi. C++ biliyorum (Informatik 1), biraz Python. Kendimi yeni başlayan sayıyorum.
Türkçe konuşalım, teknik şeyleri C++ benzetmeleriyle anlat, adımları **teker teker** ver.
Windows + VS Code + Node.js v24. Tarayıcım **Edge** (Chrome'da Claude uzantısı yok). Telefonum Android,
arkadaşlarımın bazılarında iPhone var.

## Proje
Focus To-Do benzeri, kendime ve birkaç arkadaşıma özel çalışma zamanlayıcısı (piyasaya sürülmeyecek).
TypeScript + Vite PWA, arayüz kütüphanesi yok (düz DOM). Dış kütüphaneler: `@supabase/supabase-js`, `pdfjs-dist`
(yalnız ders asistanının Groq yolunda, dinamik import ile yüklenir).
Klasör: `Belgeler\Gazzla\odak`, çalıştırma: `npm run dev` → http://localhost:5173
Canlı site: https://gazzla-08t7.netlify.app/ — Netlify, GitHub `main` dalına her push'ta kendiliğinden yeniden yayınlıyor.

## Dosyalar
| Dosya | Ne yapar |
|---|---|
| `src/main.ts` (~70 KB) | Tüm ekranlar ve akış (zamanlayıcı + süre seçici, istatistik, hedefler, projeler, sol menü, hesap, arkadaşlar) |
| `src/timer.ts` | Geri sayım + duraklatma (bitiş anını tutar, arka planda kaymaz) |
| `src/storage.ts` | localStorage: seanslar, ayarlar, projeler, proje hedefleri, istatistik hesapları, eşitleme yardımcıları |
| `src/sync.ts` | Seansları ve proje listesini (hedefleriyle) Supabase ile eşitleme (önce cihaz, sonra bulut; "bekleyenler" listeleri) |
| `src/supabase.ts` | Supabase bağlantısı + giriş (e-posta/şifre) |
| `src/friends.ts` | Kullanıcı adı, arkadaşlık istekleri, arkadaş süreleri, "şu an çalışıyor" (presence) |
| `src/landing.ts`, `src/landing.css` | Giriş (tanıtım) sayfası: uygulamanın üstünde tam ekran katman. İlk ziyarette açılır, "Uygulamayı aç" deyince `gazzla.seenLanding` kaydedilir; kurulu PWA'da açılmaz; üst çubuktaki logo ya da `?tanitim` ile yeniden açılır |
| `src/hype.ts`, `src/effects.ts` | Gaz mesajları; konfeti, toast, ses |
| `src/util.ts` | Ortak küçük yardımcılar: `escapeHtml`, `formatMinutes`, `projectColor`, `clockText` |
| `src/timetable.ts` | Program (timetable) verisi: `Block` tipi, localStorage (`gazzla.timetable`, bekleyenler `gazzla.pendingTimetable`), hafta/gün hesapları, çakışan blokların şeritlere dizilmesi |
| `src/gcal.ts` | Google Calendar: bağlanma (Google Identity Services, kod akışı), "Gazzla" takvimiyle iki yönlü eşitleme, öbür takvimleri okuma (önbellek `gazzla.gcalExternal`, durum `gazzla.gcal`). `GOOGLE_CLIENT_ID` boşsa Google bölümü gizli |
| `supabase/functions/gcal-auth/index.ts` | Supabase Edge Function: Google yenileme anahtarını `google_tokens` tablosunda saklar, tarayıcıya 1 saatlik erişim anahtarı verir (exchange / token / disconnect). Gizliler: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| `src/timetableView.ts` | Program sayfası (haftalık tablo, blok penceresi, "Plan ve gerçek" kartı) + zamanlayıcıdaki "Programda şimdi" kartı. main.ts'ten `TimetableCtx` ile çağrılır |
| `supabase/01_sessions.sql` … `05_google.sql`, `06_ai.sql` | Supabase tabloları ve RLS kuralları. **01–05 SQL Editor'de çalıştırıldı**; tekrar çalıştırma (`create policy` hata verir). `google_tokens`'ta bilerek hiç kural yok (yalnız sunucu fonksiyonu erişir). `06_ai.sql` (`ai_usage` + `ai_use()`) **henüz çalıştırılmadı**. Yeni tablo → `07_...sql` |
| `src/assistant.ts` | "Gazzla AI" sayfası (`view = "assistant"`, menüde herkese açık; canlıda giriş şart). İki mod (Koç / Ders asistanı), araçlar (`program_oner`, `seans_ayarla`), ses, sohbet geçmişi (`gazzla.aiChats`, mod başına son 20, görselsiz), "yeni sohbet" önerisi (`NUDGE_AT`), materyal paneli (klasör grupları, sürükle-bırak, `+ Klasör`), LaTeX → Unicode (`latexToText`) ve tablo sadeleştirme |
| `src/aiApi.ts` | Sunucuyla konuşan tek yer: `aiFetch(route)` (canlı: Supabase `gazzla-ai` + oturum + ülke fişi; dev: `/api/gazzla-ai`), `loadStatus` (yol + kalan haklar) |
| `src/study.ts` | Materyaller: IndexedDB (`gazzla-study`, Blob + `folder` + çıkarılmış `pages`), `files` yolunda servise yükleme |
| `src/extract.ts` | Ders asistanının `excerpts` (Groq) yolu: pdf.js ile sayfa yazısı, taranmış sayfa → resim → `ocr`, sonuç materyale kaydedilir; `pickContext` soruya en uygun parçaları seçer (kelime + IDF, "Aufgabe N" yakalama) |
| `supabase/functions/gazzla-ai/index.ts` | Gazzla AI sunucusu (tek dosya, dış kütüphane yok). Yollar: `status`, `coach`, `transcribe`, `study`, `upload`, `ocr`. Giriş (JWT → `/auth/v1/user`), günlük hak (`ai_use` RPC), ülke fişi doğrulama (HMAC, `GEO_SECRET`). Ülke AEA/CH/GB ya da fişsiz → `excerpts` (Groq), diğerleri → `files` (Gemini). Gizliler: `GROQ_API_KEY`, `GEMINI_API_KEY`, `GEO_SECRET` (+ isteğe bağlı `GEMINI_MODEL`, `AI_LIMIT_COACH/STUDY/OCR` = 60/25/80). `npm run dev`'de aynı dosyayı `vite.config.ts` çağırır (`dev: true`: giriş/hak yok, ülke `DEV_COUNTRY`, varsayılan TR) |
| `netlify/functions/geo.mjs` | Netlify Function `/api/geo`: `context.geo` ülke kodunu `GEO_SECRET` ile imzalayıp fiş verir ("TR.exp.imza", 6 saat). IP hiçbir yere gitmez |
| `vite.config.ts` | Yalnız dev: `/api/gazzla-ai/*` isteklerini Supabase fonksiyonunun `handle()`'ına verir. Anahtarlar `.env.local`'de |
| `public/gizlilik.html` | Gizlilik sayfası (düz HTML, Türkçe + kısa İngilizce). Google izin ekranındaki privacy policy bağlantısı buraya gider; veri kullanımı değişirse güncelle |
| `public/manifest.webmanifest` | PWA bilgisi (ad, renkler, simgeler). Service worker **yok** |
| `public/logo.svg`, `public/icons/` | Logo (favicon + üst çubuk/menü) ve PNG simgeler: 192, 512, maskable-512 (logo küçültülmüş), apple-touch-icon 180 (köşesiz). PNG'ler logo.svg'den Edge headless ile üretildi; logo değişirse yeniden üret |

## Önemli kararlar
- Arayüzde "ders" yerine **"proje"** deniyor (kodda değişken adları hâlâ `subject`).
- Proje hedefi **isteğe bağlı** (haftalık).
- Görünüm giriş sayfasıyla aynı dilde: koyu zemin + süzülen mavi/mor lekeler, cam kartlar, hap düğmeler,
  vurgu rengi mor-mavi (`--accent`), ana düğme turuncu. Üst çubukta emoji yerine çizgi SVG ikonlar (`ICONS`).
- Hedefler ayrı sayfada (`view = "goals"`): günlük, haftalık ve proje hedefleri orada düzenlenir.
  Haftalık ve proje hedefleri saat olarak girilir, dakika olarak saklanır.
- **Telefon ve bilgisayar görünümü** aynı kodla, CSS'teki `@media (min-width: 900px)` ile ayrılıyor
  (`style.css` sonundaki bölüm; `main.ts`'te `isDesktop()` aynı sınırı kullanıyor). Bilgisayarda: sol menü hep açık
  (`.menu.docked`), zamanlayıcı iki sütun (`.tl-main` solda, `.tl-side` sağda: hedefler, bugünün özeti,
  "Arkadaşlar şu an"), istatistik/hedefler/arkadaşlar ızgara (`#app[data-view=...]`). Telefonda `.tl*` sarmalayıcıları
  `display: contents` + `order` ile eski sıraya döner. Yalnız bilgisayarda görünenler `.desk-only`.
  Boşluk tuşu zamanlayıcıda başlat/duraklat/devam.
- Bilgisayarda sol menü daraltılabilir (üstteki düğme): daralınca 72 px'lik ikon şeridi (`.menu.collapsed`,
  `body.menu-collapsed`), seçim `gazzla.menuCollapsed`'ta. Menü satırları `item()` yardımcısıyla çiziliyor;
  ikonlar `ICONS`'taki çizgi SVG'ler, projeler baş harf rozeti (`.mi-letter`). Menüde emoji yok.
- **Marka adı her yerde "Gazzla" (iki z).** Fiil olarak da: "Gazzla 🚀", "Hedefe gazzla", "birbirinizi gazzlayın".
- **Gazzla AI** (2026-11-27). Arayüzde, ağ isteklerinde ve cevaplarda servis/model adı geçmez ("Gazzla AI",
  "Gazzla Ders Asistanı"); yol etiketleri bile nötr (`files` / `excerpts`). **Tamamen ücretsiz kalma şartı** var.
  - İki mod (Claude'daki model seçici gibi, `gazzla.aiMode`): **Koç** = Groq `openai/gpt-oss-120b` (sohbet, program,
    seans, ses; Whisper). **Ders asistanı** = ülkeye göre: AEA/İsviçre/İngiltere (ve fişi olmayan) → Groq (`excerpts`:
    tarayıcıda yazı çıkarma + `qwen/qwen3.8-27b` ile taranmış sayfa okuma + alıntı seçme), diğerleri (ör. Türkiye) →
    Gemini (`files`: PDF'i kendisi okur). Sebep: Gemini şartları AEA/CH/GB kullanıcılarına sunulan uygulamalarda
    yalnız ücretli sürüme izin veriyor; Türkiye listede yok ve Gemini'nin hizmet ülkeleri arasında. Ahmet Zürih'te,
    arkadaşları Türkiye'de. Localhost'ta Ahmet Gemini kullanır (DEV_COUNTRY varsayılan TR).
  - **Ortak anahtar sunucuda + kişi başı günlük hak** (`ai_usage`). Her hesaba otomatik ayrı servis anahtarı
    açmak **yapılmaz**: sınırlar hesap/proje başına (ek kota getirmez) ve Groq'un AUP'si çoklu hesapla sınır aşmayı yasaklıyor.
  - **Drive bağlantısı yapılmadı/ertelendi**: Google'ın Limited Use kuralı Drive API verisinin eğitimde kullanılabilen
    bir servise (Gemini ücretsiz, AEA dışı) gitmesine izin vermiyor; kullanıcı onayı, `drive.file`, ara katman ya da
    kopya bunu değiştirmez (kural uygulamaya bağlı). Çözüm: klasörü indirip sürükle-bırak. Drive'ı yalnız Groq'a
    bağlamak (Groq eğitimde kullanmıyor, ZDR açılabiliyor) 2. aşama olarak duruyor.
  - İki mod aynı araçları kullanır (`TOOLS`, `toolRules()`): `program_oner` (kartla onay) ve `seans_ayarla`
    (`main.ts` → `aiSetupSession`, `presetMin`). Seans yalnız kullanıcının mesajında açık başlatma isteği varsa başlar.
    Programa ekleme: model sadece gün + repeat verir, tarihi kod hesaplar. Listede olmayan ad `fixed` olur.
  - **Gizlilik sözü:** ders asistanına çalışma verisi ve program **gönderilmez** (Google Takvim verisi içerebilir);
    sadece proje adları + tarihler. `public/gizlilik.html` "Gazzla AI" bölümü: ödünler ücretsiz kalmak için,
    ülkeye göre yönlendirme, ülke yalnız Netlify'dan kod olarak.
  - Ders asistanı ilk açılışta içerik uyarısı gösterir (`gazzla.aiNotice`). Modeller LaTeX yazabiliyor →
    `latexToText` Unicode'a çevirir (KaTeX yok).
  - Gemini o gün çok yoğundu (503): sunucu sırayla `GEMINI_MODEL` → `gemini-flash-latest` → en yeni 3 flash →
    `gemini-flash-lite-latest` dener (25 sn cevapsız → sıradaki; akış 45 sn durursa "yarıda kesildi").
  - pdf.js arka plandaki sekmede sayfa çizemiyor (requestAnimationFrame durur): okuma sırasında sekme önde olmalı.
- Giriş **zorunlu değil**; uygulama girişsiz de çalışır.
- Kayıtların asıl yeri cihaz (localStorage); giriş yapılmışsa arka planda Supabase'e eşitlenir.
- **Proje adları arkadaşlardan gizli.** Arkadaşlar seans satırlarını okuyamaz; sadece `friend_totals()`
  fonksiyonundan toplam süreleri ve `presence` tablosundan "çalışıyor/arada/duraklattı" durumunu görür.
- Projeler `projects` tablosunda, anahtar `(user_id, name)`. Silinen proje satırdan silinmez, `deleted = true`
  olur (öbür cihaz da öğrensin diye); ad değiştirme = eski ad silindi + yeni ad. Bekleyen proje adları
  `gazzla.pendingProjects`'te. İki cihaz internetsizken aynı projeyi değiştirirse son yükleyen kazanır.
- Supabase: bölge Zürih. Proje adresi `oeloqmdhffbehavolwik.supabase.co`.
- Netlify ayarları (derleme komutu, `dist`) Netlify panelinde; projede `netlify.toml` yok.
- **Program (timetable)**, `view = "timetable"`, menüde "Program". Bloklar: `study` (projeye bağlı çalışma) ya da
  `fixed` (ders/etkinlik, süreye sayılmaz); ya her hafta (`weekday`, 0 = pazartesi) ya tek tarih (`date`). Saatler
  gece yarısından beri dakika. Bulutta `timetable_blocks` (anahtar `id`), silinen blok `deleted = true`.
  Çalışma bloğu başlayınca bildirim (`checkBlockStart`, 20 sn'de bir); zamanlayıcıda "Programda şimdi" kartı
  bloğun projesiyle `min(kalan, 90)` dk başlatır. İstatistikte ve program sayfasında "Plan ve gerçek" kartı.
- **Google Calendar** (iki yönlü, bir kez izin): Gazzla blokları Google'da ayrı **"Gazzla"** takvimine yazılır
  (haftalık blok = `RRULE:FREQ=WEEKLY`, etkinlikte `extendedProperties.private.gazzlaId`). O takvimde Google'da
  yapılan değişiklik/silme/yeni etkinlik programa döner. Öbür takvimler **sadece okunur** ve programda olduğu gibi
  gösterilir (kesikli kutu, tüm gün olanlar gün başlığında şerit).
  **Ahmet'in kuralı: tanımlanmamış bir etkinlik asla projeye çevrilmez**; Gazzla o durumda plan görme uygulaması gibi
  davranır. Sadece adı mevcut bir projeyle aynıysa (büyük/küçük harf fark etmez) o projenin planı sayılır.
  Google izinleri en dar olanlar: `calendar.app.created`, `calendar.events.readonly`, `calendar.calendarlist.readonly`.
  Uzun ömürlü anahtar sunucuda (gcal-auth), bu yüzden Google için Gazzla girişi şart; aynı hesapla başka cihaz
  kendiliğinden bağlı sayılır (günde bir yoklama). Şimdilik tekrarlayan etkinliğin tek bir gününü Google'da
  değiştirmek yok sayılıyor. Google Cloud uygulaması "Testing" modunda kalırsa anahtarlar 7 günde ölür → "In production".

## Durum (son güncelleme 2026-11-27)
- Bitti: seans eşitlemesi, arkadaşlar, proje listesi + hedeflerin eşitlenmesi (canlı sitede iki cihazla test edildi),
  internette yayın (Netlify), giriş (tanıtım) sayfası, yeni görünüm + hedefler sayfası (2026-11-27),
  bilgisayar (geniş ekran) görünümü (2026-11-27), daraltılabilir menü + SVG menü ikonları + "Gazzla" yazımı (2026-11-27).
- Açık küçük kontrol: Supabase → Authentication → URL Configuration → **Site URL** hâlâ `http://localhost:5173`
  olabilir; `https://gazzla-08t7.netlify.app` olmalı (yoksa arkadaşların kayıt onay e-postası localhost'a gider).
- Google araması: `index.html`'de `meta description` var (2026-11-27). Search Console'a kayıt **bilerek yapılmadı** (site özel).
- Bulutta `__test__` ve `__test2__` adlı iki `deleted = true` test satırı var; zararsız.

## Sırada
0. **Devam eden (dal `timetable`, commitlenmedi):** program + Supabase eşitlemesi bitti ve gerçek hesapla test edildi.
   Google Calendar kodu yazıldı, Google olmadan test edildi. **Google Cloud kurulumu bitti (2026-11-27)**: proje
   `gazzla`, Calendar API açık, 3 izin, Web istemcisi "Gazzla web" (JS kaynakları netlify, localhost:5173, :4173;
   popup akışı, redirect URI yok), ana sayfa + gizlilik bağlantısı (`public/gizlilik.html`) girildi, durum
   **In production** (doğrulanmamış; kullanıcılar "unverified app" uyarısını Advanced ile geçer, en fazla 100 kişi).
   `GOOGLE_CLIENT_ID` `src/gcal.ts`'e yazıldı. Client secret Ahmet'te (JSON indirdi), koda/sohbete yazılmaz.
   **Supabase de bitti (2026-11-27)**: `05_google.sql` çalıştırıldı, `gcal-auth` panelin editöründen yayınlandı
   (CLI yok), gizliler `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` kayıtlı. Fonksiyonda "Verify JWT with legacy
   secret" açık bırakıldı; giriş yapılmış isteklerde sorun çıkarmadı (test edildi).
   **Uçtan uca test geçti (2026-11-27, localhost:4173, Ahmet'in hesabı)**: bağlanma, 7 bloğun "Gazzla" takvimine
   yazılması (haftalık = RRULE), Google'da eklenen etkinliğin programa dönmesi (proje adıyla aynıysa çalışma,
   değilse sabit), Google'da silmenin programa ve buluta (`deleted = true`) dönmesi. Kalan: commit + main.
   Not: Claude'un tarayıcı paneli Google açılır penceresini Claude'un tıklamasıyla açmaz; "bağla"ya Ahmet basar.
   Gizlilik sayfası canlıya bu dalla birlikte çıkar.
   Ahmet "tamam" demeden commit/push yok. Ahmet'in hesabında test projeleri/blokları duruyor (önemsiz dedi).
1. **Gazzla AI canlıya alma (dal `ai`, commitlendi, `main`'e gönderilmedi).** Kod bitti ve yerelde test edildi
   (Koç; ders asistanı `files` yolu Gemini ile; `excerpts` yolu DEV_COUNTRY=CH ile: yazılı + taranmış PDF okuma,
   "Aufgabe 5" alıntısını bulup 2 sn'de çözme; geçmiş; LaTeX dönüşümü). Kalan, Ahmet'in yapacakları:
   (a) Supabase SQL Editor'de `06_ai.sql`; (b) Edge Functions → yeni fonksiyon `gazzla-ai`, `index.ts` içeriği
   yapıştırılır ("Verify JWT" açık kalabilir); (c) Supabase secrets: `GROQ_API_KEY`, `GEMINI_API_KEY`, `GEO_SECRET`
   (değerler `.env.local`'de); (d) Netlify → Environment variables → `GEO_SECRET` (aynı değer);
   (e) Groq konsolu → Data Controls → Zero Data Retention aç. Sonra `main`'e birleştir (timetable işi de çıkar),
   canlıda Ahmet'in hesabıyla test (ülke CH → `excerpts`). Sonra: Drive klasörü → yalnız Groq (2. aşama).
2. Çevrimdışı çalışma (service worker) — simgeler hazır (2026-11-27), telefona kurulunca logolu görünür
3. Ayarlar ekranı (isim, sabit süreler)
4. Hedefin gerisinde kalınca hatırlatma bildirimi (uyku saatine kalan süre < kalan hedefin 2 katı)

## Çalışma kuralları (Claude için)
- Her oturumda tek iş: kullanıcı "Sırada" listesinden bir madde seçer.
- Sadece o iş için gereken dosyaları oku; tüm `src` klasörünü tarama. `node_modules` ve `dist` klasörlerine bakma.
- Büyük bir değişiklikten önce kısa bir plan yaz, onay al, sonra kodla.
- İş bitince bu dosyadaki "Sırada" listesini ve gerekirse "Önemli kararlar"ı güncelle.
- `main.ts` çok büyük (~70 KB); ilgili bölümü bulmak için önce arama yap, dosyanın tamamını okuma.
- İşi **yarım bırakma**: plan onaylandıktan sonra kodla, `npm run build` ile doğrula, test et, commit et ve
  `main`'e gönder. Ahmet her ara adımda tekrar onay istenmesinden hoşlanmıyor.
- Dikkat: `main`'e push = canlı sitede yayın (arkadaşlar da kullanıyor). Bu yüzden önce ayrı dalda çalış,
  derleme ve test geçince `main`'e birleştirip gönder.
- Test: Claude'un kendi tarayıcı panelinde canlı siteyi aç; Ahmet panelde giriş yapar (şifreyi Claude girmez).
  Buluta gerçekten yazıldığını sayfadan Supabase REST'e sorarak kontrol et. "Başka cihaz"ı taklit etmek için
  paneldeki localStorage'ı o cihazın durumuna getirip sayfayı yenile.
- Bilgisayarda `gh` (GitHub CLI) yok; `git` ve `python` var.
- `.claude/launch.json`: `dev` (npm run dev, 5173; Gazzla AI yalnız burada) ve `preview` (vite preview, 4173, derlenmiş site).
