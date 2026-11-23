// Dashboard links are a single source of truth for all localized entry points.
// Do not link an action to an unrelated studio while its workflow is unfinished.
const PRIMARY = Object.freeze([
  { id: 'dashboard', path: '/dashboard' },
  { id: 'studio', path: '/studio' },
  { id: 'captions', path: '/captions' },
  { id: 'account', path: '/account' },
]);

const ACTIONS = Object.freeze([
  { id: 'short', path: null, dependsOn: 18 },
  { id: 'image', path: '/studio/image' },
  { id: 'video', path: '/studio/video' },
  { id: 'script', path: '/studio/agents' },
  { id: 'workflow', path: '/studio/workflows' },
  { id: 'voice', path: '/studio/audio' },
  { id: 'thumbnail', path: '/studio/design-agent' },
]);

export function getDashboardNavigation(locale = 'en') {
  const root = locale === 'zh' ? '/zh' : '';
  return {
    root,
    primary: PRIMARY.map(item => ({ ...item, href: root + item.path })),
    actions: ACTIONS.map(item => ({
      ...item,
      href: item.path === null ? null : root + item.path,
    })),
  };
}
