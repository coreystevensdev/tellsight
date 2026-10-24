import type { Metadata } from 'next';
import CategoryPlans from './CategoryPlans';

export const metadata: Metadata = {
  title: 'Spending plans, Tellsight',
};

export default function PlansPage() {
  return <CategoryPlans />;
}
