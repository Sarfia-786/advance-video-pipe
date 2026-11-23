import { pool } from '@/lib/platform/accounts/auth.mjs';
import { PlatformAccessError, requireCapability } from '@/lib/platform/accounts/authorization.mjs';
import { getPlatformActor, privateApiError, privateApiResponse } from '@/lib/platform/accounts/server.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const pageSize = 50;

export async function GET(request) {
  try {
    const actor = await getPlatformActor(request.headers);
    requireCapability(actor, 'usageHistory', 'detailed');

    const before = new URL(request.url).searchParams.get('before');
    if (before !== null && (!/^[1-9]\d{0,18}$/.test(before) || BigInt(before) > 9223372036854775807n)) {
      throw new PlatformAccessError('INVALID_CURSOR', 400);
    }
    const { rows } = await pool.query(
      'SELECT id, kind, amount, created_at AS "createdAt" FROM platform.credit_entries ' +
      'WHERE user_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3',
      [actor.userId, before, pageSize + 1],
    );
    const entries = rows.slice(0, pageSize);
    return privateApiResponse({ entries, nextBefore: rows.length > pageSize ? entries.at(-1).id : null });
  } catch (error) {
    return privateApiError(error);
  }
}
