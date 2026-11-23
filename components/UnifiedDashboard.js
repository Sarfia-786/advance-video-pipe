'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { getDashboardNavigation } from '@/lib/platform/dashboard/navigation.mjs';

export default function UnifiedDashboard({ locale = 'en', copy }) {
  const { root, primary, actions } = getDashboardNavigation(locale);
  const [account, setAccount] = useState({ status: 'loading', data: null });

  const loadAccount = useCallback(async signal => {
    setAccount({ status: 'loading', data: null });
    try {
      const response = await fetch('/api/platform/v1/me', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      });
      if (response.status === 401) {
        setAccount({ status: 'signedOut', data: null });
        return;
      }
      if (!response.ok) throw new Error('Profile request failed');
      const data = await response.json();
      if (!data?.user || typeof data.plan !== 'string' || data.creditBalance == null) {
        throw new Error('Incomplete account response');
      }
      setAccount({ status: 'ready', data });
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setAccount({ status: 'error', data: null });
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadAccount(controller.signal);
    return () => controller.abort();
  }, [loadAccount]);

  return (
    <main className="min-h-screen bg-[#080a10] px-4 py-8 text-white sm:px-8 lg:px-12">
      <div className="mx-auto max-w-6xl space-y-10">
        <header className="space-y-3">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{copy.title}</h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-300">{copy.subtitle}</p>
          <nav aria-label={copy.navigation} className="flex flex-wrap gap-2 pt-2">
            {primary.map(item => (
              <Link
                key={item.id}
                href={item.href}
                aria-current={item.id === 'dashboard' ? 'page' : undefined}
                className="rounded-lg border border-white/20 px-3 py-2 text-sm text-slate-100 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
              >
                {copy.primary[item.id]}
              </Link>
            ))}
          </nav>
        </header>

        <section aria-labelledby="quick-actions-title" className="space-y-4">
          <h2 id="quick-actions-title" className="text-xl font-semibold">{copy.quickActions}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {actions.map(action => {
              const item = copy.actions[action.id];
              const content = (
                <>
                  <h3 className="font-semibold">{item.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-300">{item.description}</p>
                  <span className="mt-4 block text-xs font-semibold uppercase tracking-wide text-cyan-300">
                    {action.href ? copy.open : copy.soon}
                  </span>
                </>
              );
              const style = 'block rounded-xl border border-white/15 bg-white/[0.04] p-5';
              return action.href ? (
                <Link
                  key={action.id}
                  href={action.href}
                  aria-label={item.title}
                  className={style + ' transition-colors hover:border-cyan-400/60 hover:bg-white/[0.08] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300'}
                >
                  {content}
                </Link>
              ) : (
                <div key={action.id} aria-disabled="true" className={style + ' opacity-65'}>
                  {content}
                </div>
              );
            })}
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <section aria-labelledby="account-overview-title" className="rounded-xl border border-white/15 bg-white/[0.04] p-6">
            <h2 id="account-overview-title" className="text-xl font-semibold">{copy.overview}</h2>
            {account.status === 'loading' && <p role="status" className="mt-4 text-slate-300">{copy.loading}</p>}
            {account.status === 'signedOut' && (
              <div className="mt-4 space-y-3">
                <p className="text-slate-300">{copy.signedOut}</p>
                <Link className="inline-block text-cyan-300 underline" href={root + '/login'}>{copy.signIn}</Link>
              </div>
            )}
            {account.status === 'error' && (
              <div className="mt-4 space-y-3">
                <p role="alert" className="text-slate-300">{copy.failed}</p>
                <button type="button" onClick={() => loadAccount()} className="rounded-lg border border-white/30 px-3 py-2 text-sm hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">
                  {copy.retry}
                </button>
              </div>
            )}
            {account.status === 'ready' && (
              <div className="mt-4 space-y-4">
                <p className="font-medium">{account.data.user.name || account.data.user.email}</p>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div><dt className="text-sm text-slate-300">{copy.plan}</dt><dd className="text-lg font-semibold">{copy.plans[account.data.plan] || account.data.plan}</dd></div>
                  <div><dt className="text-sm text-slate-300">{copy.credits}</dt><dd className="text-lg font-semibold">{String(account.data.creditBalance)}</dd></div>
                </dl>
                <Link className="inline-block text-cyan-300 underline" href={root + '/account'}>{copy.account}</Link>
              </div>
            )}
          </section>
          <section aria-labelledby="projects-title" className="rounded-xl border border-white/15 bg-white/[0.04] p-6">
            <h2 id="projects-title" className="text-xl font-semibold">{copy.projects}</h2>
            <p className="mt-4 text-sm leading-6 text-slate-300">{copy.projectsPending}</p>
          </section>
        </div>
      </div>
    </main>
  );
}
