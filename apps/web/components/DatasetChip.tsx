import Link from 'next/link';
import { Database, ChevronRight } from 'lucide-react';

interface DatasetChipProps {
  name: string;
  rowCount: number;
}

export function DatasetChip({ name, rowCount }: DatasetChipProps) {
  return (
    <Link
      href="/settings/datasets"
      className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 py-1 text-xs transition-colors hover:bg-accent"
    >
      <Database className="h-3 w-3 text-muted-foreground" />
      <span className="font-medium text-foreground">{name}</span>
      <span className="text-muted-foreground">· {rowCount} rows</span>
      <ChevronRight className="h-3 w-3 text-muted-foreground" />
    </Link>
  );
}
