import AccountPortal from '@/components/AccountPortal';
import copy from '@/messages/en/accounts.json';

export const metadata = { title: 'Platform account · Open Generative AI' };

export default function AccountPage() {
  return <AccountPortal mode="login" copy={copy} rootPath="" />;
}
