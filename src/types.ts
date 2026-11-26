// Uygulamadaki veri tipleri. C++'taki struct'lar gibi düşünebilirsin.

/** Tamamlanmış tek bir çalışma ya da ara. */
export interface Session {
  id: string;
  kind: "work" | "break"; // sadece bu iki değerden biri olabilir
  startedAt: number; // başlangıç zamanı (milisaniye, Date.now())
  durationMs: number; // gerçekten geçen süre
  subject?: string; // isteğe bağlı ders/proje; yoksa "genel çalışma"
  pauseCount?: number; // bu seansta kaç kez duraklatıldı
}

/** Kullanıcı ayarları. */
export interface Settings {
  userName: string; // gaz mesajlarında kullanılır
  dailyGoalMin: number; // günlük hedef (dakika)
  weeklyGoalMin: number; // haftalık hedef (dakika), hafta pazartesi başlar
  fixedDurations: boolean; // true ise süreler her seferinde sorulmaz
  defaultWorkMin: number;
  defaultBreakMin: number;
  lastSubject?: string; // en son seçilen ders, bir sonraki açılışta hatırlanır
}

export const DEFAULT_SETTINGS: Settings = {
  userName: "Ahmet",
  dailyGoalMin: 180,
  weeklyGoalMin: 900, // 15 saat
  fixedDurations: false,
  defaultWorkMin: 60,
  defaultBreakMin: 10,
};
