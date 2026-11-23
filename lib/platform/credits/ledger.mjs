const MAX_CREDITS = 1_000_000_000_000;

function trimmedId(value, field, max = 256) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > max) {
    throw new TypeError(field + ' must be a nonempty trimmed ID (max ' + max + ' chars)');
  }
  return value;
}

function optionalId(value, field, max = 256) {
  if (value == null) return null;
  return trimmedId(value, field, max);
}

function credits(value, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_CREDITS) {
    throw new RangeError('credits must be a safe integer between ' + (allowZero ? 0 : 1) + ' and ' + MAX_CREDITS);
  }
  return value;
}

function asBigIntText(value) {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

export function normalizeCreditOperation(input, { settlement = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('credit operation required');
  return Object.freeze({
    userId: trimmedId(input.userId, 'userId'),
    operationKey: trimmedId(input.operationKey, 'operationKey', 200),
    credits: credits(input.credits, { allowZero: settlement }),
    tool: settlement ? null : optionalId(input.tool, 'tool', 100),
    model: settlement ? null : optionalId(input.model, 'model', 200),
    jobId: settlement ? null : optionalId(input.jobId, 'jobId', 256),
    reason: settlement ? optionalId(input.reason, 'reason', 500) : null,
  });
}

function requireQuery(query) {
  if (typeof query !== 'function') throw new TypeError('Trusted PostgreSQL query function required');
  return query;
}

function meter(row) {
  return Object.freeze({
    settledBalance: asBigIntText(row.settled_balance ?? row.settledBalance),
    reserved: asBigIntText(row.reserved),
    available: asBigIntText(row.available),
    spent: asBigIntText(row.spent ?? 0),
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
    maxCredits: asBigIntText(row.max_amount ?? row.maxAmount),
    status: row.status,
    available: asBigIntText(row.available),
    reserved: asBigIntText(row.reserved),
  });
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
    captured: asBigIntText(row.captured),
    released: asBigIntText(row.released),
    available: asBigIntText(row.available),
    reserved: asBigIntText(row.reserved),
    spent: asBigIntText(row.spent),
  });
}

export async function getCreditMeter(query, userId) {
  query = requireQuery(query);
  userId = trimmedId(userId, 'userId');
  const { rows } = await query('SELECT * FROM platform.credit_meter($1::text)', [userId]);
  if (rows?.length !== 1) throw new Error('credit meter returned no row');
  return meter(rows[0]);
}
