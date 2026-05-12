import type { Metadata } from 'next';
import Integrations from './Integrations';

export const metadata: Metadata = {
  title: 'Integrations, Tellsight',
};

export default function IntegrationsPage() {
  return <Integrations />;
}
