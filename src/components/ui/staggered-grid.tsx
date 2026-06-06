"use client";
import { Children, isValidElement } from "react";
import { motion as fm } from "framer-motion";
import { staggerChildren } from "@/lib/motion";

export function StaggeredGrid({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const arr = Children.toArray(children);
  return (
    <div className={className}>
      {arr.map((child, i) => (
        <fm.div
          key={isValidElement(child) ? (child.key ?? i) : i}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={staggerChildren(i)}
        >
          {child}
        </fm.div>
      ))}
    </div>
  );
}
