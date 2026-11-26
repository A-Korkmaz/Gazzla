// Geri sayım zamanlayıcısı.
// Önemli fikir: Her saniye "1 azalt" demiyoruz. Bitiş anını (endAt) kaydedip
// her seferinde "şu an ile bitiş arasında ne kadar kaldı" diye hesaplıyoruz.
// Böylece telefon sekmeyi arka plana atsa bile süre kaymaz.
//
// Duraklatınca: duraklama anını (pausedAt) not alıyoruz. Devam edince
// duraklamada geçen süre kadar bitiş anını ileri itiyoruz.

export class CountdownTimer {
  private endAt = 0;
  private startedAt = 0;
  private pausedAt: number | undefined; // duraklatılmışsa ne zaman duraklatıldı
  private pausedTotalMs = 0; // toplam duraklama süresi (çalışılmış sayılmaz)
  private intervalId: number | undefined;
  pauseCount = 0;

  constructor(
    private onTick: (remainingMs: number) => void,
    private onFinish: () => void,
  ) {}

  start(minutes: number): void {
    this.stop();
    this.startedAt = Date.now();
    this.endAt = this.startedAt + minutes * 60_000;
    this.pausedAt = undefined;
    this.pausedTotalMs = 0;
    this.pauseCount = 0;
    this.startTicking();
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.pausedAt = Date.now();
    this.pauseCount++;
    this.stopTicking();
  }

  resume(): void {
    if (this.pausedAt === undefined) return;
    const pauseLength = Date.now() - this.pausedAt;
    this.endAt += pauseLength; // bitişi duraklama kadar ötele
    this.pausedTotalMs += pauseLength;
    this.pausedAt = undefined;
    this.startTicking();
  }

  /** Durdurur ve gerçekten çalışılan süreyi döndürür (duraklamalar hariç). */
  stop(): number {
    this.stopTicking();
    if (!this.startedAt) return 0;
    const now = this.pausedAt ?? Date.now();
    const worked = Math.min(now, this.endAt) - this.startedAt - this.pausedTotalMs;
    this.pausedAt = undefined;
    return Math.max(0, worked);
  }

  /** Sayaç aktif mi (çalışıyor ya da duraklatılmış). */
  get running(): boolean {
    return this.intervalId !== undefined || this.pausedAt !== undefined;
  }

  get paused(): boolean {
    return this.pausedAt !== undefined;
  }

  get startTime(): number {
    return this.startedAt;
  }

  get remainingMs(): number {
    return Math.max(0, this.endAt - (this.pausedAt ?? Date.now()));
  }

  private startTicking(): void {
    this.intervalId = window.setInterval(() => this.tick(), 250);
    this.tick();
  }

  private stopTicking(): void {
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  private tick(): void {
    const remaining = this.endAt - Date.now();
    if (remaining <= 0) {
      this.stopTicking();
      this.onTick(0);
      this.onFinish();
    } else {
      this.onTick(remaining);
    }
  }
}
