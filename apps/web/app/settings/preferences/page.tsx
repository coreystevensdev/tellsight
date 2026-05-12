import type { Metadata } from 'next';
import Preferences from './Preferences';

export const metadata: Metadata = {
  title: 'Preferences, Tellsight',
};

export default function PreferencesPage() {
  return <Preferences />;
}
