import type { Metadata } from 'next';
import Datasets from './Datasets';

export const metadata: Metadata = {
  title: 'Datasets, Tellsight',
};

export default function DatasetsPage() {
  return <Datasets />;
}
