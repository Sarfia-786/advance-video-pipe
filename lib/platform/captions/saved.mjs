import { PlatformAccessError } from '../accounts/authorization.mjs';
import { buildWordTrack } from './words.mjs';
import { normalizeCaptionStyle } from './styles.mjs';

const columns = 'id, kind, name, revision, updated_at AS "updatedAt"';
const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);

export async function readCaptionDocuments(db, owner, id) {
  if (id === null) {
    const { rows } = await db.query('SELECT ' + columns + ' FROM platform.caption_documents WHERE owner_user_id=$1 ORDER BY updated_at DESC,id', [owner]);
    return { documents: rows };
  }
  if (!validId(id)) throw new PlatformAccessError('CAPTION_NOT_FOUND', 404);
  const { rows } = await db.query('SELECT ' + columns + ', style, words FROM platform.caption_documents WHERE owner_user_id=$1 AND id=$2', [owner, id]);
  if (!rows.length) throw new PlatformAccessError('CAPTION_NOT_FOUND', 404);
  return rows[0];
}

export async function saveCaptionDocument(db, owner, data) {
  if (!data || !validId(data.id) || !['project', 'preset'].includes(data.kind) || !Number.isSafeInteger(data.revision) ||
      data.revision < 0 || data.revision >= 2147483647 || typeof data.name !== 'string' ||
      !data.name.trim() || data.name.trim().length > 80 || !data.style) throw new PlatformAccessError('CAPTION_DOCUMENT', 422);
  const style = normalizeCaptionStyle(data.style);
  const words = data.kind === 'project' ? buildWordTrack(data.words, style.groupWords).words : null;
  const params = [owner, data.id, data.kind, data.name.trim(), JSON.stringify(style), words && JSON.stringify(words)];
  const sql = data.revision === 0
    ? 'INSERT INTO platform.caption_documents(owner_user_id,id,kind,name,style,words) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING'
    : 'UPDATE platform.caption_documents SET name=$4,style=$5,words=$6,revision=revision+1,updated_at=now() ' +
      'WHERE owner_user_id=$1 AND id=$2 AND kind=$3 AND revision=$7';
  if (data.revision) params.push(data.revision);
  const { rows } = await db.query(sql + ' RETURNING ' + columns, params);
  if (rows.length) return rows[0];
  // An identical retry after a lost response returns its committed version.
  const replay = await db.query('SELECT ' + columns + ' FROM platform.caption_documents WHERE owner_user_id=$1 AND id=$2 ' +
    'AND kind=$3 AND name=$4 AND style=$5 AND words IS NOT DISTINCT FROM $6::jsonb AND revision=$7',
    [...params.slice(0, 6), data.revision + 1]);
  if (replay.rows.length) return replay.rows[0];
  throw new PlatformAccessError('CAPTION_SAVE_CONFLICT', 409);
}
