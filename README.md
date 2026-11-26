# Gazzla

Kişisel çalışma zamanlayıcısı ve hedef takipçisi (PWA, TypeScript + Vite).

## Bilgisayarında çalıştırmak

1. **Node.js** kur (LTS sürümü): https://nodejs.org
2. Bu klasörde bir terminal aç ve bağımlılıkları yükle:
   ```
   npm install
   ```
3. Geliştirme sunucusunu başlat:
   ```
   npm run dev
   ```
4. Terminalde çıkan adresi (genelde `http://localhost:5173`) tarayıcıda aç.

Kodu değiştirip kaydettiğinde sayfa kendiliğinden yenilenir.

## Klasör yapısı

| Dosya | Ne yapar |
|---|---|
| `src/types.ts` | Veri tipleri (çalışma kaydı, ayarlar) |
| `src/timer.ts` | Geri sayım zamanlayıcısı |
| `src/storage.ts` | Kayıtları saklama (şimdilik tarayıcıda, sonra Supabase) |
| `src/main.ts` | Ekran ve düğmeler, uygulamanın akışı |
| `src/hype.ts` | Gaz mesajları (istediğin gibi ekle/çıkar) |
| `src/effects.ts` | Konfeti, ekran mesajı (toast), bitiş sesi |
| `src/style.css` | Görünüm |
| `public/manifest.webmanifest` | Telefona "uygulama gibi" kurulması için PWA ayarları |

## Yol haritası

**İlk sürüm**
- [x] Süre girip çalışma başlatma, süre bitince uyarı
- [x] Bitince "ara mı, bitir mi?" akışı, ara süresi girme
- [x] İsteğe bağlı ders/proje etiketi
- [x] Bugünkü toplam çalışma süresi
- [x] Dairesel zamanlayıcı, günlük hedef çubuğu, seri sayacı
- [x] Konfeti, bitiş sesi, gaz mesajları, koyu tema
- [ ] Ayarlar ekranı (sabit süreler)
- [x] Günlük hedef
- [x] Haftalık hedef (pazartesi başlar, varsayılan 15 saat)
- [x] Önceki derslerin seçilebilir olması, son seçilenin hatırlanması
- [x] Dersler ekranı: ekle, adını değiştir, sil
- [x] Sol menü ve proje ekranı: projeye kilitli zamanlayıcı, projenin istatistikleri, isteğe bağlı haftalık proje hedefi
- [x] "+ Proje" penceresi: ana ekrandan hızlıca yeni proje ekleme
- [x] Duraklat / devam et (duraklatma sayısı istatistikte)
- [x] İstatistik ekranı (son 7 gün, ders bazında bugün/hafta/toplam)
- [ ] PWA: simge ve çevrimdışı çalışma

**İkinci sürüm**
- [ ] Hedefin gerisinde kalınca hatırlatma bildirimi
- [x] Supabase ile giriş (e-posta + şifre)
- [x] Kayıtların hesaba eşitlenmesi (internetsiz de çalışır)
- [x] Arkadaşlar: kullanıcı adı, istek/kabul, haftalık sıralama, "şu an çalışıyor" (proje adları gizli)
- [ ] Proje listesi ve hedeflerin de hesaba eşitlenmesi
- [ ] Uygulamayı internette yayınlamak (arkadaşlar telefondan kullansın)
