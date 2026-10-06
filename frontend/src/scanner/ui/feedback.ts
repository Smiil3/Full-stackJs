/** Retour sonore et vibration (si disponibles) : bip aigu = entrée, grave = refus. */
let ctx: AudioContext | null = null;

export function signal(ok: boolean | 'warn'): void {
  try {
    if ('vibrate' in navigator) navigator.vibrate(ok === true ? 80 : [200, 80, 200]);
  } catch {
    // Vibration indisponible : sans effet.
  }
  try {
    const AC = window.AudioContext as typeof AudioContext | undefined;
    if (!AC) return;
    ctx ??= new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = ok === true ? 880 : ok === 'warn' ? 520 : 220;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (ok === true ? 0.12 : 0.35));
  } catch {
    // Audio indisponible (politique d'autolecture…) : sans effet.
  }
}
