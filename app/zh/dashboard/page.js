import UnifiedDashboard from '@/components/UnifiedDashboard';
import copy from '@/messages/zh/dashboard.json';

export const metadata = { title: '工作台 · Open Generative AI' };

export default function DashboardPage() {
  return <UnifiedDashboard locale="zh" copy={copy} />;
}
