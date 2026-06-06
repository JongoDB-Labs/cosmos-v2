"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="system"
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--overlay)",
          "--normal-text": "var(--text)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          "--success-bg": "var(--overlay)",
          "--success-border": "var(--status-done)",
          "--success-text": "var(--status-done)",
          "--error-bg": "var(--overlay)",
          "--error-border": "var(--status-critical)",
          "--error-text": "var(--status-critical)",
          "--info-bg": "var(--overlay)",
          "--info-border": "var(--status-progress)",
          "--info-text": "var(--status-progress)",
          "--warning-bg": "var(--overlay)",
          "--warning-border": "var(--status-blocked)",
          "--warning-text": "var(--status-blocked)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
