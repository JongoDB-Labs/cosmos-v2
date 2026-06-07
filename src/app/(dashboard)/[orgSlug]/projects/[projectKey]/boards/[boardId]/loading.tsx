import { Skeleton } from "@/components/ui/skeleton";

// Board-shaped skeleton: a toolbar row + a horizontal strip of column
// placeholders. Reserving the board layout here (rather than generic rows)
// keeps CLS low while the board view streams in behind the Suspense boundary.
export default function Loading() {
  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-6 w-20" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-8" />
        </div>
      </div>
      <div className="flex flex-1 gap-4 overflow-hidden">
        {[0, 1, 2, 3].map((col) => (
          <div key={col} className="w-72 flex-shrink-0">
            <Skeleton className="mb-3 h-6 w-32" />
            <div className="space-y-3">
              {Array.from({ length: 3 + (col % 2) }).map((_, i) => (
                <Skeleton
                  key={i}
                  className="h-24 w-full rounded-[var(--radius)]"
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
