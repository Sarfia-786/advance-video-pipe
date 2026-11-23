'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import styles from './AccountPortal.module.css';

function entryDetails(entry, copy) {
  const items = [
    [copy.operation, entry.operationKey],
    [copy.tool, entry.tool],
    [copy.model, entry.model],
    [copy.job, entry.jobId],
    [copy.topUp, entry.topUpId],
    [copy.reason, entry.reason],
  ].filter(([, value]) => value);
  return items.map(([label, value]) => label + ': ' + value).join(' · ');
}

export default function UsageDashboard({ copy, rootPath, locale }) {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState('');
  const numbers = new Intl.NumberFormat(locale);
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  useEffect(() => {
    let active = true;
    fetch('/api/platform/v1/usage', { cache: 'no-store', credentials: 'same-origin' })
      .then(async response => {
        if (response.status === 401) throw new Error('AUTH_REQUIRED');
        if (!response.ok) throw new Error('LOAD_FAILED');
        return response.json();
      })
      .then(value => { if (active) setData(value); })
      .catch(err => { if (active) setError(err.message === 'AUTH_REQUIRED' ? copy.authRequired : copy.error); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [copy.authRequired, copy.error]);

  async function loadHistory() {
    setHistoryLoading(true);
    setError('');
    try {
      const query = history?.nextBefore ? '?' + new URLSearchParams({ before: history.nextBefore }) : '';
      const response = await fetch('/api/platform/v1/usage/history' + query, {
        cache: 'no-store', credentials: 'same-origin',
      });
      if (response.status === 401 || response.status === 403) {
        setHistory(null);
        setError(copy.accessChanged);
        return;
      }
      if (!response.ok) throw new Error('history');
      const page = await response.json();
      setHistory({ entries: [...(history?.entries || []), ...page.entries], nextBefore: page.nextBefore });
    } catch {
      setError(copy.historyError);
    } finally {
      setHistoryLoading(false);
    }
  }

  return <main className={styles.page}>
    <div className={styles.usageShell}>
      <Link className={styles.back} href={rootPath + '/account'}>← {copy.account}</Link>
      <section className={styles.card}>
        <h1>{copy.title}</h1>
        <p>{copy.intro}</p>
        {loading ? <p>{copy.loading}</p> : !data ? <>
          <p role="alert">{error}</p>
          <Link href={rootPath + '/login'}>{copy.signIn}</Link>
        </> : <>
          <section className={styles.entitlements} aria-label={copy.title}>
            <dl>
              <dt>{copy.available}</dt><dd>{numbers.format(BigInt(data.credits.available))}</dd>
              <dt>{copy.reserved}</dt><dd>{numbers.format(BigInt(data.credits.reserved))}</dd>
              <dt>{copy.spent}</dt><dd>{numbers.format(BigInt(data.credits.spent))}</dd>
              <dt>{copy.settled}</dt><dd>{numbers.format(BigInt(data.credits.settledBalance))}</dd>
            </dl>
          </section>
          {data.history === 'detailed' ? <section className={styles.entitlements} aria-label={copy.history}>
            {history && (history.entries.length ? <table>
              <caption>{copy.history}</caption>
              <thead><tr>
                <th scope="col">{copy.date}</th><th scope="col">{copy.activity}</th>
                <th scope="col">{copy.details}</th><th scope="col">{copy.credits}</th>
              </tr></thead>
              <tbody>{history.entries.map(entry => <tr key={entry.id}>
                <td><time dateTime={entry.createdAt}>{dates.format(new Date(entry.createdAt))}</time></td>
                <td>{copy.kinds[entry.kind] || entry.kind}</td>
                <td className={styles.historyMeta}>{entryDetails(entry, copy) || '—'}</td>
                <td>{numbers.format(BigInt(entry.amount))}</td>
              </tr>)}</tbody>
            </table> : <p>{copy.noEntries}</p>)}
            {(!history || history.nextBefore) && <button type="button" className={styles.historyButton}
              onClick={loadHistory} disabled={historyLoading}>
              {historyLoading ? copy.loading : history ? copy.more : copy.loadHistory}
            </button>}
          </section> : <p>{copy.freeHistory}</p>}
          {error && <p role="alert">{error}</p>}
        </>}
      </section>
    </div>
  </main>;
}
