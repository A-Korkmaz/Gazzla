# Gazzla — proje notu (Claude Code bu dosyayı her oturumda okur)

## Ben
Ahmet, ETH öğrencisi. C++ biliyorum (Informatik 1), biraz Python. Kendimi yeni başlayan sayıyorum.
Türkçe konuşalım, teknik şeyleri C++ benzetmeleriyle anlat, adımları **teker teker** ver.
Windows + VS Code + Node.js v24. Telefonum Android, arkadaşlarımın bazılarında iPhone var.

## Proje
Focus To-Do benzeri, kendime ve birkaç arkadaşıma özel çalışma zamanlayıcısı (piyasaya sürülmeyecek).
TypeScript + Vite PWA, arayüz kütüphanesi yok (düz DOM). Tek dış kütüphane: `@supabase/supabase-js`.
Klasör: `Belgeler\Gazzla\odak`, çalıştırma: `npm run dev` → http://localhost:5173
Canlı site: https://gazzla-08t7.netlify.app/ — Netlify, GitHub `main` dalına her push'ta kendiliğinden yeniden yayınlıyor.

## Dosyalar
| Dosya | Ne yapar |
|---|---|
| `src/main.ts` | Tüm ekranlar ve akış (zamanlayıcı, istatistik, projeler, sol menü, hesap, arkadaşlar) |
| `src/timer.ts` | Geri sayım + duraklatma (bitiş anını tutar, arka planda kaymaz) |
| `src/storage.ts` | localStorage: seanslar, ayarlar, projeler, proje hedefleri, istatistik hesapları, eşitleme yardımcıları |
| `src/sync.ts` | Seansları ve proje listesini (hedefleriyle) Supabase ile eşitleme (önce cihaz, sonra bulut; "bekleyenler" listeleri) |
| `src/supabase.ts` | Supabase bağlantısı + giriş (e-posta/şifre) |
| `src/friends.ts` | Kullanıcı adı, arkadaşlık istekleri, arkadaş süreleri, "şu an çalışıyor" (presence) |
| `src/hype.ts`, `src/effects.ts` | Gaz mesajları; konfeti, toast, ses |
| `supabase/01_sessions.sql`, `02_friends.sql`, `03_projects.sql` | Supabase tabloları ve RLS kuralları (SQL Editor'de çalıştırılır) |

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
- Supabase: bölge Zürih. Site URL'nin canlı adres olduğunu kontrol et (e-posta onay bağlantıları oraya gider).

## Sırada
1. PWA simgesi ve çevrimdışı çalışma (telefona "uygulama gibi" kurulsun)
2. Ayarlar ekranı (isim, sabit süreler)
3. Hedefin gerisinde kalınca hatırlatma bildirimi (uyku saatine kalan süre < kalan hedefin 2 katı)

## Çalışma kuralları (Claude için)
- Her oturumda tek iş: kullanıcı "Sırada" listesinden bir madde seçer.
- Sadece o iş için gereken dosyaları oku; tüm `src` klasörünü tarama. `node_modules` ve `dist` klasörlerine bakma.
- Büyük bir değişiklikten önce kısa bir plan yaz, onay al, sonra kodla.
- İş bitince bu dosyadaki "Sırada" listesini ve gerekirse "Önemli kararlar"ı güncelle.
- `main.ts` çok büyük (~53 KB); ilgili bölümü bulmak için önce arama yap, dosyanın tamamını okuma.
