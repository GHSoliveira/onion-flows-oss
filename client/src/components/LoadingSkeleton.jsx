export const SkeletonBox = ({ className = '' }) => (
  <div className={`animate-pulse rounded bg-slate-200/80 dark:bg-slate-700/60 ${className}`} />
);

export const PageSkeleton = ({ cards = 6, showTitle = true }) => (
  <div className="p-3 sm:p-4 lg:p-6 space-y-4">
    {showTitle && <SkeletonBox className="h-6 w-48" />}
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: cards }).map((_, index) => (
        <SkeletonBox key={`card_${index}`} className="h-28" />
      ))}
    </div>
  </div>
);

export const TableSkeleton = ({ rows = 6, cols = 4 }) => (
  <div className="p-3 sm:p-4 lg:p-6 animate-pulse space-y-3">
    <div className="h-5 w-40 rounded bg-slate-200 dark:bg-slate-700" />
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, row) => (
        <div
          key={`row_${row}`}
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: cols }).map((__, col) => (
            <div
              key={`cell_${row}_${col}`}
              className="h-4 rounded bg-slate-200/80 dark:bg-slate-700/60"
            />
          ))}
        </div>
      ))}
    </div>
  </div>
);

export const CenterSkeleton = () => (
  <div className="flex justify-center items-center h-full p-6">
    <div className="w-full max-w-md space-y-3 animate-pulse">
      <div className="h-4 w-32 rounded bg-slate-200 dark:bg-slate-700" />
      <div className="h-4 w-full rounded bg-slate-200/80 dark:bg-slate-700/60" />
      <div className="h-4 w-5/6 rounded bg-slate-200/80 dark:bg-slate-700/60" />
      <div className="h-4 w-2/3 rounded bg-slate-200/80 dark:bg-slate-700/60" />
    </div>
  </div>
);
