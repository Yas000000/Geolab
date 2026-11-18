// A benchmark's prompt rows can come from more than one day (MacuMira's: the
// ISA's 23 prompts on May 12, 2026, 9 prompts added after it on Jun 1, and
// Claude on Oct 19 from the October report). These describe the days other
// than the benchmark's own date, for the notes on the Rankings tab and report.

export interface BenchmarkDateGroup {
  date: Date;
  platform: string | null; // set when the group is all of one platform's rows (Claude), else null
  prompts: number; // distinct prompts in the group
}

interface DatedRow {
  promptText: string;
  platform: string | null;
  measuredOn: Date | null;
}

/** Rows measured on another day than the benchmark's, grouped by day, oldest first. */
export function benchmarkDateGroups(snapshotDate: Date, rows: DatedRow[]): BenchmarkDateGroup[] {
  const byDay = new Map<number, DatedRow[]>();
  for (const r of rows) {
    const t = (r.measuredOn ?? snapshotDate).getTime();
    if (t === snapshotDate.getTime()) continue;
    byDay.set(t, [...(byDay.get(t) ?? []), r]);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, group]) => {
      const platforms = new Set(group.map((r) => r.platform));
      const only = platforms.size === 1 ? [...platforms][0] : null;
      // One platform's whole set (every row it has is on this day) reads as that platform.
      const whole = only != null && rows.filter((r) => r.platform === only).length === group.length;
      return { date: new Date(t), platform: whole ? only : null, prompts: new Set(group.map((r) => r.promptText)).size };
    });
}
