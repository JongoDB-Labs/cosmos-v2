import type { Variants, Transition } from "framer-motion";

export const motion = {
  snap: { duration: 0.15, ease: [0.4, 0, 0.2, 1] satisfies Transition["ease"] },
  smooth: { duration: 0.24, ease: [0.4, 0, 0.2, 1] satisfies Transition["ease"] },
  spring: { type: "spring", stiffness: 260, damping: 28 } as const,
  linger: { duration: 0.42, ease: [0.16, 1, 0.3, 1] satisfies Transition["ease"] },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: motion.smooth },
};

export const slideUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: motion.smooth },
};

export const stagger = {
  maxStaggered: 6,
  delay: 0.04,
};

export function staggerChildren(index: number): Transition {
  const capped = Math.max(0, Math.min(index, stagger.maxStaggered));
  return { ...motion.smooth, delay: capped * stagger.delay };
}
