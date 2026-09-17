import type { Metadata } from 'next';
import Account from './Account';

export const metadata: Metadata = {
  title: 'Account, Tellsight',
};

export default function AccountPage() {
  return <Account />;
}
