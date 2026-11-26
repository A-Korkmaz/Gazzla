# Gazzla — devir notu

Yeni bir sohbette kaldığın yerden devam etmek için bu dosyayı ve `src` klasörünü ver.

## Ben
Ahmet, ETH öğrencisi. C++ biliyorum (Informatik 1), biraz Python. Kendimi yeni başlayan sayıyorum.
Türkçe konuşalım, teknik şeyleri C++ benzetmeleriyle anlat, adımları **teker teker** ver.
Windows + VS Code + Node.js v24. Telefonum Android, arkadaşlarımın bazılarında iPhone var.

## Proje
Focus To-Do benzeri, kendime ve birkaç arkadaşıma özel çalışma zamanlayıcısı (piyasaya sürülmeyecek).
TypeScript + Vite PWA, arayüz kütüphanesi yok (düz DOM). Tek dış kütüphane: `@supabase/supabase-js`.
Klasör: `Belgeler\Gazzla\odak`, çalıştırma: `npm run dev` → http://localhost:5173

## Dosyalar
| Dosya | Ne yapar |
|---|---|
| `src/main.ts` | Tüm ekranlar ve akış (zamanlayıcı, istatistik, projeler, sol menü, hesap, arkadaşlar) |
| `src/timer.ts` | Geri sayım + duraklatma (bitiş anını tutar, arka planda kaymaz) |
| `src/storage.ts` | localStorage: seanslar, ayarlar, projeler, proje hedefleri, istatistik hesapları, eşitleme yardımcıları |
| `src/sync.ts` | Seansları Supabase ile eşitleme (önce cihaz, sonra bulut; "bekleyenler" listesi) |
| `src/supabase.ts` | Supabase bağlantısı + giriş (e-posta/şifre) |
| `src/friends.ts` | Kullanıcı adı, arkadaşlık istekleri, arkadaş süreleri, "şu an çalışıyor" (presence) |
| `src/hype.ts`, `src/effects.ts` | Gaz mesajları; konfeti, toast, ses |
| `supabase/01_sessions.sql`, `02_friends.sql` | Supabase tabloları ve RLS kuralları (SQL Editor'de çalıştırıldı) |

## Önemli kararlar
- Arayüzde "ders" yerine **"proje"** deniyor (kodda değişken adları hâlâ `subject`).
- Proje hedefi **isteğe bağlı** (haftalık).
- Giriş **zorunlu değil**; uygulama girişsiz de çalışır.
- Kayıtların asıl yeri cihaz (localStorage); giriş yapılmışsa arka planda Supabase'e eşitlenir.
- **Proje adları arkadaşlardan gizli.** Arkadaşlar seans satırlarını okuyamaz; sadece `friend_totals()`
  fonksiyonundan toplam süreleri ve `presence` tablosundan "çalışıyor/arada/duraklattı" durumunu görür.
- Supabase: bölge Zürih, Site URL `http://localhost:5173` (yayınlayınca gerçek adres eklenmeli).

## Sırada
1. Proje listesi ve hedeflerin de hesaba eşitlenmesi (şu an cihaza özel)
2. Uygulamayı internette yayınlamak (Netlify/Vercel), Supabase'de Site URL'yi güncellemek
3. PWA simgesi ve çevrimdışı çalışma (telefona "uygulama gibi" kurulsun)
4. Ayarlar ekranı (isim, sabit süreler)
5. Hedefin gerisinde kalınca hatırlatma bildirimi (uyku saatine kalan süre < kalan hedefin 2 katı)
