import type { Metadata } from 'next';
import FinancialsForm from './FinancialsForm';

export const metadata: Metadata = {
  title: 'Financial baseline, Tellsight',
};

export default function FinancialsPage() {
  return <FinancialsForm />;
}
