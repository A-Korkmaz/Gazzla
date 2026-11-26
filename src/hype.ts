// Gaz mesajları. {ad} yerine kullanıcının adı yazılır.
// İstediğin kadar ekleyip çıkarabilirsin.

const START = [
  "Gazla {ad}! Bu seans senin.",
  "Telefon kenara, odak sende.",
  "Hadi {ad}, bir seans daha, hedef yaklaşıyor.",
  "Küçük adımlar, büyük sınavlar. Başla!",
];

const WORKING = [
  "Bırakma, akıştasın.",
  "Her dakika hanene yazılıyor.",
  "Şu an çalışan sensin, helal.",
  "Odak modu: açık.",
];

const DONE = [
  "Helal {ad}! Seans tamam.",
  "Bir tuğla daha koydun. Su iç, nefes al.",
  "İşte bu! Hedefe bir adım daha.",
  "Seans bitti, gaz bitmedi.",
];

const GOAL_MET = [
  "Günlük hedef tamam {ad}! Bugün kazandın.",
  "Hedef cepte! Gerisi bonus.",
];

const WEEK_GOAL_MET = [
  "HAFTALIK HEDEF TAMAM {ad}! Bu hafta senindi.",
  "Haftayı cebe koydun! Gerisi tamamen bonus.",
];

const SUBJECT_GOAL_MET = [
  "{proje} için haftalık hedef tamam {ad}! 🎯",
  "{proje} bu hafta cepte! Helal.",
];

const BREAK_OVER = [
  "Ara bitti {ad}, masaya dön!",
  "Mola yeter, gazlamaya devam.",
];

function pick(list: string[], name: string): string {
  const msg = list[Math.floor(Math.random() * list.length)];
  return msg.replaceAll("{ad}", name);
}

export const hype = {
  start: (name: string) => pick(START, name),
  working: (name: string) => pick(WORKING, name),
  done: (name: string) => pick(DONE, name),
  goalMet: (name: string) => pick(GOAL_MET, name),
  weekGoalMet: (name: string) => pick(WEEK_GOAL_MET, name),
  subjectGoalMet: (name: string, subject: string) =>
    pick(SUBJECT_GOAL_MET, name).replaceAll("{proje}", subject),
  breakOver: (name: string) => pick(BREAK_OVER, name),
};
