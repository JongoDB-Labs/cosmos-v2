"use client";
import { MotionConfig } from "framer-motion";

export function CosmosMotionConfig({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
