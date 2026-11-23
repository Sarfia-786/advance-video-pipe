import AccountPortal from '@/components/AccountPortal';
import copy from '@/messages/zh/accounts.json';

export const metadata = { title: '平台账户 · Open Generative AI' };

export default function AccountPage() {
  return <AccountPortal mode="reset" copy={copy} rootPath="/zh" />;
}
