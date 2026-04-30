import type { Metadata } from 'next';
import DatasetManager from './DatasetManager';

export const metadata: Metadata = {
  title: 'Datasets, Tellsight',
};

export default function DatasetsPage() {
  return <DatasetManager />;
}
