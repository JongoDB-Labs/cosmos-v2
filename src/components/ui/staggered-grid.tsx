"use client";
import { Children, isValidElement } from "react";
import { motion as fm, useReducedMotion } from "framer-motion";
import { staggerChildren } from "@/lib/motion";

export function StaggeredGrid({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  // Honor "reduce motion": snap each child to its final state with no entrance
  // tween. framer's app-wide `reducedMotion="user"` (see CosmosMotionConfig) only
  // stops TRANSFORM/LAYOUT animations — it deliberately keeps opacity/color fades
  // — so this `opacity: 0 -> 1` fade would otherwise still run for users who ask
  // for no motion. It also made a11y contrast scans (which emulate reduce) catch
  // text mid-fade at partial opacity, a transient that isn't a real settled
  // violation. We keep `initial` identical on server and client (avoids a
  // hydration mismatch) and instead zero the transition duration when reduced.
  const reduced = useReducedMotion();
  const arr = Children.toArray(children);
  return (
    <div className={className}>
      {arr.map((child, i) => (
        <fm.div
          key={isValidElement(child) ? (child.key ?? i) : i}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduced ? { duration: 0 } : staggerChildren(i)}
        >
          {child}
        </fm.div>
      ))}
    </div>
  );
}
