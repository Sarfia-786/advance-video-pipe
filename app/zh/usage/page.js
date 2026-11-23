import UsageDashboard from '@/components/UsageDashboard';
import copy from '@/messages/zh/usage.json';

export const metadata = { title: '用量与积分 · Open Generative AI' };

export default function UsagePage() {
  return <UsageDashboard copy={copy} rootPath="/zh" locale="zh-CN" />;
}
