import UnifiedDashboard from '@/components/UnifiedDashboard';
import copy from '@/messages/en/dashboard.json';

export const metadata = { title: 'Dashboard · Open Generative AI' };

export default function DashboardPage() {
  return <UnifiedDashboard locale="en" copy={copy} />;
}
