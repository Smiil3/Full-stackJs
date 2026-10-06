import { escapeHtml } from './escape.js';
import { CENTS_PER_EURO } from '../../config/money.js';
import { EMAIL_TOKEN_TTL_MINUTES } from '../../config/auth.js';

/** Données de chaque gabarit (sérialisées en JSON dans l'outbox). */
export interface TemplatePayloads {
  verifyEmail: { displayName: string; link: string };
  accountExists: { displayName: string; resetLink: string };
  resetPassword: { displayName: string; link: string };
  passwordChanged: { displayName: string };
  orderConfirmed: { displayName: string; orderId: string; eventTitle: string; eventDate: string; ticketsLink: string };
  transferInstructions: {
    displayName: string; eventTitle: string; amount: string; reference: string; beneficiary: string; iban: string; bic: string; deadline: string;
  };
  orderExpired: { displayName: string; eventTitle: string };
  /** transferRefundPending : paiement par virement ⇒ remboursement À VENIR par le collectif (pas encore effectué). */
  orderRefunded: { displayName: string; eventTitle: string; amount: string; reason: string; transferRefundPending: boolean };
  latePaymentRefunded: { displayName: string; eventTitle: string; amount: string };
  duplicatePaymentRefunded: { displayName: string; eventTitle: string; amount: string };
  unexpectedPaymentRefunded: { displayName: string; eventTitle: string; amount: string };
  waitlistOffer: { displayName: string; eventTitle: string; ticketTypeName: string; quantity: number; deadline: string; link: string };
  eventCancelled: { displayName: string; eventTitle: string; reason: string; amount: string | null; transferRefundPending: boolean };
  eventRescheduled: { displayName: string; eventTitle: string; oldDate: string; newDate: string; reason: string };
  bankDetailsChanged: { displayName: string; orgName: string; changedBy: string; ibanMasked: string };
  memberAdded: { displayName: string; orgName: string; role: string; addedBy: string };
}

export type MailTemplate = keyof TemplatePayloads;

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

function layout(title: string, paragraphs: string[], action?: { label: string; url: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 12px">${p}</p>`).join('');
  const button = action
    ? `<p style="margin:20px 0"><a href="${escapeHtml(action.url)}" style="background:#1d3557;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(action.label)}</a></p>`
    : '';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>`
    + `<body style="font-family:Arial,sans-serif;color:#1b1b1b;max-width:560px;margin:auto;padding:16px">`
    + `<h1 style="font-size:20px">${escapeHtml(title)}</h1>${body}${button}`
    + `<p style="color:#666;font-size:12px">Les Nuits de la Garonne — billetterie</p></body></html>`;
}

const e = escapeHtml;

/** Remboursement carte (effectué) ou virement (À VENIR, effectué à la main par le collectif). */
function refundSentence(d: Record<string, unknown>, html: boolean): string {
  const raw = d['amount'];
  const amount = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
  const shown = html ? `<strong>${e(amount)}</strong>` : amount;
  return d['transferRefundPending'] === true
    ? `Le collectif va vous rembourser ${shown} par virement bancaire (remboursement à venir).`
    : `Vous êtes remboursé(e) de ${shown}.`;
}

export function renderTemplate<T extends MailTemplate>(template: T, data: TemplatePayloads[T]): RenderedMail {
  // Chaque branche ne lit que les champs de son gabarit ; toute valeur est échappée.
  const d = data as unknown as Record<string, string | number | boolean | null>;
  const s = (k: string): string => String(d[k] ?? '');
  switch (template) {
    case 'verifyEmail':
      return {
        subject: 'Confirmez votre adresse email',
        html: layout('Bienvenue !', [`Bonjour ${e(s('displayName'))},`, `Confirmez votre adresse pour pouvoir réserver. Ce lien expire dans ${EMAIL_TOKEN_TTL_MINUTES} minutes.`], { label: 'Confirmer mon adresse', url: s('link') }),
        text: `Bonjour ${s('displayName')},\nConfirmez votre adresse (lien valable ${EMAIL_TOKEN_TTL_MINUTES} minutes) : ${s('link')}`,
      };
    case 'accountExists':
      return {
        subject: 'Tentative d’inscription avec votre adresse',
        html: layout('Vous avez déjà un compte', [`Bonjour ${e(s('displayName'))},`, 'Quelqu’un (peut-être vous) a tenté de créer un compte avec cette adresse. Si vous avez oublié votre mot de passe, vous pouvez le réinitialiser. Sinon, ignorez ce message.'], { label: 'Réinitialiser mon mot de passe', url: s('resetLink') }),
        text: `Bonjour ${s('displayName')},\nUn compte existe déjà avec cette adresse. Mot de passe oublié : ${s('resetLink')}`,
      };
    case 'resetPassword':
      return {
        subject: 'Réinitialisation de votre mot de passe',
        html: layout('Réinitialiser le mot de passe', [`Bonjour ${e(s('displayName'))},`, `Ce lien est valable ${EMAIL_TOKEN_TTL_MINUTES} minutes et ne peut servir qu’une fois. Si vous n’êtes pas à l’origine de cette demande, ignorez ce message.`], { label: 'Choisir un nouveau mot de passe', url: s('link') }),
        text: `Bonjour ${s('displayName')},\nRéinitialisez votre mot de passe (lien valable ${EMAIL_TOKEN_TTL_MINUTES} minutes) : ${s('link')}`,
      };
    case 'passwordChanged':
      return {
        subject: 'Votre mot de passe a été modifié',
        html: layout('Mot de passe modifié', [`Bonjour ${e(s('displayName'))},`, 'Votre mot de passe vient d’être modifié et toutes vos sessions ont été fermées. Si vous n’êtes pas à l’origine de ce changement, réinitialisez-le immédiatement.']),
        text: `Bonjour ${s('displayName')},\nVotre mot de passe vient d'être modifié. Toutes vos sessions ont été fermées.`,
      };
    case 'orderConfirmed':
      return {
        subject: `Vos billets — ${s('eventTitle')}`,
        html: layout('Paiement confirmé', [`Bonjour ${e(s('displayName'))},`, `Votre commande pour <strong>${e(s('eventTitle'))}</strong> (${e(s('eventDate'))}) est confirmée. Vos billets sont en pièce jointe et dans votre espace.`], { label: 'Voir mes billets', url: s('ticketsLink') }),
        text: `Bonjour ${s('displayName')},\nVotre commande pour ${s('eventTitle')} (${s('eventDate')}) est confirmée. Vos billets : ${s('ticketsLink')}`,
      };
    case 'transferInstructions':
      return {
        subject: `Instructions de virement — ${s('eventTitle')}`,
        html: layout('Réservation en attente de virement', [
          `Bonjour ${e(s('displayName'))},`,
          `Vos places pour <strong>${e(s('eventTitle'))}</strong> sont réservées jusqu’au ${e(s('deadline'))}.`,
          `Montant : <strong>${e(s('amount'))}</strong><br>Bénéficiaire : ${e(s('beneficiary'))}<br>IBAN : ${e(s('iban'))}<br>BIC : ${e(s('bic'))}<br>Référence à indiquer impérativement : <strong>${e(s('reference'))}</strong>`,
        ]),
        text: `Bonjour ${s('displayName')},\nMontant : ${s('amount')}\nBénéficiaire : ${s('beneficiary')}\nIBAN : ${s('iban')}\nBIC : ${s('bic')}\nRéférence : ${s('reference')}\nÀ régler avant le ${s('deadline')}.`,
      };
    case 'orderExpired':
      return {
        subject: `Réservation expirée — ${s('eventTitle')}`,
        html: layout('Réservation expirée', [`Bonjour ${e(s('displayName'))},`, `Votre réservation pour <strong>${e(s('eventTitle'))}</strong> n’a pas été réglée à temps : les places ont été libérées.`]),
        text: `Bonjour ${s('displayName')},\nVotre réservation pour ${s('eventTitle')} a expiré, les places ont été libérées.`,
      };
    case 'orderRefunded':
      return {
        subject: `Remboursement — ${s('eventTitle')}`,
        html: layout('Commande annulée', [`Bonjour ${e(s('displayName'))},`, `Votre commande pour <strong>${e(s('eventTitle'))}</strong> est annulée (${e(s('reason'))}).`, refundSentence(d, true)]),
        text: `Bonjour ${s('displayName')},\nVotre commande pour ${s('eventTitle')} est annulée (${s('reason')}). ${refundSentence(d, false)}`,
      };
    case 'latePaymentRefunded':
      return {
        subject: `Paiement reçu trop tard — ${s('eventTitle')}`,
        html: layout('Paiement remboursé', [`Bonjour ${e(s('displayName'))},`, `Votre paiement pour <strong>${e(s('eventTitle'))}</strong> est arrivé après l’expiration de votre réservation et il n’y avait plus de places disponibles. Vous êtes intégralement remboursé(e) : <strong>${e(s('amount'))}</strong>.`]),
        text: `Bonjour ${s('displayName')},\nPaiement reçu après expiration, plus de places : remboursement intégral de ${s('amount')}.`,
      };
    case 'duplicatePaymentRefunded':
      return {
        subject: `Paiement en double remboursé — ${s('eventTitle')}`,
        html: layout('Paiement remboursé', [`Bonjour ${e(s('displayName'))},`, `Nous avons reçu un paiement supplémentaire pour votre commande <strong>${e(s('eventTitle'))}</strong>, qui était déjà réglée ou ne pouvait plus l’être. Il vous est intégralement remboursé : <strong>${e(s('amount'))}</strong>. Votre commande n’est pas modifiée.`]),
        text: `Bonjour ${s('displayName')},\nPaiement supplémentaire reçu pour ${s('eventTitle')} : remboursement intégral de ${s('amount')}. Votre commande n'est pas modifiée.`,
      };
    case 'unexpectedPaymentRefunded':
      return {
        subject: `Paiement remboursé — ${s('eventTitle')}`,
        html: layout('Paiement remboursé', [`Bonjour ${e(s('displayName'))},`, `Nous avons reçu un paiement pour votre commande <strong>${e(s('eventTitle'))}</strong> que nous n’avons pas pu rattacher à votre réservation (montant, moyen de paiement ou session inattendus). Il vous est intégralement remboursé : <strong>${e(s('amount'))}</strong>. Votre commande n’est pas modifiée.`]),
        text: `Bonjour ${s('displayName')},\nUn paiement inattendu pour ${s('eventTitle')} vous est intégralement remboursé : ${s('amount')}. Votre commande n'est pas modifiée.`,
      };
    case 'waitlistOffer':
      return {
        subject: `Des places se sont libérées — ${s('eventTitle')}`,
        html: layout('C’est votre tour !', [`Bonjour ${e(s('displayName'))},`, `${e(s('quantity'))} place(s) « ${e(s('ticketTypeName'))} » pour <strong>${e(s('eventTitle'))}</strong> vous sont réservées jusqu’au ${e(s('deadline'))}.`], { label: 'Accepter l’offre', url: s('link') }),
        text: `Bonjour ${s('displayName')},\n${s('quantity')} place(s) ${s('ticketTypeName')} pour ${s('eventTitle')} vous sont réservées jusqu'au ${s('deadline')} : ${s('link')}`,
      };
    case 'eventCancelled':
      return {
        subject: `Événement annulé — ${s('eventTitle')}`,
        html: layout('Événement annulé', [`Bonjour ${e(s('displayName'))},`, `<strong>${e(s('eventTitle'))}</strong> est annulé : ${e(s('reason'))}.`, d['amount'] ? refundSentence(d, true) : 'Votre réservation non payée a été annulée.']),
        text: `Bonjour ${s('displayName')},\n${s('eventTitle')} est annulé : ${s('reason')}. ${d['amount'] ? refundSentence(d, false) : ''}`,
      };
    case 'eventRescheduled':
      return {
        subject: `Événement reporté — ${s('eventTitle')}`,
        html: layout('Événement reporté', [
          `Bonjour ${e(s('displayName'))},`,
          `<strong>${e(s('eventTitle'))}</strong> est reporté du ${e(s('oldDate'))} au <strong>${e(s('newDate'))}</strong>.`,
          `Motif : ${e(s('reason'))}`,
          'Vos billets restent valables. Si la nouvelle date ne vous convient pas, vous pouvez annuler depuis votre espace et être remboursé(e) intégralement, frais compris.',
        ]),
        text: `Bonjour ${s('displayName')},\n${s('eventTitle')} est reporté du ${s('oldDate')} au ${s('newDate')}.\nMotif : ${s('reason')}\nVos billets restent valables ; annulation possible avec remboursement intégral.`,
      };
    case 'bankDetailsChanged':
      return {
        subject: `Coordonnées bancaires modifiées — ${s('orgName')}`,
        html: layout('Coordonnées bancaires modifiées', [
          `Bonjour ${e(s('displayName'))},`,
          `Les coordonnées bancaires du collectif <strong>${e(s('orgName'))}</strong> viennent d’être modifiées par ${e(s('changedBy'))} (nouvel IBAN : ${e(s('ibanMasked'))}).`,
          'Si ce changement n’est pas légitime, contactez immédiatement les autres propriétaires du collectif.',
        ]),
        text: `Bonjour ${s('displayName')},\nLes coordonnées bancaires de ${s('orgName')} ont été modifiées par ${s('changedBy')} (IBAN ${s('ibanMasked')}).`,
      };
    case 'memberAdded':
      return {
        subject: `Vous avez rejoint ${s('orgName')}`,
        html: layout('Nouveau collectif', [
          `Bonjour ${e(s('displayName'))},`,
          `${e(s('addedBy'))} vous a ajouté(e) au collectif <strong>${e(s('orgName'))}</strong> avec le rôle ${e(s('role'))}.`,
          'Si vous ne connaissez pas ce collectif, signalez-le à l’équipe de la billetterie.',
        ]),
        text: `Bonjour ${s('displayName')},\n${s('addedBy')} vous a ajouté(e) au collectif ${s('orgName')} (rôle : ${s('role')}).`,
      };
    default:
      throw new Error('Gabarit de mail inconnu');
  }
}

export function formatEuros(cents: number): string {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / CENTS_PER_EURO);
}
