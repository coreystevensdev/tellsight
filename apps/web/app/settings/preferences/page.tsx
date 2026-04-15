import type { Metadata } from 'next';
import PreferencesManager from './PreferencesManager';

export const metadata: Metadata = {
  title: 'Preferences — Tellsight',
};

export default function PreferencesPage() {
  return <PreferencesManager />;
}
