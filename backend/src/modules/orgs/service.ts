import type { OrganizationSettings, Role } from '../../generated/prisma/client.js';
import { getEnv } from '../../config/env.js';
import { diff, writeAudit } from '../../lib/audit.js';
import { aad, encryptString } from '../../lib/crypto.js';
import { transaction } from '../../lib/db.js';
import { normalizeEmail } from '../../lib/email.js';
import { errors } from '../../lib/errors.js';
import { maskIban, normalizeIban } from '../../lib/iban.js';
import { iso } from '../../lib/schemas.js';
import * as repo from './repo.js';
import type { SettingsPatch } from './schemas.js';

export function toSettingsView(s: OrganizationSettings) {
  return {
    cardHoldMinutes: s.cardHoldMinutes,
    transferHoldHours: s.transferHoldHours,
    transferEnabled: s.transferEnabled,
    cancellationDeadlineHours: s.cancellationDeadlineHours,
    selfCancellationEnabled: s.selfCancellationEnabled,
    refundPercent: s.refundPercent,
    serviceFeeRefundable: s.serviceFeeRefundable,
    maxPerOrder: s.maxPerOrder,
    maxPerUser: s.maxPerUser,
    waitlistOfferMinutes: s.waitlistOfferMinutes,
    waitlistEnabled: s.waitlistEnabled,
    serviceFeeFixedCents: s.serviceFeeFixedCents,
    serviceFeeBasisPoints: s.serviceFeeBasisPoints,
    defaultTimezone: s.defaultTimezone,
    contactEmail: s.contactEmail,
    bank: { beneficiary: s.bankBeneficiary, ibanMasked: s.bankIbanMasked, bic: s.bankBic },
  };
}

/** Champs auditables (IBAN uniquement sous forme masquée). */
function auditable(s: OrganizationSettings): Record<string, unknown> {
  const { bank, ...rest } = toSettingsView(s);
  return { ...rest, bankBeneficiary: bank.beneficiary, bankIbanMasked: bank.ibanMasked, bankBic: bank.bic };
}

export async function getOrg(orgId: string) {
  const org = await repo.findOrg(orgId);
  if (!org) throw errors.notFound();
  return { id: org.id, name: org.name, slug: org.slug, createdAt: iso(org.createdAt) };
}

export async function getSettings(orgId: string) {
  return toSettingsView(await transaction((tx) => repo.getSettings(tx, orgId)));
}

/**
 * Mise à jour des réglages (OWNER) : mapping explicite champ par champ, contrôle croisé
 * maxPerUser ≥ maxPerOrder sur les valeurs fusionnées, IBAN chiffré lié au collectif, audit avant / après.
 */
export async function updateSettings(orgId: string, actorId: string, patch: SettingsPatch) {
  const updated = await transaction(async (tx) => {
    await repo.getSettings(tx, orgId);
    await repo.lockSettings(tx, orgId);
    const before = await repo.getSettings(tx, orgId);
    const maxPerOrder = patch.maxPerOrder ?? before.maxPerOrder;
    const maxPerUser = patch.maxPerUser ?? before.maxPerUser;
    if (maxPerUser < maxPerOrder) {
      throw errors.validation([{ path: 'maxPerUser', message: 'Le plafond par personne doit être supérieur ou égal au plafond par commande.' }]);
    }
    const data: Partial<OrganizationSettings> = {};
    if (patch.cardHoldMinutes !== undefined) data.cardHoldMinutes = patch.cardHoldMinutes;
    if (patch.transferHoldHours !== undefined) data.transferHoldHours = patch.transferHoldHours;
    if (patch.transferEnabled !== undefined) data.transferEnabled = patch.transferEnabled;
    if (patch.cancellationDeadlineHours !== undefined) data.cancellationDeadlineHours = patch.cancellationDeadlineHours;
    if (patch.selfCancellationEnabled !== undefined) data.selfCancellationEnabled = patch.selfCancellationEnabled;
    if (patch.refundPercent !== undefined) data.refundPercent = patch.refundPercent;
    if (patch.serviceFeeRefundable !== undefined) data.serviceFeeRefundable = patch.serviceFeeRefundable;
    if (patch.maxPerOrder !== undefined) data.maxPerOrder = patch.maxPerOrder;
    if (patch.maxPerUser !== undefined) data.maxPerUser = patch.maxPerUser;
    if (patch.waitlistOfferMinutes !== undefined) data.waitlistOfferMinutes = patch.waitlistOfferMinutes;
    if (patch.waitlistEnabled !== undefined) data.waitlistEnabled = patch.waitlistEnabled;
    if (patch.serviceFeeFixedCents !== undefined) data.serviceFeeFixedCents = patch.serviceFeeFixedCents;
    if (patch.serviceFeeBasisPoints !== undefined) data.serviceFeeBasisPoints = patch.serviceFeeBasisPoints;
    if (patch.defaultTimezone !== undefined) data.defaultTimezone = patch.defaultTimezone;
    if (patch.contactEmail !== undefined) data.contactEmail = patch.contactEmail === null ? null : normalizeEmail(patch.contactEmail);
    if (patch.bank) {
      const iban = normalizeIban(patch.bank.iban);
      data.bankBeneficiary = patch.bank.beneficiary.trim();
      data.bankIbanEncrypted = encryptString(iban, getEnv().dataKeyring, aad.orgBankIban(orgId));
      data.bankIbanMasked = maskIban(iban);
      data.bankBic = patch.bank.bic.toUpperCase();
    }
    const after = await tx.organizationSettings.update({ where: { orgId }, data });
    const changes = diff(auditable(before), auditable(after));
    // Un nouvel IBAN dont les 4 derniers chiffres sont identiques reste tracé.
    if (patch.bank && !('bankIbanMasked' in changes)) changes['bankIbanMasked'] = { from: before.bankIbanMasked, to: after.bankIbanMasked };
    await writeAudit(tx, { orgId, actorId, action: 'settings.update', target: `org:${orgId}`, meta: { changes } });
    return after;
  });
  return toSettingsView(updated);
}

function toMemberView(m: { userId: string; role: Role; createdAt: Date; user: { email: string; displayName: string } }) {
  return { userId: m.userId, email: m.user.email, displayName: m.user.displayName, role: m.role, createdAt: iso(m.createdAt) };
}

export async function listMembers(orgId: string) {
  return { items: (await repo.listMembers(orgId)).map(toMemberView) };
}

/** Ajout d'un membre : compte existant ET vérifié (sinon 404, sans distinguer les deux cas). */
export async function addMember(orgId: string, actorId: string, rawEmail: string, role: Role) {
  const email = normalizeEmail(rawEmail);
  const member = await transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email }, select: { id: true, emailVerifiedAt: true } });
    if (!user?.emailVerifiedAt) throw errors.notFound();
    const existing = await tx.membership.findUnique({ where: { userId_orgId: { userId: user.id, orgId } } });
    if (existing) throw errors.conflict('Cette personne est déjà membre du collectif.');
    const created = await tx.membership.create({
      data: { orgId, userId: user.id, role },
      include: { user: { select: { email: true, displayName: true } } },
    });
    await writeAudit(tx, { orgId, actorId, action: 'member.add', target: `user:${user.id}`, meta: { role } });
    return created;
  });
  return toMemberView(member);
}

export async function updateMemberRole(orgId: string, actorId: string, userId: string, role: Role) {
  const member = await transaction(async (tx) => {
    const owners = await repo.lockOwners(tx, orgId);
    const current = await repo.findMember(tx, orgId, userId);
    if (!current) throw errors.notFound();
    if (current.role === 'OWNER' && role !== 'OWNER' && owners <= 1) {
      throw errors.conflict('Impossible de retirer le dernier propriétaire du collectif.');
    }
    if (current.role === role) return current;
    const updated = await tx.membership.update({
      where: { id: current.id },
      data: { role },
      include: { user: { select: { email: true, displayName: true } } },
    });
    await writeAudit(tx, { orgId, actorId, action: 'member.role', target: `user:${userId}`, meta: { from: current.role, to: role } });
    return updated;
  });
  return toMemberView(member);
}

export async function removeMember(orgId: string, actorId: string, userId: string): Promise<void> {
  await transaction(async (tx) => {
    const owners = await repo.lockOwners(tx, orgId);
    const current = await repo.findMember(tx, orgId, userId);
    if (!current) throw errors.notFound();
    if (current.role === 'OWNER' && owners <= 1) throw errors.conflict('Impossible de retirer le dernier propriétaire du collectif.');
    await tx.membership.delete({ where: { id: current.id } });
    await writeAudit(tx, { orgId, actorId, action: 'member.remove', target: `user:${userId}`, meta: { role: current.role } });
  });
}

export async function auditLog(orgId: string, page: number, pageSize: number) {
  const [rows, total] = await repo.auditPage(orgId, page, pageSize);
  return {
    items: rows.map((r) => ({
      id: r.id,
      actorEmail: r.actor?.email ?? null,
      action: r.action,
      target: r.target,
      meta: (r.meta ?? {}) as Record<string, unknown>,
      createdAt: iso(r.createdAt),
    })),
    page,
    pageSize,
    total,
  };
}
