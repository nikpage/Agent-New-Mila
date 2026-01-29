// features/notifications/gate.ts

export function shouldNotifyImmediately(score: number, settings: any): boolean {
  const { urgency_threshold, quiet_hours } = settings;

  // 1. Score Gate
  if (score < urgency_threshold) return false;

  // 2. Quiet Hours Gate (e.g., 22:00 - 07:00)
  const now = new Date();
  const currentHour = now.getHours();
  const [startQuiet] = quiet_hours.start.split(':').map(Number);
  const [endQuiet] = quiet_hours.end.split(':').map(Number);

  const isQuietTime = currentHour >= startHour || currentHour < endHour;

  // If it's quiet time, only notify if the score is "Critical" (e.g., Wife override)
  if (isQuietTime && score < 1000) {
    return false;
  }

  return true;
}
