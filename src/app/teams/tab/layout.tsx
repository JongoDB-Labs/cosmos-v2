/** COSMOS-202 T1 d: Teams tabs render bare, inside Teams' own frame. */
export default function TeamsTabLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-background text-foreground">{children}</div>;
}
