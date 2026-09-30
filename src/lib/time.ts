// Datas e horários da agenda. Tudo no fuso do servidor (defina TZ no .env),
// datas como AAAA-MM-DD e horários como HH:mm.

export const pad = (n: number) => String(n).padStart(2, '0');

export const toIsoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const toMinutes = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

export const fromMinutes = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

export const weekdayOf = (isoDate: string) => new Date(`${isoDate}T12:00:00`).getDay();

export const addDays = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);

// "2026-09-26" -> "26/09"
export const brDate = (isoDate: string) => isoDate.split('-').reverse().slice(0, 2).join('/');

export const dateTime = (isoDate: string, time: string) => new Date(`${isoDate}T${time}:00`);

// 60 -> "1h", 90 -> "1h30", 30 -> "30 min"
export const durationLabel = (minutes: number) => (minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h${minutes % 60 ? pad(minutes % 60) : ''}`);

export const nowMinutes = (now = new Date()) => now.getHours() * 60 + now.getMinutes();
