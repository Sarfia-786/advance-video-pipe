// Only call from a trusted server-side account lifecycle callback.
// MuAPI keys and request-supplied user identifiers are not platform identity.
export const ACCOUNT_CREATED = 'account.created';

function id(value, field) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 256) {
    throw new TypeError(field + ' must be a nonempty trimmed ID (max 256 chars)');
  }
  return value;
}

export function parseStarterCredits(value = process.env.PLATFORM_STARTER_CREDITS ?? '25') {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,6})$/.test(value) || Number(value) > 1000000) {
    throw new RangeError('PLATFORM_STARTER_CREDITS must be an integer between 0 and 1000000');
  }
  return Number(value);
}

export function normalizeAccountCreated(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || event.type !== ACCOUNT_CREATED) {
    throw new TypeError('Expected a trusted account.created event');
  }
  return Object.freeze({ eventId: id(event.eventId, 'eventId'), userId: id(event.userId, 'userId') });
}

export async function provisionAccountCreated(query, event, starterCredits = parseStarterCredits()) {
  if (typeof query !== 'function') throw new TypeError('Trusted PostgreSQL query function required');
  const { eventId, userId } = normalizeAccountCreated(event);
  if (!Number.isSafeInteger(starterCredits) || starterCredits < 0 || starterCredits > 1000000) {
    throw new RangeError('Invalid starter credits');
  }
  await query('SELECT platform.provision_account_created($1::text, $2::text, $3::bigint)', [
    userId, eventId, starterCredits,
  ]);
  return Object.freeze({ userId, provisioned: true });
}
