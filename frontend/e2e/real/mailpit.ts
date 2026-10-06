/** Lecture des emails de développement (Mailpit) pour récupérer un lien de vérification / réinitialisation. */
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

type Summary = { ID: string; To: { Address: string }[]; Subject: string; Created: string };

export async function waitForLink(to: string, path: '/verify-email' | '/reset-password', timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    if (res.ok) {
      const { messages } = (await res.json()) as { messages: Summary[] };
      for (const m of messages) {
        const full = (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as { Text: string; HTML: string };
        const match = new RegExp(`https?://[^\\s"'<>]+${path}\\?token=[A-Za-z0-9_\\-%.~]+`).exec(`${full.Text}\n${full.HTML}`);
        if (match) return new URL(match[0]).pathname + new URL(match[0]).search;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Aucun email ${path} reçu pour ${to}`);
}
