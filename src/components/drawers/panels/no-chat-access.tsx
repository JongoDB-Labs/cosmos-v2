import { MessagesSquare } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * The Chat drawer for someone who may not use chat (no CHAT_USE, which every
 * chat route requires): what is true, instead of a load error that blames
 * their connection.
 */
export function NoChatAccess() {
  return (
    <EmptyState
      icon={MessagesSquare}
      title="You don't have access to chat"
      description="Your role in this organization doesn't include chat. An admin can change that."
    />
  );
}
