const MAX_CREDITS = 1_000_000_000_000;
const LEDGER_KINDS = new Set(['purchase', 'subscription', 'refund', 'adjustment', 'reversal', 'expiry']);

function trimmed(value, field, max = 256) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > max) {
    throw new TypeError(field + ' must be a nonempty trimmed value (max ' + max + ' chars)');
  }
  return value;
}

function optional(value, field, max = 256) {
  if (value == null) return null;
  return trimmed(value, field, max);
}

function positiveCredits(value, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_CREDITS) {
    throw new RangeError('credits must be a safe integer between ' + (allowZero ? 0 : 1) + ' and ' + MAX_CREDITS);
  }
  return value;
}

function signedCredits(value) {
  if (!Number.isSafeInteger(value) || value === 0 || value < -MAX_CREDITS || value > MAX_CREDITS) {
    throw new RangeError('amount must be a nonzero safe integer between -' + MAX_CREDITS + ' and ' + MAX_CREDITS);
  }
  return value;
}

function asText(value) {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

export function normalizeCreditOperation(input, { settlement = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('credit operation required');
  const reason = settlement ? optional(input.reason, 'reason', 500) : null;
  const value = Object.freeze({
    userId: trimmed(input.userId, 'userId'),
    operationKey: trimmed(input.operationKey, 'operationKey', 200),
    credits: positiveCredits(input.credits, { allowZero: settlement }),
    tool: settlement ? null : optional(input.tool, 'tool', 100),
    model: settlement ? null : optional(input.model, 'model', 200),
    jobId: settlement ? null : optional(input.jobId, 'jobId', 256),
    reason,
  });
  if (settlement && value.credits === 0 && !value.reason) {
    throw new TypeError('reason is required when a reservation settles with zero captured credits');
  }
  return value;
}

export function normalizeLedgerEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('ledger entry required');
  const kind = trimmed(input.kind, 'kind', 32);
  if (!LEDGER_KINDS.has(kind)) throw new TypeError('unsupported ledger entry kind');
  const amount = signedCredits(input.amount);
  if (['purchase', 'subscription', 'refund', 'reversal'].includes(kind) && amount <= 0) {
    throw new RangeError(kind + ' must add credits');
  }
  if (kind === 'expiry' && amount >= 0) throw new RangeError('expiry must remove credits');
  const reason = optional(input.reason, 'reason', 500);
  if (['refund', 'adjustment', 'reversal', 'expiry'].includes(kind) && !reason) {
    throw new TypeError('reason is required for ' + kind);
  }
  return Object.freeze({
    userId: trimmed(input.userId, 'userId'),
    operationKey: trimmed(input.operationKey, 'operationKey', 200),
    kind,
    amount,
    reason,
    tool: optional(input.tool, 'tool', 100),
    model: optional(input.model, 'model', 200),
    jobId: optional(input.jobId, 'jobId', 256),
    topUpId: optional(input.topUpId, 'topUpId', 256),
  });
}

export function estimateMaximumCredits(components) {
  if (!Array.isArray(components) || components.length < 1 || components.length > 100) {
    throw new TypeError('cost estimate requires 1-100 server-priced components');
  }
  let total = 0;
  for (const [index, component] of components.entries()) {
    if (!component || typeof component !== 'object' || Array.isArray(component)) {
      throw new TypeError('invalid cost component at index ' + index);
    }
    trimmed(component.name, 'component name', 100);
    const amount = positiveCredits(component.maxCredits, { allowZero: true });
    if (!Number.isSafeInteger(total + amount) || total + amount > MAX_CREDITS) {
      throw new RangeError('estimated maximum credits exceed supported range');
    }
    total += amount;
  }
  if (total === 0) throw new RangeError('managed operation maximum cost must be greater than zero');
  return total;
}

function requireQuery(query) {
  if (typeof query !== 'function') throw new TypeError('Trusted PostgreSQL query function required');
  return query;
}

function meter(row) {
  return Object.freeze({
    settledBalance: asText(row.settled_balance ?? row.settledBalance),
    reserved: asText(row.reserved),
    available: asText(row.available),
    spent: asText(row.spent ?? 0),
  });
}

export async function reserveCredits(query, input) {
  query = requireQuery(query);
  const op = normalizeCreditOperation(input);
  const { rows } = await query(
    'SELECT * FROM platform.reserve_credits($1::text,$2::text,$3::bigint,$4::text,$5::text,$6::text)',
    [op.userId, op.operationKey, op.credits, op.tool, op.model, op.jobId],
  );
  if (rows?.length !== 1) throw new Error('credit reservation returned no row');
  const row = rows[0];
  return Object.freeze({
    operationKey: row.operation_key ?? row.operationKey,
    maxCredits: asText(row.max_amount ?? row.maxAmount),
    status: row.status,
    available: asText(row.available),
    reserved: asText(row.reserved),
  });
}

export async function reserveEstimatedCredits(query, input, components) {
  return reserveCredits(query, { ...input, credits: estimateMaximumCredits(components) });
}

export async function settleCredits(query, input) {
  query = requireQuery(query);
  const op = normalizeCreditOperation(input, { settlement: true });
  const { rows } = await query(
    'SELECT * FROM platform.settle_credit_reservation($1::text,$2::text,$3::bigint,$4::text)',
    [op.userId, op.operationKey, op.credits, op.reason],
  );
  if (rows?.length !== 1) throw new Error('credit settlement returned no row');
  const row = rows[0];
  return Object.freeze({
    operationKey: row.operation_key ?? row.operationKey,
    captured: asText(row.captured),
    released: asText(row.released),
    available: asText(row.available),
    reserved: asText(row.reserved),
    spent: asText(row.spent),
  });
}

export async function recordCreditEntry(query, input) {
  query = requireQuery(query);
  const entry = normalizeLedgerEntry(input);
  const { rows } = await query(
    'SELECT * FROM platform.apply_credit_entry($1::text,$2::text,$3::text,$4::bigint,$5::text,$6::text,$7::text,$8::text,$9::text)',
    [entry.userId, entry.operationKey, entry.kind, entry.amount, entry.reason,
      entry.tool, entry.model, entry.jobId, entry.topUpId],
  );
  if (rows?.length !== 1) throw new Error('credit entry returned no row');
  const row = rows[0];
  return Object.freeze({
    id: asText(row.entry_id ?? row.entryId),
    kind: row.kind,
    amount: asText(row.amount),
    available: asText(row.available),
    reserved: asText(row.reserved),
    spent: asText(row.spent),
  });
}

export async function getCreditMeter(query, userId) {
  query = requireQuery(query);
  userId = trimmed(userId, 'userId');
  const { rows } = await query('SELECT * FROM platform.credit_meter($1::text)', [userId]);
  if (rows?.length !== 1) throw new Error('credit meter returned no row');
  return meter(rows[0]);
}
