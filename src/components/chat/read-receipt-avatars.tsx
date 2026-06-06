"use client";

export function ReadReceiptAvatars({
  readers,
}: {
  readers: { displayName: string; avatarUrl: string | null }[];
}) {
  if (readers.length === 0) return null;
  return (
    <div className="flex justify-end gap-0.5 px-4 pb-0.5">
      {readers.slice(0, 5).map((r, i) => (
        <span
          key={i}
          title={`Seen by ${r.displayName}`}
          className="h-4 w-4 rounded-full bg-muted overflow-hidden ring-1 ring-background"
        >
          {r.avatarUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.avatarUrl} alt="" className="h-full w-full object-cover" />
          )}
        </span>
      ))}
      {readers.length > 5 && (
        <span className="text-[10px] text-muted-foreground">+{readers.length - 5}</span>
      )}
    </div>
  );
}
