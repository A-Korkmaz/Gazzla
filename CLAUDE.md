# Gazzla — proje notu (Claude Code bu dosyayı her oturumda okur)

## Ben
Ahmet, ETH öğrencisi. C++ biliyorum (Informatik 1), biraz Python. Kendimi yeni başlayan sayıyorum.
Türkçe konuşalım, teknik şeyleri C++ benzetmeleriyle anlat, adımları **teker teker** ver.
Windows + VS Code + Node.js v24. Tarayıcım **Edge** (Chrome'da Claude uzantısı yok). Telefonum Android,
arkadaşlarımın bazılarında iPhone var.

## Proje
Focus To-Do benzeri, kendime ve birkaç arkadaşıma özel çalışma zamanlayıcısı (piyasaya sürülmeyecek).
TypeScript + Vite PWA, arayüz kütüphanesi yok (düz DOM). Tek dış kütüphane: `@supabase/supabase-js`.
Klasör: `Belgeler\Gazzla\odak`, çalıştırma: `npm run dev` → http://localhost:5173
Canlı site: https://gazzla-08t7.netlify.app/ — Netlify, GitHub `main` dalına her push'ta kendiliğinden yeniden yayınlıyor.

## Dosyalar
| Dosya | Ne yapar |
|---|---|
| `src/main.ts` (~55 KB) | Tüm ekranlar ve akış (zamanlayıcı, istatistik, projeler, sol menü, hesap, arkadaşlar) |
| `src/timer.ts` | Geri sayım + duraklatma (bitiş anını tutar, arka planda kaymaz) |
| `src/storage.ts` | localStorage: seanslar, ayarlar, projeler, proje hedefleri, istatistik hesapları, eşitleme yardımcıları |
| `src/sync.ts` | Seansları ve proje listesini (hedefleriyle) Supabase ile eşitleme (önce cihaz, sonra bulut; "bekleyenler" listeleri) |
| `src/supabase.ts` | Supabase bağlantısı + giriş (e-posta/şifre) |
| `src/friends.ts` | Kullanıcı adı, arkadaşlık istekleri, arkadaş süreleri, "şu an çalışıyor" (presence) |
| `src/hype.ts`, `src/effects.ts` | Gaz mesajları; konfeti, toast, ses |
| `supabase/01_sessions.sql`, `02_friends.sql`, `03_projects.sql` | Supabase tabloları ve RLS kuralları. **Üçü de SQL Editor'de çalıştırıldı**; tekrar çalıştırma (`create policy` hata verir). Yeni tablo → `04_...sql` |
| `public/manifest.webmanifest` | PWA bilgisi (ad, renkler, simgeler). Service worker **yok** |
| `public/logo.svg`, `public/icons/` | Logo (favicon + üst çubuk/menü) ve PNG simgeler: 192, 512, maskable-512 (logo küçültülmüş), apple-touch-icon 180 (köşesiz). PNG'ler logo.svg'den Edge headless ile üretildi; logo değişirse yeniden üret |

## Önemli kararlar
- Arayüzde "ders" yerine **"proje"** deniyor (kodda değişken adları hâlâ `subject`).
- Proje hedefi **isteğe bağlı** (haftalık).
- Giriş **zorunlu değil**; uygulama girişsiz de çalışır.
- Kayıtların asıl yeri cihaz (localStorage); giriş yapılmışsa arka planda Supabase'e eşitlenir.
- **Proje adları arkadaşlardan gizli.** Arkadaşlar seans satırlarını okuyamaz; sadece `friend_totals()`
  fonksiyonundan toplam süreleri ve `presence` tablosundan "çalışıyor/arada/duraklattı" durumunu görür.
- Projeler `projects` tablosunda, anahtar `(user_id, name)`. Silinen proje satırdan silinmez, `deleted = true`
  olur (öbür cihaz da öğrensin diye); ad değiştirme = eski ad silindi + yeni ad. Bekleyen proje adları
  `gazzla.pendingProjects`'te. İki cihaz internetsizken aynı projeyi değiştirirse son yükleyen kazanır.
- Supabase: bölge Zürih. Proje adresi `oeloqmdhffbehavolwik.supabase.co`.
- Netlify ayarları (derleme komutu, `dist`) Netlify panelinde; projede `netlify.toml` yok.

## Durum (son güncelleme 2026-11-27)
- Bitti: seans eşitlemesi, arkadaşlar, proje listesi + hedeflerin eşitlenmesi (canlı sitede iki cihazla test edildi),
  internette yayın (Netlify).
- Açık küçük kontrol: Supabase → Authentication → URL Configuration → **Site URL** hâlâ `http://localhost:5173`
  olabilir; `https://gazzla-08t7.netlify.app` olmalı (yoksa arkadaşların kayıt onay e-postası localhost'a gider).
- Bulutta `__test__` ve `__test2__` adlı iki `deleted = true` test satırı var; zararsız.

## Sırada
1. Çevrimdışı çalışma (service worker) — simgeler hazır (2026-11-27), telefona kurulunca logolu görünür
2. Ayarlar ekranı (isim, sabit süreler)
3. Hedefin gerisinde kalınca hatırlatma bildirimi (uyku saatine kalan süre < kalan hedefin 2 katı)

## Çalışma kuralları (Claude için)
- Her oturumda tek iş: kullanıcı "Sırada" listesinden bir madde seçer.
- Sadece o iş için gereken dosyaları oku; tüm `src` klasörünü tarama. `node_modules` ve `dist` klasörlerine bakma.
- Büyük bir değişiklikten önce kısa bir plan yaz, onay al, sonra kodla.
- İş bitince bu dosyadaki "Sırada" listesini ve gerekirse "Önemli kararlar"ı güncelle.
- `main.ts` çok büyük (~55 KB); ilgili bölümü bulmak için önce arama yap, dosyanın tamamını okuma.
- İşi **yarım bırakma**: plan onaylandıktan sonra kodla, `npm run build` ile doğrula, test et, commit et ve
  `main`'e gönder. Ahmet her ara adımda tekrar onay istenmesinden hoşlanmıyor.
- Dikkat: `main`'e push = canlı sitede yayın (arkadaşlar da kullanıyor). Bu yüzden önce ayrı dalda çalış,
  derleme ve test geçince `main`'e birleştirip gönder.
- Test: Claude'un kendi tarayıcı panelinde canlı siteyi aç; Ahmet panelde giriş yapar (şifreyi Claude girmez).
  Buluta gerçekten yazıldığını sayfadan Supabase REST'e sorarak kontrol et. "Başka cihaz"ı taklit etmek için
  paneldeki localStorage'ı o cihazın durumuna getirip sayfayı yenile.
- Bilgisayarda `gh` (GitHub CLI) yok; `git` ve `python` var.
- Derlenmiş siteyi denemek için `.claude/launch.json` içinde `preview` (vite preview, port 4173) var.
