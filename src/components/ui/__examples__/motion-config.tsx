import { CosmosMotionConfig } from "../motion-config";

export const motionConfigExamples = [
  {
    label: "Provider (honors prefers-reduced-motion)",
    node: (
      <CosmosMotionConfig>
        <p className="text-sm text-[var(--text-muted)]">
          Wraps the app so all framer-motion animations respect the user&apos;s
          reduced-motion setting. No visible chrome of its own.
        </p>
      </CosmosMotionConfig>
    ),
    code: `<CosmosMotionConfig>
  <App />
</CosmosMotionConfig>`,
  },
];
