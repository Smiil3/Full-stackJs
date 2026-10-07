/** Retour sonore et vibration (si disponibles) : bip aigu = entrée, grave = refus ; vibrations 1 / 2 / 3. */
let ctx: AudioContext | null = null;

export function signal(ok: boolean | 'warn'): void {
  try {
    // Canal non visuel : 1 vibration = entrée, 2 = décision humaine, 3 = refus.
    if ('vibrate' in navigator) navigator.vibrate(ok === true ? 120 : ok === 'warn' ? [150, 90, 150] : [150, 90, 150, 90, 150]);
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
