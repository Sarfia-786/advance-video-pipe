import UsageDashboard from '@/components/UsageDashboard';
import copy from '@/messages/en/usage.json';

export const metadata = { title: 'Usage and credits · Open Generative AI' };

export default function UsagePage() {
  return <UsageDashboard copy={copy} rootPath="" locale="en" />;
}
