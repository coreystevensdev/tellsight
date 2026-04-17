import type { Metadata } from 'next';
import IntegrationsManager from './IntegrationsManager';

export const metadata: Metadata = {
  title: 'Integrations — Tellsight',
};

export default function IntegrationsPage() {
  return <IntegrationsManager />;
}
